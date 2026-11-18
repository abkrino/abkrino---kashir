import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { SalesInvoice, PurchaseInvoice, Product, Customer, Supplier } from '../types';

// Ensure localStorage works cleanly in Vitest Node environment
const lsStore: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
      setItem: (k: string, v: string) => {
        lsStore[k] = String(v);
      },
      removeItem: (k: string) => {
        delete lsStore[k];
      },
      clear: () => {
        for (const k of Object.keys(lsStore)) delete lsStore[k];
      },
    },
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Mocked Firestore + Auth + License for orgSyncService integration tests
// ---------------------------------------------------------------------------
const syncMockState = vi.hoisted(() => {
  const writtenDocs = new Map<string, any>();
  const setDocCalls: { path: string; payload: any }[] = [];
  let setDocError: Error | null = null;
  let setDocDeferred: { promise: Promise<void>; resolve: () => void } | null = null;

  return {
    writtenDocs,
    setDocCalls,
    get setDocError() {
      return setDocError;
    },
    set setDocError(e: Error | null) {
      setDocError = e;
    },
    get setDocDeferred() {
      return setDocDeferred;
    },
    set setDocDeferred(d: { promise: Promise<void>; resolve: () => void } | null) {
      setDocDeferred = d;
    },
    reset: () => {
      writtenDocs.clear();
      setDocCalls.length = 0;
      setDocError = null;
      setDocDeferred = null;
    },
  };
});

vi.mock('firebase/firestore', () => ({
  doc: (_db: any, ...segments: string[]) => ({
    path: segments.join('/'),
    id: segments[segments.length - 1],
  }),
  collection: (_db: any, ...segments: string[]) => ({ path: segments.join('/') }),
  serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
  setDoc: vi.fn(async (ref: { path: string }, data: any) => {
    syncMockState.setDocCalls.push({ path: ref.path, payload: data });
    if (syncMockState.setDocDeferred) {
      await syncMockState.setDocDeferred.promise;
    }
    if (syncMockState.setDocError) {
      throw syncMockState.setDocError;
    }
    syncMockState.writtenDocs.set(ref.path, data);
  }),
  updateDoc: vi.fn(async (ref: { path: string }, data: any) => {
    syncMockState.writtenDocs.set(ref.path, data);
  }),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
}));

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(() => () => {}),
}));

const mockAuthState = vi.hoisted(() => ({
  currentUser: { uid: 'org_sync_1', email: 'sync@store.test' } as { uid: string; email: string } | null,
}));

vi.mock('./cloudService', () => ({
  db: { __mockDb: true },
  auth: mockAuthState,
  isCloudConfigured: true,
}));

const mockLicenseCtrl = vi.hoisted(() => {
  const listeners: (() => void)[] = [];
  let state: any = {
    status: 'valid',
    daysRemaining: 30,
    message: 'سارٍ',
    payload: {
      orgId: 'org_sync_1',
      branchId: 'main',
      mode: 'offline',
      deviceId: 'dev-1',
      plan: 'pro',
      issuedAt: '2026-11-01T00:00:00Z',
      validUntil: '2027-11-01T00:00:00Z',
      graceDays: 7,
    },
  };
  return {
    getState: () => state,
    setState: (next: any) => {
      state = next;
      for (const l of listeners) {
        try { l(); } catch {}
      }
    },
    subscribe: (cb: () => void) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
});

vi.mock('./licenseService', () => ({
  licenseService: {
    getLicenseState: () => mockLicenseCtrl.getState(),
    subscribe: (cb: () => void) => mockLicenseCtrl.subscribe(cb),
    reconcileClockWithServer: () => ({ reconciled: true }),
    isStoreActivated: () => true,
    getDeviceId: () => 'dev-1',
  },
  isStoreActivated: () => true,
}));

import {
  getYyyyMmDdCairo,
  calculateDailySummaryData,
  shouldPushSummary,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_MIN_INTERVAL_MS,
  RawStorageDailySummaryInput,
  orgSyncService,
} from './orgSyncService';

describe('orgSyncService pure functions', () => {
  describe('getYyyyMmDdCairo', () => {
    it('formats dates into YYYY-MM-DD using Africa/Cairo timezone', () => {
      const d1 = new Date('2026-11-07T12:00:00Z');
      expect(getYyyyMmDdCairo(d1)).toBe('2026-11-07');

      const dBeforeMidnight = new Date('2026-11-07T21:59:00Z');
      expect(getYyyyMmDdCairo(dBeforeMidnight)).toBe('2026-11-07');

      const dAfterMidnight = new Date('2026-11-07T22:01:00Z');
      expect(getYyyyMmDdCairo(dAfterMidnight)).toBe('2026-11-08');
    });

    it('defaults to current time without throwing', () => {
      const result = getYyyyMmDdCairo();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('calculateDailySummaryData', () => {
    it('aggregates daily figures accurately and isolates today vs other days', () => {
      const todayCairo = '2026-11-07';

      const invoices: Partial<SalesInvoice>[] = [
        { id: 'inv-1', invoiceNumber: 'INV-001', date: '2026-11-07T10:00:00Z', total: 150.5 },
        { id: 'inv-2', invoiceNumber: 'INV-002', date: '2026-11-07T14:30:00Z', total: 249.5 },
        { id: 'inv-old', invoiceNumber: 'INV-000', date: '2026-11-06T10:00:00Z', total: 999.0 },
      ];

      const purchases: Partial<PurchaseInvoice>[] = [
        { id: 'pur-1', invoiceNumber: 'PUR-001', date: '2026-11-07T11:00:00Z', totalCost: 180.25 },
        { id: 'pur-old', invoiceNumber: 'PUR-000', date: '2026-11-05T09:00:00Z', totalCost: 500.0 },
      ];

      const products: Partial<Product>[] = [
        { id: 'p-1', name: 'سكر 1 كجم', stockPieces: 3, reorderLevelPieces: 5 },
        { id: 'p-2', name: 'شاي 250 جم', stockPieces: 5, reorderLevelPieces: 5 },
        { id: 'p-3', name: 'أرز 1 كجم', stockPieces: 25, reorderLevelPieces: 5 },
      ];

      const customers: Partial<Customer>[] = [
        { id: 'c-1', name: 'أحمد', currentBalance: 450.75 },
        { id: 'c-2', name: 'محمد', currentBalance: 0 },
        { id: 'c-3', name: 'علي', currentBalance: -50 },
      ];

      const suppliers: Partial<Supplier>[] = [
        { id: 's-1', name: 'شركة الأهرام', currentBalance: 1200.5 },
        { id: 's-2', name: 'شركة النيل', currentBalance: 0 },
      ];

      const input: RawStorageDailySummaryInput = {
        invoices: invoices as SalesInvoice[],
        purchases: purchases as PurchaseInvoice[],
        products: products as Product[],
        customers: customers as Customer[],
        suppliers: suppliers as Supplier[],
        cashInDrawer: 875.5,
        cairoDateStr: todayCairo,
      };

      const summary = calculateDailySummaryData(input);

      expect(summary.yyyyMMdd).toBe(todayCairo);
      expect(summary.salesTotal).toBe(400);
      expect(summary.invoiceCount).toBe(2);
      expect(summary.purchasesTotal).toBe(180.25);
      expect(summary.cashInDrawer).toBe(875.5);
      expect(summary.customerDebt).toBe(450.75);
      expect(summary.supplierDue).toBe(1200.5);
      expect(summary.lowStockCount).toBe(2);
    });

    it('handles empty datasets cleanly without NaN', () => {
      const summary = calculateDailySummaryData({
        invoices: [],
        purchases: [],
        products: [],
        customers: [],
        suppliers: [],
        cashInDrawer: 0,
        cairoDateStr: '2026-11-07',
      });

      expect(summary.salesTotal).toBe(0);
      expect(summary.invoiceCount).toBe(0);
      expect(summary.purchasesTotal).toBe(0);
      expect(summary.customerDebt).toBe(0);
      expect(summary.supplierDue).toBe(0);
      expect(summary.lowStockCount).toBe(0);
      expect(summary.cashInDrawer).toBe(0);
    });
  });

  describe('shouldPushSummary (3-second interval)', () => {
    it('uses 3 seconds default interval (no 10-minute cooldown)', () => {
      expect(SUMMARY_DEBOUNCE_MS).toBe(3000);
      expect(SUMMARY_MIN_INTERVAL_MS).toBe(3000);

      const lastPush = 1_000_000;
      expect(shouldPushSummary(lastPush + 1500, lastPush)).toBe(false);
      expect(shouldPushSummary(lastPush + 3000, lastPush)).toBe(true);
      expect(shouldPushSummary(lastPush + 100, lastPush, 3000, true)).toBe(true);
      expect(shouldPushSummary(Date.now(), 0)).toBe(true);
    });
  });
});

describe('orgSyncService 3s debounce, batching, serialization & persistent summaryDirty', () => {
  beforeEach(async () => {
    localStorage.clear();
    syncMockState.reset();
    orgSyncService.resetForTesting();
    mockAuthState.currentUser = { uid: 'org_sync_1', email: 'sync@store.test' };
    mockLicenseCtrl.setState({
      status: 'valid',
      daysRemaining: 30,
      message: 'سارٍ',
      payload: {
        orgId: 'org_sync_1',
        branchId: 'main',
        mode: 'offline',
        deviceId: 'dev-1',
        plan: 'pro',
        issuedAt: '2026-11-01T00:00:00Z',
        validUntil: '2027-11-01T00:00:00Z',
        graceDays: 7,
      },
    });

    if (typeof globalThis.navigator !== 'undefined') {
      vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
    }

    await idb.kv.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
    await storage.init();
    storage.loadDemoData();
  });

  afterEach(async () => {
    orgSyncService.resetForTesting();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await idb.kv.clear();
  });

  it('1) الملخص يُكتب بعد الإجراء بـ 3 ثوانٍ دون حد الـ 10 دقائق', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();

    // First action -> writes after 3s
    storage.notifyAction('SALE_CREATED');
    expect(storage.getSummaryDirty()).toBe(true);
    expect(syncMockState.setDocCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(2900);
    expect(syncMockState.setDocCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(false);

    // Second action 5 seconds later (well under old 10 minutes!) -> also writes after 3s
    await vi.advanceTimersByTimeAsync(5000);
    storage.notifyAction('SALE_CREATED');
    expect(storage.getSummaryDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(3100);
    expect(syncMockState.setDocCalls.length).toBe(2);
    expect(storage.getSummaryDirty()).toBe(false);
  });

  it('2) تجميع 5 إجراءات متلاحقة في كتابة واحدة + عدم تداخل الكتابات إذا جاء إجراء أثناء الكتابة', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();

    // 5 rapid actions separated by 400ms (< 3000ms debounce window)
    for (let i = 0; i < 5; i++) {
      storage.notifyAction(`FAST_ACTION_${i}`);
      await vi.advanceTimersByTimeAsync(400);
    }
    // None written yet because debounce keeps resetting
    expect(syncMockState.setDocCalls.length).toBe(0);
    expect(storage.getSummaryDirty()).toBe(true);

    // Hold the Firestore write open using a deferred promise to test mid-write action arrival
    let resolveInFlight!: () => void;
    syncMockState.setDocDeferred = {
      promise: new Promise<void>(res => {
        resolveInFlight = res;
      }),
      resolve: () => resolveInFlight(),
    };

    // Advance 3s after last of the 5 actions -> starts exactly 1 write
    await vi.advanceTimersByTimeAsync(3000);
    expect(syncMockState.setDocCalls.length).toBe(1);

    // While write #1 is STILL in flight, trigger another action!
    storage.notifyAction('ACTION_MID_WRITE');
    expect(storage.getSummaryDirty()).toBe(true);
    // Still only 1 setDoc call (no overlapping concurrent write!)
    expect(syncMockState.setDocCalls.length).toBe(1);

    // Resolve write #1 cleanly
    syncMockState.setDocDeferred = null;
    resolveInFlight();
    await vi.advanceTimersByTimeAsync(50);

    // Because ACTION_MID_WRITE arrived while write #1 was running, summaryDirty MUST still be true!
    expect(storage.getSummaryDirty()).toBe(true);

    // Trailing follow-up write runs cleanly after 3s debounce + interval protection
    await vi.advanceTimersByTimeAsync(3200);
    expect(syncMockState.setDocCalls.length).toBe(2);
    expect(storage.getSummaryDirty()).toBe(false);
  });

  it('3) علامة summaryDirty تبقى محفوظة في IndexedDB بعد الفشل أو الانقطاع وتُرفع فوراً عند الإقلاع وتفعيل الترخيص', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();

    // Simulate network failure during write
    syncMockState.setDocError = new Error('unavailable');
    storage.notifyAction('SALE_DURING_OUTAGE');
    expect(storage.getSummaryDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(3100);
    expect(syncMockState.setDocCalls.length).toBe(1);
    // Dirty flag MUST remain true after failure
    expect(storage.getSummaryDirty()).toBe(true);

    // Switch back to real timers while interacting with fake-indexeddb (avoids fake-timer IDB deadlock)
    vi.useRealTimers();

    // Flush to IDB and simulate full app restart by clearing in-memory cache and calling storage.init()
    await storage.flush();
    const idbRecord = await idb.kv.get(STORAGE_KEYS.SUMMARY_DIRTY);
    expect(idbRecord?.value).toBe(true);

    orgSyncService.stopService();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    await storage.init();

    // Restored cleanly from IndexedDB!
    expect(orgSyncService.isSummaryDirty()).toBe(true);

    // Fix Firestore error and simulate app startup with restored dirty flag -> pushes immediately!
    syncMockState.setDocError = null;
    syncMockState.setDocCalls.length = 0;

    orgSyncService.startService();
    await new Promise(r => setTimeout(r, 30));
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(orgSyncService.isSummaryDirty()).toBe(false);

    // Also test license activation flushing a pending dirty summary while previously unlicensed
    orgSyncService.stopService();
    syncMockState.setDocCalls.length = 0;
    mockLicenseCtrl.setState({ status: 'unlicensed', daysRemaining: 0, message: 'غير مرخص' });

    vi.useFakeTimers();
    orgSyncService.startService();
    storage.notifyAction('SALE_WHILE_UNLICENSED');
    await vi.advanceTimersByTimeAsync(3100);
    // Blocked because unlicensed -> dirty stays true
    expect(syncMockState.setDocCalls.length).toBe(0);
    expect(orgSyncService.isSummaryDirty()).toBe(true);

    // Now activate license -> listener flushes summaryDirty immediately!
    mockLicenseCtrl.setState({
      status: 'valid',
      daysRemaining: 30,
      message: 'سارٍ',
      payload: {
        orgId: 'org_sync_1',
        branchId: 'main',
        mode: 'offline',
        deviceId: 'dev-1',
        plan: 'pro',
        issuedAt: '2026-11-01T00:00:00Z',
        validUntil: '2027-11-01T00:00:00Z',
        graceDays: 7,
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(orgSyncService.isSummaryDirty()).toBe(false);
  });

  it('4) إعادة المحاولة بعد permission-denied وإعادة الضبط عند تغير الترخيص أو الدخول', () => {
    orgSyncService.setSyncState('subscription-paused');
    orgSyncService.schedulePermissionRetry(6 * 60 * 60 * 1000);
    expect(orgSyncService.getPermissionRetryTimer()).toBeDefined();

    orgSyncService.resetSubscriptionPause();
    expect(orgSyncService.isSubscriptionPaused()).toBe(false);
    expect(orgSyncService.getPermissionRetryTimer()).toBeNull();
    expect(orgSyncService.getSyncState()).toBe('idle');
  });
});
