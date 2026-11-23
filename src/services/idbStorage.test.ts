import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS, BUSINESS_KEYS } from './storageService';
import { Product, Customer } from '../types';

// In-memory localStorage mock for node test environment
const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
  });
}

describe('IndexedDB Storage Layer & Migration (idbStore + storageService)', () => {
  beforeEach(async () => {
    // These suites verify storage behavior, not subscription enforcement.
    // Keep license policy isolated so an expired/missing test token cannot block fixture writes.
    vi.spyOn(storage, 'assertWriteAllowed').mockReturnValue({ allowed: true });
    localStorage.clear();
    await idb.kv.clear();
    // Reset storageService internal state
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).writeError = null;
    (storage as any).migrationWarning = null;
    (storage as any).isFallback = false;
    (storage as any).isReady = false;
  });

  afterEach(async () => {
    await idb.kv.clear();
    vi.restoreAllMocks();
  });

  // 1. الترحيل لمرة واحدة: نسخ البيانات والتحقق من تطابق العدد، وتسجيل idb_migrated_at، وعدم حذف localStorage
  it('(1) الترحيل لمرة واحدة: ينسخ البيانات ويتحقق من تطابق العدد، ويسجل تاريخ الترحيل ولا يحذف localStorage قبل 30 يوماً', async () => {
    const sampleProducts: Product[] = [
      { id: 'p-1', name: 'جبنة فيتا', category: 'dairy', salePrice: 45, purchaseCost: 35, stock: 10, unit: 'علبة' } as unknown as Product,
      { id: 'p-2', name: 'حليب كامل الدسم', category: 'dairy', salePrice: 38, purchaseCost: 30, stock: 25, unit: 'لتر' } as unknown as Product,
      { id: 'p-3', name: 'أرز بسمتي', category: 'grocery', salePrice: 70, purchaseCost: 55, stock: 50, unit: 'كجم' } as unknown as Product,
    ];
    const sampleCustomers: Customer[] = [
      { id: 'c-1', name: 'عميل تجريبي 1', phone: '01012345678', balance: 150 } as unknown as Customer,
      { id: 'c-2', name: 'عميل تجريبي 2', phone: '01087654321', balance: 0 } as unknown as Customer,
    ];

    // Seed localStorage with legacy business data
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(sampleProducts));
    localStorage.setItem(STORAGE_KEYS.CUSTOMERS, JSON.stringify(sampleCustomers));

    // Ensure IDB is empty before init
    expect(await idb.kv.count()).toBe(0);

    // Run storage.init()
    await storage.init();

    // 1. Verify IndexedDB now holds the records
    const idbProducts = await idb.kv.get(STORAGE_KEYS.PRODUCTS);
    expect(idbProducts).toBeDefined();
    expect(idbProducts?.value.length).toBe(3);

    const idbCustomers = await idb.kv.get(STORAGE_KEYS.CUSTOMERS);
    expect(idbCustomers).toBeDefined();
    expect(idbCustomers?.value.length).toBe(2);

    // 2. Verify in-memory synchronous reading returns migrated records
    expect(storage.getProducts().length).toBe(3);
    expect(storage.getCustomers().length).toBe(2);
    expect(storage.isStorageFallback()).toBe(false);

    // 3. Verify idb_migrated_at timestamp was recorded in localStorage
    const migratedAt = localStorage.getItem('idb_migrated_at');
    expect(migratedAt).not.toBeNull();
    expect(Number(migratedAt)).toBeGreaterThan(0);

    // 4. Verify old localStorage business copy is PRESERVED (not deleted before 30 days)
    expect(localStorage.getItem(STORAGE_KEYS.PRODUCTS)).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.CUSTOMERS)).not.toBeNull();
  });

  // 2. استمرار العمل بعد إعادة التحميل: إعادة إنشاء الذاكرة من IndexedDB مباشرة
  it('(2) التطبيق يعمل بعد إعادة التحميل ويُعيد بناء الذاكرة من IndexedDB مباشرة', async () => {
    // Populate IndexedDB with verified state
    const products: Product[] = [
      { id: 'p-idb-1', name: 'زبادي بلدي', category: 'dairy', salePrice: 12, purchaseCost: 8, stock: 30, unit: 'علبة' } as unknown as Product,
    ];
    await idb.kv.put({
      key: STORAGE_KEYS.PRODUCTS,
      value: products,
      updatedAt: Date.now(),
    });

    // Make sure localStorage is completely empty to prove loading comes from IndexedDB
    localStorage.clear();

    // Re-initialize storage layer
    await storage.init();

    // Verify products are loaded into in-memory cache directly from IDB
    const loadedProducts = storage.getProducts();
    expect(loadedProducts.length).toBe(1);
    expect(loadedProducts[0].name).toBe('زبادي بلدي');
    expect(storage.isStorageFallback()).toBe(false);

    // Add a new product synchronously
    const newProduct: Product = {
      id: 'p-idb-2',
      name: 'جبنة قريش',
      category: 'dairy',
      salePrice: 60,
      purchaseCost: 45,
      stock: 15,
      stockPieces: 15,
      unit: 'كجم',
    } as unknown as Product;
    storage.saveProduct(newProduct);

    // Verify it is immediately available in synchronous memory
    expect(storage.getProducts().length).toBe(2);

    // Flush to IDB and verify persisted in IDB
    await storage.flush();
    const persisted = await idb.kv.get(STORAGE_KEYS.PRODUCTS);
    expect(persisted?.value.length).toBe(2);
    expect(persisted?.value.some((p: Product) => p.id === 'p-idb-2')).toBe(true);
  });

  // 3. فشل التحقق من التطابق لا يعتمد IndexedDB ويكمل على localStorage مع تحذير
  it('(3) فشل التحقق من تطابق النقل لا يعتمد IndexedDB ويكمل على localStorage مع تحذير ظاهر', async () => {
    const originalProducts: Product[] = [
      { id: 'p-1', name: 'عسل نحل', category: 'grocery', salePrice: 120, purchaseCost: 90, stock: 10, unit: 'برطمان' } as unknown as Product,
      { id: 'p-2', name: 'طحينة بيضاء', category: 'grocery', salePrice: 85, purchaseCost: 65, stock: 8, unit: 'كجم' } as unknown as Product,
    ];

    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(originalProducts));

    // Simulate verification mismatch by intercepting bulkPut or mutating IDB immediately
    const originalBulkPut = idb.kv.bulkPut.bind(idb.kv);
    (vi.spyOn(idb.kv, 'bulkPut') as any).mockImplementation(async (records: any) => {
      // Intentionally truncate one record to trigger count mismatch in verification
      const corrupted = records.map((r: any) => {
        if (r.key === STORAGE_KEYS.PRODUCTS) {
          return { ...r, value: [r.value[0]] }; // only 1 product instead of 2!
        }
        return r;
      });
      return originalBulkPut(corrupted);
    });

    // Run init
    await storage.init();

    // Verify fallback mode is active
    expect(storage.isStorageFallback()).toBe(true);
    expect(storage.getMigrationWarning()).toContain('فشل التحقق من تطابق نقل البيانات');

    // Data must be read from localStorage (all 2 products, not corrupted 1 from IDB)
    expect(storage.getProducts().length).toBe(2);
  });

  // 4. storage.flush() ينتظر انتهاء كل الكتابات المعلّقة
  it('(4) storage.flush() ينتظر انتهاء كل الكتابات المعلّقة في الدفعة', async () => {
    await storage.init();

    // Make rapid changes
    const productA: Product = { id: 'p-fast-1', name: 'صنف أ', category: 'grocery', salePrice: 20, purchaseCost: 15, stock: 5, stockPieces: 5, unit: 'قطعة' } as unknown as Product;
    const productB: Product = { id: 'p-fast-2', name: 'صنف ب', category: 'grocery', salePrice: 30, purchaseCost: 22, stock: 8, stockPieces: 8, unit: 'قطعة' } as unknown as Product;

    storage.saveProduct(productA);
    storage.saveProduct(productB);

    // Call flush()
    await storage.flush();

    // After flush completes, verify IDB is fully up-to-date
    const idbRecord = await idb.kv.get(STORAGE_KEYS.PRODUCTS);
    expect(idbRecord).toBeDefined();
    expect(idbRecord?.value.some((p: Product) => p.id === 'p-fast-1')).toBe(true);
    expect(idbRecord?.value.some((p: Product) => p.id === 'p-fast-2')).toBe(true);
  });

  // 5. فشل الكتابة إلى IndexedDB يُظهر التنبيه الأحمر ولا يُخفي الخطأ
  it('(5) فشل الكتابة إلى IndexedDB يطلق تنبيهاً ولا يُخفي الخطأ', async () => {
    await storage.init();

    let errorReported: string | null = null;
    const unsub = storage.onWriteError((err) => {
      errorReported = err;
    });

    // Mock IDB bulkPut to fail (simulate QuotaExceededError)
    vi.spyOn(idb.kv, 'bulkPut').mockRejectedValue(new Error('QuotaExceededError: Database storage limit exceeded'));

    // Perform write
    const testProduct: Product = { id: 'p-err-1', name: 'صنف خطأ', category: 'grocery', salePrice: 10, purchaseCost: 5, stock: 1, stockPieces: 1, unit: 'علبة' } as unknown as Product;
    storage.saveProduct(testProduct);

    // Flush
    await storage.flush();

    // Verify error is registered and notified
    expect(storage.getWriteError()).toContain('QuotaExceededError');
    expect(errorReported).toContain('QuotaExceededError');

    unsub();
  });

  // 6. التصدير والاستعادة وإعادة الضبط تمر عبر الطبقة الجديدة وتستدعي flush
  it('(6) تصدير النسخة الاحتياطية واستعادتها وإعادة الضبط تعمل بسلاسة مع التخزين الجديد', async () => {
    await storage.init();

    // Create a product
    const prod: Product = { id: 'p-export-1', name: 'منتج تصدير', category: 'grocery', salePrice: 50, purchaseCost: 40, stock: 10, stockPieces: 10, unit: 'قطعة' } as unknown as Product;
    storage.saveProduct(prod);
    await storage.flush();

    // Export backup json
    const jsonStr = storage.exportFullBackupJson();
    expect(jsonStr).toContain('منتج تصدير');

    // Reset database
    storage.resetToFactoryDefault();
    await storage.flush();

    // Verify reset
    const afterResetProducts = storage.getProducts();
    expect(afterResetProducts.some(p => p.id === 'p-export-1')).toBe(false);

    // Restore from jsonStr
    const restoreRes = storage.restoreBackupJson(jsonStr);
    expect(restoreRes.success).toBe(true);
    await storage.flush();

    // Verify restored
    const restoredProducts = storage.getProducts();
    expect(restoredProducts.some(p => p.id === 'p-export-1')).toBe(true);
  });

  // 7. إدارة التصنيفات: منع التكرار، تحديث الأصناف عند إعادة التسمية، ومنع حذف التصنيف المستخدم
  it('(7) إدارة التصنيفات تحفظ البيانات وتحمي الأصناف المرتبطة', async () => {
    await storage.init();

    expect(storage.addCategory('تصنيف تجريبي').success).toBe(true);
    expect(storage.addCategory(' تصنيف تجريبي ').success).toBe(false);

    const product = {
      id: 'p-category-1',
      name: 'صنف اختبار التصنيف',
      category: 'تصنيف تجريبي',
      stockPieces: 3,
    } as unknown as Product;
    expect(storage.saveProduct(product).success).toBe(true);

    expect(storage.renameCategory('تصنيف تجريبي', 'تصنيف معدل').success).toBe(true);
    expect(storage.getProducts().find(p => p.id === product.id)?.category).toBe('تصنيف معدل');

    const blockedDelete = storage.deleteCategory('تصنيف معدل');
    expect(blockedDelete.success).toBe(false);
    expect(blockedDelete.error).toContain('مرتبط');

    expect(storage.saveProduct({ ...product, category: 'أخرى' }).success).toBe(true);
    expect(storage.deleteCategory('تصنيف معدل').success).toBe(true);
    expect(storage.getCategories()).not.toContain('تصنيف معدل');
    await storage.flush();
  });

  // 8. التصنيفات جزء من النسخة الاحتياطية وتعود بعد الاستعادة
  it('(8) النسخة الاحتياطية تحفظ التصنيفات وتستعيدها', async () => {
    await storage.init();
    expect(storage.addCategory('تصنيف النسخة الاحتياطية').success).toBe(true);
    const backup = storage.exportFullBackupJson();
    const parsed = JSON.parse(backup);
    expect(parsed.data.categories).toContain('تصنيف النسخة الاحتياطية');

    storage.resetToFactoryDefault();
    await storage.flush();
    const restored = storage.restoreBackupJson(backup);
    expect(restored.success).toBe(true);
    await storage.flush();
    expect(storage.getCategories()).toContain('تصنيف النسخة الاحتياطية');
  });
});
