import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { snapshotService, CURRENT_SCHEMA_VERSION } from './snapshotService';
import { Product } from '../types';

// Mock localStorage for node environment
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

describe('Local Snapshots, SHA-256 Checksum, Restore Safety & Bootstrap Idempotence', () => {
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
    await storage.init();
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
    vi.restoreAllMocks();
  });

  // 1. اللقطة اليومية تُنشأ مرة واحدة فقط في اليوم
  it('(1) اللقطة اليومية تُنشأ مرة واحدة فقط في اليوم ولا تتكرر عند إعادة الطلب', async () => {
    expect(await idb.snapshots.count()).toBe(0);

    // First check & create daily snapshot
    const snap1 = await snapshotService.checkAndCreateDailySnapshot();
    expect(snap1).not.toBeNull();
    expect(snap1?.type).toBe('daily');
    expect(await idb.snapshots.count()).toBe(1);

    // Second check & create on the same day must NOT duplicate
    const snap2 = await snapshotService.checkAndCreateDailySnapshot();
    expect(snap2).not.toBeNull();
    expect(snap2?.id).toBe(snap1?.id);
    expect(await idb.snapshots.count()).toBe(1);
  });

  // 2. الاحتفاظ بآخر 7 لقطات وحذف الأقدم تلقائياً
  it('(2) الاحتفاظ بآخر 7 لقطات فقط ويتم حذف اللقطات الأقدم تلقائياً', async () => {
    expect(await idb.snapshots.count()).toBe(0);

    // Create 10 snapshots with increasing timestamps
    for (let i = 1; i <= 10; i++) {
      const ts = 1700000000000 + i * 1000;
      await idb.snapshots.put({
        id: `snap_test_${i}`,
        dateStr: `2026-11-${String(i).padStart(2, '0')}`,
        type: 'manual',
        status: 'healthy',
        timestamp: ts,
        data: { products: [{ id: `p-${i}`, name: `صنف ${i}` }] },
        metadata: {
          approxSizeBytes: 500,
          recordCounts: {
            products: 1,
            invoices: 0,
            customers: 0,
            suppliers: 0,
            purchases: 0,
            cashMovements: 0,
            expenses: 0,
            users: 1,
          },
          schemaVersion: CURRENT_SCHEMA_VERSION,
          appVersion: '1.0.0',
          checksum: 'fake-checksum',
        },
      });
      // Prune after each write
      await snapshotService.pruneOldSnapshots(7);
    }

    const remaining = await idb.snapshots.orderBy('timestamp').toArray();
    expect(remaining.length).toBe(7);

    // Oldest snapshots (snap_test_1, snap_test_2, snap_test_3) were pruned
    const ids = remaining.map(s => s.id);
    expect(ids).not.toContain('snap_test_1');
    expect(ids).not.toContain('snap_test_2');
    expect(ids).not.toContain('snap_test_3');
    // Newest 7 remain (4 to 10)
    expect(ids).toEqual([
      'snap_test_4',
      'snap_test_5',
      'snap_test_6',
      'snap_test_7',
      'snap_test_8',
      'snap_test_9',
      'snap_test_10',
    ]);
  });

  // 3. التحقق من Checksum (صحيح يمر وفاسد يُرفض)
  it('(3) التوقيع الرقمي SHA-256 الصحيح يمر، والتالف/المعدل يرفض مع سبب واضح', async () => {
    // Generate valid export package
    const pkg = await snapshotService.generateExportPackage();
    expect(pkg.checksum).toBeDefined();
    expect(pkg.checksum.length).toBe(64); // SHA-256 hex string

    // 1. Valid package passes
    const validResult = await snapshotService.validateBackup(pkg);
    expect(validResult.valid).toBe(true);
    expect(validResult.preview?.hasChecksum).toBe(true);
    expect(validResult.preview?.counts.products).toBe(pkg.data.products.length);

    // 2. Tampered data fails with SHA-256 error
    const tamperedPkg = JSON.parse(JSON.stringify(pkg));
    tamperedPkg.data.products.push({ id: 'p-tampered', name: 'منتج غير مصرح به' });
    const tamperedResult = await snapshotService.validateBackup(tamperedPkg);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.error).toContain('SHA-256');

    // 3. Tampered checksum string fails
    const badChecksumPkg = JSON.parse(JSON.stringify(pkg));
    badChecksumPkg.checksum = '0000000000000000000000000000000000000000000000000000000000000000';
    const badChecksumResult = await snapshotService.validateBackup(badChecksumPkg);
    expect(badChecksumResult.valid).toBe(false);
    expect(badChecksumResult.error).toContain('SHA-256');

    // 4. Legacy file without checksum is accepted with a visible warning
    const legacyPkg = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      data: {
        products: [{ id: 'p-legacy-1', name: 'لبن بلدي' }],
        customers: [{ id: 'c-legacy-1', name: 'عميل قديم' }],
      },
    };
    const legacyResult = await snapshotService.validateBackup(legacyPkg);
    expect(legacyResult.valid).toBe(true);
    expect(legacyResult.preview?.isLegacy).toBe(true);
    expect(legacyResult.warning).toContain('بدون توقيع رقمي');

    // 5. Truncated recordCounts mismatch fails
    const mismatchPkg = JSON.parse(JSON.stringify(pkg));
    mismatchPkg.recordCounts.products = 9999; // Mismatch with actual length
    const mismatchResult = await snapshotService.validateBackup(mismatchPkg);
    expect(mismatchResult.valid).toBe(false);
    expect(mismatchResult.error).toContain('لا يطابق الفهرس');

    // 6. Newer unsupported schema version fails
    const futureSchemaPkg = JSON.parse(JSON.stringify(pkg));
    futureSchemaPkg.schemaVersion = 999;
    const futureResult = await snapshotService.validateBackup(futureSchemaPkg);
    expect(futureResult.valid).toBe(false);
    expect(futureResult.error).toContain('أحدث من الإصدار المدعوم');
  });

  // 4. الاستعادة تأخذ لقطة "قبل الاستعادة" تلقائياً
  it('(4) الاستعادة تأخذ لقطة أمان تلقائية pre_restore قبل استبدال أي بيانات', async () => {
    // Initial product in database
    const initialProd: Product = {
      id: 'p-before-restore',
      name: 'جبنة براميلي أصلية',
      category: 'dairy',
      salePrice: 120,
      purchaseCost: 95,
      stock: 50,
      unit: 'كجم',
    } as unknown as Product;
    storage.saveProduct(initialProd);
    await storage.flush();

    expect(await idb.snapshots.count()).toBe(0);

    // Restore new payload
    const newPayload = {
      products: [
        { id: 'p-restored-1', name: 'حليب مبستر جهينة', category: 'dairy', salePrice: 40, purchaseCost: 32, stock: 100, unit: 'علبة' },
      ],
      customers: [{ id: 'c-1', name: 'سوبر ماركت الأمانة' }],
      suppliers: [],
      invoices: [],
      purchases: [],
      cashMovements: [],
      expenses: [],
      auditLogs: [],
    };

    const restoreRes = await snapshotService.restoreData(newPayload, 'ملف تجريبي');
    expect(restoreRes.success).toBe(true);

    // Verify a pre_restore snapshot was taken before the overwrite!
    const snapshots = await idb.snapshots.toArray();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].type).toBe('pre_restore');

    // The snapshot data must contain the old product ('جبنة براميلي أصلية')
    const oldProducts = snapshots[0].data.products;
    expect(oldProducts.some((p: any) => p.name === 'جبنة براميلي أصلية')).toBe(true);

    // And storage now holds the restored product
    expect(storage.getProducts().length).toBe(1);
    expect(storage.getProducts()[0].name).toBe('حليب مبستر جهينة');
  });

  // 5. storage.init() و bootstrap idempotent (لا يُنفَّذان مرتين)
  it('(5) storage.init() متطابقة الأثر (Idempotent) وتعيد نفس الـ Promise عند التزامن', async () => {
    // Reset state to simulate fresh startup
    (storage as any).cache.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;

    // Fire 3 simultaneous init calls
    const p1 = storage.init();
    const p2 = storage.init();
    const p3 = storage.init();

    // Verify all 3 in-flight calls share the exact same Promise instance
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    await Promise.all([p1, p2, p3]);
    expect(storage.isStorageReady()).toBe(true);

    // Subsequent call after isReady returns resolved promise immediately
    const pAfter = storage.init();
    await pAfter;
    expect(storage.isStorageReady()).toBe(true);
  });

  // 6. تذكير النسخ الاحتياطي (7 أيام) وقابلية التأجيل
  it('(6) تذكير النسخ الاحتياطي يظهر بعد 7 أيام ويختفي عند التأجيل ليوم واحد', () => {
    localStorage.clear();

    // 1. If exported today -> no reminder
    snapshotService.recordManualExport();
    let status = snapshotService.getReminderStatus();
    expect(status.needsReminder).toBe(false);
    expect(status.daysSinceLastBackup).toBe(0);

    // 2. If exported 8 days ago -> needs reminder
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem('last_manual_backup_export_at', String(eightDaysAgo));
    status = snapshotService.getReminderStatus();
    expect(status.needsReminder).toBe(true);
    expect(status.daysSinceLastBackup).toBe(8);

    // 3. Snooze for 1 day -> reminder suppressed
    snapshotService.snoozeReminderOneDay();
    status = snapshotService.getReminderStatus();
    expect(status.needsReminder).toBe(false);
  });

  // 7. منع إنشاء لقطة تلقائية إذا كانت بيانات العمل فارغة
  it('(7) منع إنشاء لقطة تلقائية (يومية أو إغلاق وردية) إذا كانت بيانات العمل فارغة تماماً', async () => {
    // 1. Direct check: empty business data is disallowed
    const precondition = await snapshotService.checkSnapshotPreconditions({
      products: [],
      invoices: [],
      customers: [],
    });
    expect(precondition.allowed).toBe(false);
    expect(precondition.reason).toBe('empty_data');
    expect(precondition.message).toContain('بيانات العمل فارغة');

    // 2. Mock empty business data in snapshotService
    const spy = vi.spyOn(snapshotService, 'getCurrentBusinessData').mockReturnValue({
      products: [],
      invoices: [],
      customers: [],
      suppliers: [],
      purchases: [],
      cashMovements: [],
      expenses: [],
      users: [],
    });

    expect(await idb.snapshots.count()).toBe(0);

    // Automatic daily snapshot creation must abort and not save
    const snap = await snapshotService.createSnapshot('daily');
    expect(snap).toBeNull();
    expect(await idb.snapshots.count()).toBe(0);

    // checkAndCreateDailySnapshot should also return null
    const daily = await snapshotService.checkAndCreateDailySnapshot();
    expect(daily).toBeNull();
    expect(await idb.snapshots.count()).toBe(0);

    spy.mockRestore();
  });

  // 8. منع اللقطة التلقائية عند انخفاض الأعداد بأكثر من 30% مع إمكانية الإنشاء الإجباري بحالة مشبوهة
  it('(8) منع اللقطة التلقائية عند انخفاض الأعداد > 30% مقارنة بآخر لقطة سليمة، وإنشاؤها إجبارياً بحالة مشبوهة', async () => {
    // Seed initial data: 10 products
    const initialProducts: Product[] = Array.from({ length: 10 }, (_, i) => ({
      id: `p-init-${i}`,
      name: `منتج تجريبي ${i}`,
      category: 'general',
      salePrice: 10,
      purchaseCost: 5,
      stock: 20,
      unit: 'قطعة',
    })) as unknown as Product[];
    storage.setItem(STORAGE_KEYS.PRODUCTS, initialProducts);
    await storage.flush();

    // Take an initial healthy snapshot
    const snapHealthy = await snapshotService.createSnapshot('manual', 'snap_healthy_1', undefined, {
      force: true,
      status: 'healthy',
    });
    expect(snapHealthy).not.toBeNull();
    expect(snapHealthy?.status).toBe('healthy');
    expect(snapHealthy?.metadata.recordCounts.products).toBe(10);

    // Simulate catastrophic drop: products reduced from 10 to 4 (60% drop > 30%)
    storage.setItem(STORAGE_KEYS.PRODUCTS, initialProducts.slice(0, 4));
    await storage.flush();

    // Automatic snapshot attempt should be blocked and trigger dropAlert
    const autoSnap = await snapshotService.createSnapshot('daily');
    expect(autoSnap).toBeNull();
    expect(snapshotService.getDropAlert()).toContain('الأعداد انخفضت مقارنة بآخر لقطة');

    // Forced snapshot with suspicious status succeeds
    const forcedSnap = await snapshotService.createSnapshot('manual', 'snap_forced_1', undefined, {
      force: true,
      status: 'suspicious',
    });
    expect(forcedSnap).not.toBeNull();
    expect(forcedSnap?.status).toBe('suspicious');
    expect(snapshotService.getDropAlert()).toBeNull(); // Alert cleared after deliberate action

    const savedRecord = await idb.snapshots.get('snap_forced_1');
    expect(savedRecord?.status).toBe('suspicious');
  });

  // 9. حماية آخر لقطتين سليمتين (healthy) من الحذف حتى عند تنظيف الفائض
  it('(9) حظر حذف آخر لقطتين بحالة healthy أبداً حتى لو تجاوز إجمالي اللقطات الحد الأقصى', async () => {
    await idb.snapshots.clear();

    // Insert 2 old healthy snapshots
    await idb.snapshots.put({
      id: 'snap_healthy_old_1',
      dateStr: '2026-11-01',
      type: 'manual',
      status: 'healthy',
      timestamp: 1000,
      data: { products: [{ id: 'p-1', name: 'أ' }] },
      metadata: {
        approxSizeBytes: 200,
        recordCounts: { products: 1, invoices: 0, customers: 0, suppliers: 0, purchases: 0, cashMovements: 0, expenses: 0, users: 1 },
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion: '1.0.0',
        checksum: 'c1',
      },
    });

    await idb.snapshots.put({
      id: 'snap_healthy_old_2',
      dateStr: '2026-11-02',
      type: 'manual',
      status: 'healthy',
      timestamp: 2000,
      data: { products: [{ id: 'p-2', name: 'ب' }] },
      metadata: {
        approxSizeBytes: 200,
        recordCounts: { products: 1, invoices: 0, customers: 0, suppliers: 0, purchases: 0, cashMovements: 0, expenses: 0, users: 1 },
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion: '1.0.0',
        checksum: 'c2',
      },
    });

    // Insert 6 newer suspicious snapshots
    for (let i = 3; i <= 8; i++) {
      await idb.snapshots.put({
        id: `snap_suspicious_${i}`,
        dateStr: `2026-11-0${i}`,
        type: 'manual',
        status: 'suspicious',
        timestamp: 2000 + i * 100,
        data: { products: [] },
        metadata: {
          approxSizeBytes: 200,
          recordCounts: { products: 0, invoices: 0, customers: 0, suppliers: 0, purchases: 0, cashMovements: 0, expenses: 0, users: 1 },
          schemaVersion: CURRENT_SCHEMA_VERSION,
          appVersion: '1.0.0',
          checksum: `c_${i}`,
        },
      });
    }

    expect(await idb.snapshots.count()).toBe(8);

    // Prune to 4 snapshots
    await snapshotService.pruneOldSnapshots(4);

    const remaining = await idb.snapshots.toArray();
    expect(remaining.length).toBe(4);

    // CRITICAL: The two healthy snapshots MUST still exist even though they are the oldest!
    const remainingIds = remaining.map(s => s.id);
    expect(remainingIds).toContain('snap_healthy_old_1');
    expect(remainingIds).toContain('snap_healthy_old_2');

    // The oldest suspicious snapshots were deleted instead
    expect(remainingIds).not.toContain('snap_suspicious_3');
    expect(remainingIds).not.toContain('snap_suspicious_4');
  });

  // 10. فحص استهلاك مساحة التخزين وتقليص السجل إلى 3 لقطات عند تجاوز 40%
  it('(10) فحص حصة التخزين: تقليص الاحتفاظ إلى 3 لقطات وإظهار تحذير عند تجاوز 40% من الحصة', async () => {
    await idb.snapshots.clear();

    // Create 6 snapshots
    for (let i = 1; i <= 6; i++) {
      await idb.snapshots.put({
        id: `snap_quota_${i}`,
        dateStr: `2026-11-${String(i).padStart(2, '0')}`,
        type: 'manual',
        status: 'healthy',
        timestamp: 10000 + i * 1000,
        data: { products: [{ id: `p-${i}`, name: `صنف ${i}` }] },
        metadata: {
          approxSizeBytes: 500,
          recordCounts: { products: 1, invoices: 0, customers: 0, suppliers: 0, purchases: 0, cashMovements: 0, expenses: 0, users: 1 },
          schemaVersion: CURRENT_SCHEMA_VERSION,
          appVersion: '1.0.0',
          checksum: `q_${i}`,
        },
      });
    }
    expect(await idb.snapshots.count()).toBe(6);

    // Simulate quota over 40% (usage: 450MB, quota: 1000MB = 45%)
    snapshotService.setQuotaEstimateForTesting({
      usage: 450 * 1024 * 1024,
      quota: 1000 * 1024 * 1024,
    });

    const quotaEval = await snapshotService.evaluateStorageQuota();
    expect(quotaEval.isOverLimit).toBe(true);
    expect(quotaEval.targetKeepCount).toBe(3);
    expect(snapshotService.getQuotaWarning()).toContain('تجاوز 40% من الحصة المتاحة');

    // Prune with quota evaluated count
    await snapshotService.pruneOldSnapshots(quotaEval.targetKeepCount);

    const remaining = await idb.snapshots.toArray();
    expect(remaining.length).toBe(3);

    // Reset quota mock
    snapshotService.setQuotaEstimateForTesting(null);
  });

  // 11. فشل الاستعادة أثناء العملية (transaction) يضمن بقاء البيانات الأصلية دون مساس
  it('(11) فشل الاستعادة في المرحلة الذرية يضمن بقاء البيانات الأصلية في الذاكرة و IndexedDB دون أي مساس', async () => {
    // Current valid original product
    const initialCount = storage.getProducts().length;
    const originalProduct: Product = {
      id: 'p-original-safety',
      name: 'منتج أصلي محفوظ بأمان',
      category: 'safe',
      salePrice: 150,
      purchaseCost: 100,
      stock: 50,
      unit: 'قطعة',
    } as unknown as Product;

    storage.saveProduct(originalProduct);
    await storage.flush();

    expect(storage.getProducts().length).toBe(initialCount + 1);
    expect(storage.getProducts().find(p => p.id === 'p-original-safety')?.name).toBe('منتج أصلي محفوظ بأمان');

    // New corrupted/failed payload
    const newCorruptPayload = {
      products: [
        { id: 'p-bad-1', name: 'بيانات غير مكتملة' },
      ],
      customers: [],
      suppliers: [],
      invoices: [],
      purchases: [],
      cashMovements: [],
      expenses: [],
      auditLogs: [],
    };

    // Attempt restore with simulated failure in the middle of the transaction
    const result = await snapshotService.restoreData(newCorruptPayload, 'اختبار الفشل الذري', {
      simulateFailureInTransaction: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('فشل محاكى');

    // In-memory cache must still hold the original product untouched!
    const productsInMem = storage.getProducts();
    expect(productsInMem.length).toBe(initialCount + 1);
    expect(storage.getProducts().find(p => p.id === 'p-original-safety')?.name).toBe('منتج أصلي محفوظ بأمان');

    // IndexedDB KV store must still hold the original product untouched!
    const kvRecord = await idb.kv.get(STORAGE_KEYS.PRODUCTS);
    expect(kvRecord).toBeDefined();
    expect(kvRecord?.value.some((p: any) => p.name === 'منتج أصلي محفوظ بأمان')).toBe(true);

    // Staging table must be empty or cleaned up
    const stagingRecords = await idb.restore_staging.toArray();
    expect(stagingRecords.length).toBe(0);
  });
});
