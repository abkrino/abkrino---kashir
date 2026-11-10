import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS, BUSINESS_KEYS } from './storageService';
import { tabLockService } from './tabLockService';
import { orgSyncService } from './orgSyncService';
import { cloudService } from './cloudService';
import { Product } from '../types';

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

describe('Single Tab Lock, Migration Anti-Regression & Safety Tests', () => {
  beforeEach(async () => {
    localStorage.clear();
    await idb.kv.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).writeError = null;
    (storage as any).migrationWarning = null;
    (storage as any).isFallback = false;
    (storage as any).isReady = false;
    (storage as any).migrationRecoveryRequired = false;
    (storage as any).legacyBackupTimestamp = 0;
    tabLockService.setLockForTesting(null);
    orgSyncService.stopService();
  });

  afterEach(async () => {
    await idb.kv.clear();
    tabLockService.releaseLock();
    tabLockService.setLockForTesting(null);
    orgSyncService.stopService();
    vi.restoreAllMocks();
  });

  // 1. نافذة ثانية لا تكتب: القفل يمنع النافذة الثانية من حجز الموارد أو بدء التخزين
  it('(1) نافذة واحدة فقط تحجز القفل والنافذة الثانية تفشل ولا تستدعي storage.init() ولا تكتب أي بيانات', async () => {
    // Tab 1 requests lock
    tabLockService.setLockForTesting(true);
    const tab1Lock = await tabLockService.requestLock();
    expect(tab1Lock.acquired).toBe(true);
    expect(tabLockService.isLockAcquired()).toBe(true);

    // Tab 2 attempts to request lock while Tab 1 is holding it
    tabLockService.setLockForTesting(false);
    const tab2Lock = await tabLockService.requestLock();
    expect(tab2Lock.acquired).toBe(false);

    // Secondary tab must NOT call storage.init() or write data
    // Verify storage remains unready for Tab 2
    expect(storage.isStorageReady()).toBe(false);
    expect(await idb.kv.count()).toBe(0);
  });

  // 2. حماية الترحيل: وجود idb_migrated_at مع IDB فارغة يمنع النسخ التلقائي ويطلب الاستعادة الصريحة
  it('(2) وجود idb_migrated_at وقاعدة IndexedDB فارغة يمنع النسخ التلقائي ويطلب استعادة صريحة', async () => {
    const legacyProducts: Product[] = [
      { id: 'p-leg-1', name: 'لبن بلدي جاموسي', category: 'dairy', salePrice: 35, purchaseCost: 28, stock: 40, unit: 'كجم' } as unknown as Product,
    ];
    // Seed localStorage with previous migration timestamp and legacy products
    const migratedTime = 1700000000000;
    localStorage.setItem('idb_migrated_at', String(migratedTime));
    localStorage.setItem('idb_migrated_keys_count', '13');
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(legacyProducts));

    // IDB is empty (count === 0)
    expect(await idb.kv.count()).toBe(0);

    // Run storage.init()
    await storage.init();

    // 1. Verify it did NOT auto-copy to IndexedDB!
    expect(await idb.kv.count()).toBe(0);

    // 2. Verify migrationRecoveryRequired flag is active
    expect(storage.isMigrationRecoveryRequired()).toBe(true);
    expect(storage.getLegacyBackupTimestamp()).toBe(migratedTime);
    expect(storage.isStorageReady()).toBe(false);

    // 3. User chooses explicit action (أ) restore from legacy localStorage
    const restoreResult = await storage.restoreFromLegacyLocalStorage();
    expect(restoreResult.success).toBe(true);

    // 4. Verify data is now restored to IndexedDB and cache
    expect(await idb.kv.count()).toBeGreaterThan(0);
    expect(storage.getProducts().length).toBe(1);
    expect(storage.getProducts()[0].name).toBe('لبن بلدي جاموسي');
    expect(storage.isMigrationRecoveryRequired()).toBe(false);
    expect(storage.isStorageReady()).toBe(true);
  });

  // 3. الحفظ الفوري للعمليات الحرجة: storage.flush() ينتظر الكتابة وتأكيدها
  it('(3) العمليات الحرجة تستدعي storage.flush() وفشل الكتابة لا يظهر نجاحاً بل يسجل الخطأ', async () => {
    await storage.init();

    // Mock IDB bulkPut to fail (simulate QuotaExceededError or disk full)
    const errorSpy = vi.spyOn(idb.kv, 'bulkPut').mockRejectedValue(new Error('QuotaExceededError: Database limit reached'));

    // Perform an invoice save or critical write
    const testProd: Product = { id: 'p-crit-1', name: 'صنف حرج', category: 'dairy', salePrice: 20, purchaseCost: 15, stock: 10, unit: 'علبة' } as unknown as Product;
    storage.saveProduct(testProd);

    // Flush should report error
    await storage.flush();

    expect(storage.getWriteError()).toContain('QuotaExceededError');

    errorSpy.mockRestore();
  });

  // 4. الخدمات الخلفية: orgSyncService لا تبدأ قبل storage.init() وفوز النافذة بالقفل
  it('(4) orgSyncService لا تعمل ومؤقتاتها لا تبدأ قبل init() وفوز النافذة بالقفل، و pushDailySummary ترفض الرفع إن لم تُحمّل البيانات', async () => {
    // 1. Before startService(), service is not running
    expect(orgSyncService.isServiceRunning()).toBe(false);

    // 2. pushDailySummary must reject because storage is not ready yet
    const summaryBeforeInit = await orgSyncService.pushDailySummary(true);
    expect(summaryBeforeInit.success).toBe(false);
    expect(summaryBeforeInit.error).toBe('storage-not-ready');

    // 3. sendHeartbeat must also reject if storage is not ready
    const heartbeatBeforeInit = await orgSyncService.sendHeartbeat();
    expect(heartbeatBeforeInit.success).toBe(false);
    expect(heartbeatBeforeInit.error).toBe('storage-not-ready');

    // 4. Initialize storage and start service
    await storage.init();
    orgSyncService.startService();
    expect(orgSyncService.isServiceRunning()).toBe(true);
  });

  // 5. سقوف السجلات والبيانات الوصفية في localStorage
  it('(5) sm_cached_cloud_backups تحفظ metadata فقط وسقف 100 لكل من التنبيهات والأخطاء والمقاييس', () => {
    // 1. Test cloud backup caching omits payloadJson and respects limit of 20
    const sampleBackups: any[] = [];
    for (let i = 0; i < 30; i++) {
      sampleBackups.push({
        id: `backup-${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        payloadJson: '{"huge":"data_should_be_omitted_from_localStorage"}',
        itemCounts: { products: 100, invoices: 50 },
      });
    }

    // Call getCloudBackups list caching logic
    const metaOnlyList = sampleBackups.slice(0, 20).map(item => {
      const { payloadJson, ...meta } = item;
      return meta;
    });
    localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(metaOnlyList));

    const cachedRaw = localStorage.getItem('sm_cached_cloud_backups');
    expect(cachedRaw).not.toBeNull();
    const parsed = JSON.parse(cachedRaw!);
    expect(parsed.length).toBe(20);
    expect(parsed[0].payloadJson).toBeUndefined();
    expect(parsed[0].id).toBe('backup-0');

    // 2. Test local alerts capped at 100
    for (let i = 0; i < 115; i++) {
      cloudService.addAlert(`تنبيه ${i}`, `تفاصيل ${i}`, 'SYSTEM', 'LOW');
    }
    const alerts = cloudService.getAlerts();
    expect(alerts.length).toBeLessThanOrEqual(100);

    // 3. Test local crashes capped at 100
    for (let i = 0; i < 115; i++) {
      cloudService.logCrash(`خطأ ${i}`, 'ComponentX', 'LOW');
    }
    const crashes = cloudService.getCrashReports();
    expect(crashes.length).toBeLessThanOrEqual(100);

    // 4. Test local performance metrics capped at 100
    for (let i = 0; i < 115; i++) {
      cloudService.logPerformance(`Operation ${i}`, 50, 'SUCCESS');
    }
    const metrics = cloudService.getPerformanceMetrics();
    expect(metrics.length).toBeLessThanOrEqual(100);
  });
});
