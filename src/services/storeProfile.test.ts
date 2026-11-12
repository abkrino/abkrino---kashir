import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { snapshotService } from './snapshotService';
import { PrintableInvoice } from '../components/common/PrintableInvoice';
import { StoreProfile, DEFAULT_STORE_PROFILE, LEGACY_STORE_PROFILE, SalesInvoice } from '../types';

// Mock localStorage for node test environment
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

const sampleInvoice: SalesInvoice = {
  id: 'INV-TEST-001',
  invoiceNumber: 'INV-1001',
  date: '2026-11-12',
  time: '12:00:00',
  customerId: 'c-cash',
  customerName: 'عميل نقدي',
  salespersonId: 'usr-1',
  salespersonName: 'كاشير رئيسي',
  items: [
    {
      id: 'item-1',
      productId: 'p1',
      productCode: 'P001',
      productName: 'أرز بسمتي فاخر',
      quantity: 2,
      piecesCount: 2,
      unit: 'PIECE',
      unitLabel: 'قطعة',
      unitPrice: 50,
      defaultUnitPrice: 50,
      costPrice: 40,
      totalPrice: 100,
      discount: 0,
      lineProfit: 20,
    },
  ],
  subtotal: 100,
  discountType: 'AMOUNT',
  discountValue: 0,
  discountAmount: 0,
  total: 100,
  paidAmount: 100,
  remainingAmount: 0,
  previousCustomerBalance: 0,
  newCustomerBalance: 0,
  totalCost: 80,
  totalProfit: 20,
  paymentType: 'CASH',
  status: 'POSTED',
};

describe('StoreProfile & Universal Store Customization Tests', () => {
  beforeEach(async () => {
    localStorage.clear();
    await idb.kv.clear();
    await idb.snapshots.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
    vi.restoreAllMocks();
  });

  // 1. التثبيت الجديد يبدأ فارغاً تماماً
  it('التثبيت الجديد يبدأ فارغاً بدون منتجات أو عملاء أو موردين وببيانات محل افتراضية', async () => {
    // Fresh install initializes empty DB
    await storage.init();

    expect(storage.getProducts()).toHaveLength(0);
    expect(storage.getCustomers()).toHaveLength(0);
    expect(storage.getSuppliers()).toHaveLength(0);

    const profile = storage.getStoreProfile();
    expect(profile.name).toBe('اسم المحل');
    expect(profile.modules.dairy).toBe(false);
    expect(profile.modules.weighingScale).toBe(false);
    expect(profile.modules.delivery).toBe(false);

    // Explicit call to loadDemoData imports sample data on demand
    storage.loadDemoData();
    expect(storage.getProducts().length).toBeGreaterThan(0);
    expect(storage.getCustomers().length).toBeGreaterThan(0);
    expect(storage.getSuppliers().length).toBeGreaterThan(0);
  });

  // 2. التثبيت الحالي الذي يمتلك بيانات مسبقة يُنشئ StoreProfile مناسباً ويحتفظ ببياناته
  it('التثبيت الحالي ذو البيانات المسبقة يحتفظ بها ويُنشئ StoreProfile متوافقاً مع موديولات الألبان والميزان مفعلة', async () => {
    // Simulate pre-existing business data
    storage.setItem(STORAGE_KEYS.PRODUCTS, [
      {
        id: 'p-existing-1',
        name: 'جبنة فيتا',
        category: 'dairy',
        price: 45,
        cost: 35,
        stock: 10,
        minStock: 2,
        unit: 'kg',
        barcode: '2001',
      },
    ]);
    storage.setItem(STORAGE_KEYS.CUSTOMERS, [
      { id: 'c-1', name: 'عميل قديم', phone: '0100000000', balance: 0, createdAt: Date.now() },
    ]);

    // Requesting store profile when none exists will auto-create legacy profile
    const profile = storage.getStoreProfile();
    expect(profile.name).toBe(LEGACY_STORE_PROFILE.name);
    expect(profile.modules.dairy).toBe(true);
    expect(profile.modules.weighingScale).toBe(true);
    expect(profile.modules.delivery).toBe(false);
    expect(storage.isStoreProfileReviewed()).toBe(false);

    // Business data remains intact
    expect(storage.getProducts()).toHaveLength(1);
    expect(storage.getCustomers()).toHaveLength(1);

    // Marking as reviewed
    storage.setStoreProfileReviewed(true);
    expect(storage.isStoreProfileReviewed()).toBe(true);
  });

  // 3. التحقق من حفظ بيانات المحل وقيود حجم اللوجو
  it('حفظ وتعديل بيانات المحل والتحقق من قيود حجم الشعار', () => {
    const validProfile: StoreProfile = {
      name: 'سوبر ماركت النور والهدى',
      branchName: 'فرع مدينة نصر',
      phone: '0123456789',
      address: 'شارع عباس العقاد، القاهرة',
      currency: 'EGP',
      taxNumber: '123-456-789',
      receiptHeader: 'أهلاً بكم في سوبر ماركت النور',
      receiptFooter: 'البضاعة المباعة ترد وتستبدل خلال 14 يوماً',
      modules: {
        dairy: false,
        weighingScale: true,
        delivery: true,
      },
    };

    const res = storage.saveStoreProfile(validProfile);
    expect(res.success).toBe(true);

    const saved = storage.getStoreProfile();
    expect(saved.name).toBe('سوبر ماركت النور والهدى');
    expect(saved.branchName).toBe('فرع مدينة نصر');
    expect(saved.modules.dairy).toBe(false);
    expect(saved.modules.weighingScale).toBe(true);
    expect(saved.modules.delivery).toBe(true);

    // Test rejection of oversized logo (>100KB)
    // 100KB is approx 137,000 characters in Base64
    const largeLogoBase64 = 'data:image/png;base64,' + 'A'.repeat(160000);
    const oversizeRes = storage.saveStoreProfile({
      ...validProfile,
      logo: largeLogoBase64,
    });
    expect(oversizeRes.success).toBe(false);
    expect(oversizeRes.error).toContain('100 كيلوبايت');

    // Test empty name rejection
    const emptyNameRes = storage.saveStoreProfile({
      ...validProfile,
      name: '   ',
    });
    expect(emptyNameRes.success).toBe(false);
    expect(emptyNameRes.error).toContain('اسم المحل مطلوب');
  });

  // 4. الفاتورة المطبوعة تعكس بيانات المحل من StoreProfile ديناميكياً
  it('الفاتورة المطبوعة (حراري وA4) تعكس بيانات المحل من StoreProfile بدقة ودون أسماء ثابتة', () => {
    const customProfile: StoreProfile = {
      name: 'محمص ومطحنة البركة',
      branchName: 'الفرع الرئيسي',
      phone: '01122334455',
      address: 'ميدان التحرير، القاهرة',
      currency: 'EGP',
      taxNumber: '999-888-777',
      receiptHeader: 'أطيب البن والمكسرات الطازجة',
      receiptFooter: 'نشكركم على زيارتكم ونتمنى لكم يوماً سعيداً',
      modules: {
        dairy: false,
        weighingScale: true,
        delivery: false,
      },
    };
    storage.saveStoreProfile(customProfile);

    // Render invoice dialog (containing thermal receipt view)
    const invoiceHtml = renderToStaticMarkup(
      React.createElement(PrintableInvoice, {
        invoice: sampleInvoice,
        onClose: () => {},
      })
    );

    // Verify dynamic store data in printable format
    expect(invoiceHtml).toContain('محمص ومطحنة البركة');
    expect(invoiceHtml).toContain('الفرع الرئيسي');
    expect(invoiceHtml).toContain('01122334455');
    expect(invoiceHtml).toContain('ميدان التحرير، القاهرة');
    expect(invoiceHtml).toContain('999-888-777');
    expect(invoiceHtml).toContain('أطيب البن والمكسرات الطازجة');
    expect(invoiceHtml).toContain('نشكركم على زيارتكم ونتمنى لكم يوماً سعيداً');

    // Make sure old hardcoded names do NOT appear
    expect(invoiceHtml).not.toContain('الخير والبركة');
    expect(invoiceHtml).not.toContain('ماركت الألبان');
  });

  // 5. استعادة نسخة احتياطية قديمة بدون StoreProfile تنجح وتستخدم الافتراضي
  it('استعادة نسخة احتياطية قديمة بدون StoreProfile تنجح وتستخدم البيانات الافتراضية بسلاسة', async () => {
    await storage.init();

    // Prepare a legacy backup object containing all 12 collections with NO storeProfile property
    const legacyBackup = {
      version: '1.0.0',
      timestamp: Date.now(),
      recordCounts: {
        products: 1,
        customers: 1,
        suppliers: 1,
        invoices: 1,
        purchases: 0,
        cashMovements: 0,
        expenses: 0,
        auditLogs: 0,
        stockAdjustments: 0,
        users: 0,
        parkedCarts: 0,
      },
      data: {
        products: [
          {
            id: 'prod-old',
            name: 'منتج قديم',
            price: 15,
            cost: 10,
            stock: 20,
            minStock: 5,
            category: 'general',
            unit: 'piece',
          },
        ],
        customers: [{ id: 'cust-old', name: 'عميل قديم', phone: '0100', balance: 0, createdAt: Date.now() }],
        suppliers: [{ id: 'supp-old', name: 'مورد قديم', phone: '0111', balance: 0 }],
        invoices: [sampleInvoice],
        purchases: [],
        cashMovements: [],
        expenses: [],
        auditLogs: [],
        stockAdjustments: [],
        users: [],
        parkedCarts: [],
        currentShift: null,
        // storeProfile is deliberately omitted to simulate legacy backup
      },
    };

    const restoreResult = await snapshotService.restoreData(legacyBackup);
    expect(restoreResult.success).toBe(true);

    // The products and data are restored
    expect(storage.getProducts()).toHaveLength(1);
    expect(storage.getProducts()[0].name).toBe('منتج قديم');

    // The store profile has fallen back to a valid profile with name and modules
    const restoredProfile = storage.getStoreProfile();
    expect(restoredProfile).toBeDefined();
    expect(restoredProfile.name).toBeTruthy();
    expect(typeof restoredProfile.modules.dairy).toBe('boolean');
    expect(typeof restoredProfile.modules.weighingScale).toBe('boolean');
    expect(typeof restoredProfile.modules.delivery).toBe('boolean');
  });

  // 6. استعادة نسخة حديثة تحتوي StoreProfile مخصص تستعيده كما هو
  it('استعادة نسخة حديثة تحتوي StoreProfile مخصص تستعيد بيانات المحل بنجاح', async () => {
    await storage.init();

    const customProfile: StoreProfile = {
      name: 'هايبر ماركت الأندلس',
      branchName: 'فرع المعادي',
      phone: '01099887766',
      address: 'كورنيش النيل، المعادي',
      currency: 'EGP',
      taxNumber: '111-222-333',
      receiptHeader: 'أكبر تشكيلة بأفضل الأسعار',
      receiptFooter: 'شكراً لتعاملكم مع هايبر ماركت الأندلس',
      modules: {
        dairy: true,
        weighingScale: true,
        delivery: true,
      },
    };

    const modernBackup = {
      version: '1.0.0',
      timestamp: Date.now(),
      recordCounts: {
        products: 1,
        customers: 0,
        suppliers: 0,
        invoices: 0,
        purchases: 0,
        cashMovements: 0,
        expenses: 0,
        auditLogs: 0,
        stockAdjustments: 0,
        users: 0,
        parkedCarts: 0,
      },
      data: {
        products: [
          {
            id: 'prod-new',
            name: 'تفاح أحمر',
            price: 60,
            cost: 45,
            stock: 50,
            minStock: 10,
            category: 'fruits',
            unit: 'kg',
          },
        ],
        customers: [],
        suppliers: [],
        invoices: [],
        purchases: [],
        cashMovements: [],
        expenses: [],
        auditLogs: [],
        stockAdjustments: [],
        users: [],
        parkedCarts: [],
        currentShift: null,
        storeProfile: customProfile,
      },
    };

    const restoreResult = await snapshotService.restoreData(modernBackup);
    expect(restoreResult.success).toBe(true);

    const activeProfile = storage.getStoreProfile();
    expect(activeProfile.name).toBe('هايبر ماركت الأندلس');
    expect(activeProfile.branchName).toBe('فرع المعادي');
    expect(activeProfile.modules.delivery).toBe(true);
  });
});
