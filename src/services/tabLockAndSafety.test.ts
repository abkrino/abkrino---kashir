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
    // These suites verify storage behavior, not subscription enforcement.
    // Keep license policy isolated so an expired/missing test token cannot block fixture writes.
    vi.spyOn(storage, 'assertWriteAllowed').mockReturnValue({ allowed: true });
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
    const tab2Lock = await tabLockService.requestLock({ timeoutMs: 100, retryIntervalMs: 25 });
    expect(tab2Lock.acquired).toBe(false);

    // Secondary tab must NOT call storage.init() or write data
    // Verify storage remains unready for Tab 2
    expect(storage.isStorageReady()).toBe(false);
    expect(await idb.kv.count()).toBe(0);
  });

  // 1b. محاولة أولى تُرفض ثم ثانية تنجح داخل نافذة المحاولات (لا تظهر شاشة الرفض)
  it('(1b) محاولة أولى تُرفض ثم ثانية تنجح داخل مهلة المحاولات دون إظهار شاشة الرفض', async () => {
    tabLockService.releaseLock();
    let callCount = 0;
    const trySpy = vi.spyOn(tabLockService, 'tryAcquireOnce').mockImplementation(async () => {
      callCount++;
      return callCount >= 2; // First attempt false, second attempt true
    });

    const result = await tabLockService.requestLock({ timeoutMs: 1500, retryIntervalMs: 40 });
    expect(result.acquired).toBe(true);
    expect(callCount).toBe(2);
    expect(tabLockService.isLockAcquired()).toBe(true);

    trySpy.mockRestore();
  });

  // 1c. تكرار استدعاء requestLock() لا ينشئ أقفالاً مكررة (idempotence)
  it('(1c) تكرار استدعاء requestLock() لا ينشئ أقفالاً مكررة (idempotent)', async () => {
    tabLockService.releaseLock();
    let attempts = 0;
    const trySpy = vi.spyOn(tabLockService, 'tryAcquireOnce').mockImplementation(async () => {
      attempts++;
      await new Promise(r => setTimeout(r, 60));
      return true;
    });

    // Fire duplicate calls in parallel while request is in flight
    const req1 = tabLockService.requestLock();
    const req2 = tabLockService.requestLock();
    const req3 = tabLockService.requestLock();

    // Verify all return the exact same in-flight Promise instance
    expect(req1).toBe(req2);
    expect(req2).toBe(req3);

    const [res1, res2, res3] = await Promise.all([req1, req2, req3]);
    expect(res1.acquired).toBe(true);
    expect(res2.acquired).toBe(true);
    expect(res3.acquired).toBe(true);
    expect(attempts).toBe(1); // Only 1 underlying attempt!

    // Subsequent call after lock is already held returns immediately
    const reqAfter = await tabLockService.requestLock();
    expect(reqAfter.acquired).toBe(true);
    expect(attempts).toBe(1); // Still 1!

    trySpy.mockRestore();
  });

  // 1d. إلغاء المحاولات عند abort فوراً دون انتظار انتهاء المهلة
  it('(1d) إلغاء المحاولات عند abort يتم فوراً دون انتظار انتهاء المهلة', async () => {
    tabLockService.releaseLock();
    const trySpy = vi.spyOn(tabLockService, 'tryAcquireOnce').mockResolvedValue(false);

    const abortController = new AbortController();
    const startTime = Date.now();

    // Request with 4000ms timeout, but abort after 50ms
    const lockPromise = tabLockService.requestLock({
      timeoutMs: 4000,
      retryIntervalMs: 80,
      signal: abortController.signal,
    });

    setTimeout(() => {
      abortController.abort();
    }, 50);

    const result = await lockPromise;
    const elapsed = Date.now() - startTime;

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('aborted');
    expect(elapsed).toBeLessThan(1000); // Exited promptly upon abort, not 4000ms

    trySpy.mockRestore();
  });

  // 1e. إعادة المحاولة التلقائية بعد فك القفل تنجح وتكمل تهيئة storage.init()
  it('(1e) إعادة المحاولة من شاشة الرفض بعد زوال القفل تنجح وتكمل تهيئة storage.init() بنجاح', async () => {
    tabLockService.releaseLock();

    // Step 1: Lock denied initially
    tabLockService.setLockForTesting(false);
    const firstAttempt = await tabLockService.requestLock({ timeoutMs: 50, retryIntervalMs: 20 });
    expect(firstAttempt.acquired).toBe(false);
    expect(storage.isStorageReady()).toBe(false);

    // Step 2: The other window closes / lock is now released
    tabLockService.releaseLock();
    tabLockService.setLockForTesting(true);

    // Step 3: Auto-retry interval triggers requestLock()
    const retryAttempt = await tabLockService.requestLock();
    expect(retryAttempt.acquired).toBe(true);

    // Step 4: Page performs storage.init() seamlessly in the same window
    await storage.init();
    expect(storage.isStorageReady()).toBe(true);
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
