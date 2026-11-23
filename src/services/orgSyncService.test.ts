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
  const updateDocCalls: { path: string; payload: any }[] = [];
  const getDocCalls: string[] = [];
  const authCallOrder: string[] = [];
  let setDocError: any = null;
  let updateDocError: any = null;
  let setDocDeferred: { promise: Promise<void>; resolve: () => void } | null = null;
  let serverNowMs = 1_763_500_000_000;

  return {
    writtenDocs,
    setDocCalls,
    updateDocCalls,
    getDocCalls,
    authCallOrder,
    get setDocError() {
      return setDocError;
    },
    set setDocError(e: any) {
      setDocError = e;
    },
    get updateDocError() {
      return updateDocError;
    },
    set updateDocError(e: any) {
      updateDocError = e;
    },
    get setDocDeferred() {
      return setDocDeferred;
    },
    set setDocDeferred(d: { promise: Promise<void>; resolve: () => void } | null) {
      setDocDeferred = d;
    },
    get serverNowMs() {
      return serverNowMs;
    },
    set serverNowMs(ms: number) {
      serverNowMs = ms;
    },
    reset: () => {
      writtenDocs.clear();
      setDocCalls.length = 0;
      updateDocCalls.length = 0;
      getDocCalls.length = 0;
      authCallOrder.length = 0;
      setDocError = null;
      updateDocError = null;
      setDocDeferred = null;
      serverNowMs = 1_763_500_000_000;
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
    syncMockState.authCallOrder.push(`setDoc:${ref.path}`);
    if (syncMockState.setDocDeferred) {
      await syncMockState.setDocDeferred.promise;
    }
    if (syncMockState.setDocError) {
      throw syncMockState.setDocError;
    }
    syncMockState.writtenDocs.set(ref.path, data);
  }),
  updateDoc: vi.fn(async (ref: { path: string }, data: any) => {
    syncMockState.updateDocCalls.push({ path: ref.path, payload: data });
    if (syncMockState.updateDocError) {
      throw syncMockState.updateDocError;
    }
    syncMockState.writtenDocs.set(ref.path, data);
  }),
  deleteDoc: vi.fn(async (ref: { path: string }) => {
    syncMockState.writtenDocs.delete(ref.path);
  }),
  getDoc: vi.fn(async (ref: { path: string }) => {
    syncMockState.getDocCalls.push(ref.path);
    return {
      exists: () => true,
      data: () => ({
        lastSeenAt: {
          toMillis: () => Date.now(),
        },
      }),
    };
  }),
  getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: vi.fn(() => ({
    set: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn(async () => {}),
  })),
}));

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(async () => {
    syncMockState.authCallOrder.push('signOut');
  }),
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
  let reconcileNotifyCount = 0;
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
    setState: (next: any, notify: boolean = true) => {
      state = next;
      if (notify) {
        for (const l of listeners) {
          try { l(); } catch {}
        }
      }
    },
    emitNotificationOnly: () => {
      for (const l of listeners) {
        try { l(); } catch {}
      }
    },
    get reconcileNotifyCount() {
      return reconcileNotifyCount;
    },
    set reconcileNotifyCount(n: number) {
      reconcileNotifyCount = n;
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
    reconcileClockWithServer: () => {
      // Simulate real licenseService behavior: only fires notifyListeners if state changed;
      // firing a notification on normal matched time must not loop orgSyncService anyway.
      mockLicenseCtrl.emitNotificationOnly();
      return { reconciled: true };
    },
    isStoreActivated: () => true,
    getDeviceId: () => 'dev-1',
  },
  isStoreActivated: () => true,
}));

import {
  getYyyyMmDdCairo,
  calculateDailySummaryData,
  shouldPushSummary,
  computeEffectiveLicenseFingerprint,
  computeDailySummarySignature,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_MIN_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  CLOCK_RECONCILE_INTERVAL_MS,
  RawStorageDailySummaryInput,
  orgSyncService,
} from './orgSyncService';
import {
  cloudBudgetService,
  BUDGET_EXCEEDED_MESSAGE_AR,
  SIX_HOUR_PAUSE_MS,
} from './cloudBudgetService';

function appendSaleWithAmount(amount: number, suffix: string): void {
  const existing = storage.getSalesInvoices();
  const inv: SalesInvoice = {
    id: `inv_test_${Date.now()}_${suffix}`,
    invoiceNumber: `INV-${suffix}`,
    date: new Date().toISOString(),
    time: '12:00',
    customerId: 'c_cash',
    customerName: 'عميل نقدي',
    salespersonId: 'u1',
    salespersonName: 'كاشير',
    items: [],
    subtotal: amount,
    discountType: 'AMOUNT',
    discountValue: 0,
    discountAmount: 0,
    total: amount,
    paidAmount: amount,
    remainingAmount: 0,
    paymentType: 'CASH',
    previousCustomerBalance: 0,
    newCustomerBalance: 0,
    totalCost: amount * 0.7,
    totalProfit: amount * 0.3,
    status: 'POSTED',
  };
  storage.setItem(STORAGE_KEYS.INVOICES, [...existing, inv]);
}

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

  describe('shouldPushSummary & computeEffectiveLicenseFingerprint & computeDailySummarySignature', () => {
    it('uses 15 seconds default interval and ignores volatile license fields in fingerprint', () => {
      expect(SUMMARY_DEBOUNCE_MS).toBe(15000);
      expect(SUMMARY_MIN_INTERVAL_MS).toBe(15000);
      expect(HEARTBEAT_MIN_INTERVAL_MS).toBe(60000);
      expect(CLOCK_RECONCILE_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);

      const lastPush = 1_000_000;
      expect(shouldPushSummary(lastPush + 10000, lastPush)).toBe(false);
      expect(shouldPushSummary(lastPush + 15000, lastPush)).toBe(true);
      expect(shouldPushSummary(lastPush + 100, lastPush, 15000, true)).toBe(true);
      expect(shouldPushSummary(Date.now(), 0)).toBe(true);

      const fpA = computeEffectiveLicenseFingerprint({
        status: 'valid',
        daysRemaining: 30,
        message: 'msg 1',
        canOperate: true,
        payload: {
          v: 1,
          orgId: 'org-1',
          branchId: 'b-1',
          deviceId: 'dev-1',
          mode: 'offline',
          plan: 'pro',
          issuedAt: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z',
          graceDays: 7,
          maxOfflineDays: 30,
        },
      });
      const fpB = computeEffectiveLicenseFingerprint({
        status: 'valid',
        daysRemaining: 29,
        message: 'msg 2 with clock warning',
        canOperate: true,
        payload: {
          v: 1,
          orgId: 'org-1',
          branchId: 'b-1',
          deviceId: 'dev-1',
          mode: 'offline',
          plan: 'pro',
          issuedAt: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z',
          graceDays: 7,
          maxOfflineDays: 30,
        },
      });
      expect(fpA).toBe(fpB);

      const sig1 = computeDailySummarySignature({
        yyyyMMdd: '2026-11-18',
        salesTotal: 500,
        invoiceCount: 3,
        cashInDrawer: 1200,
        purchasesTotal: 100,
        customerDebt: 50,
        supplierDue: 0,
        lowStockCount: 1,
      });
      const sig2 = computeDailySummarySignature({
        yyyyMMdd: '2026-11-18',
        salesTotal: 500,
        invoiceCount: 3,
        cashInDrawer: 1200,
        purchasesTotal: 100,
        customerDebt: 50,
        supplierDue: 0,
        lowStockCount: 1,
      });
      expect(sig1).toBe(sig2);
    });
  });
});

describe('orgSyncService — Loop Break, 15s Debounce, Circuit Breaker & Error Backoff', () => {
  beforeEach(async () => {
    localStorage.clear();
    syncMockState.reset();
    orgSyncService.resetForTesting();
    mockAuthState.currentUser = { uid: 'org_sync_1', email: 'sync@store.test' };
    mockLicenseCtrl.setState(
      {
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
      },
      false
    );

    if (typeof globalThis.navigator !== 'undefined') {
      vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
    }

    await idb.kv.clear();
    await cloudBudgetService.resetForTesting();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
    await storage.init();
    storage.loadDemoData();
    // Reset dirty flag triggered by loadDemoData so each test starts clean
    storage.setSummaryDirty(false);
    await storage.flush();
  });

  afterEach(async () => {
    orgSyncService.resetForTesting();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await idb.kv.clear();
  });

  it('1) الملخص يُكتب بعد تغيير البيانات بـ 15 ثانية عبر storage.setItem مع تجميع الإجراءات المتلاحقة', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(20);
    syncMockState.setDocCalls.length = 0;

    // 5 rapid changes separated by 1s (< 15s debounce window)
    for (let i = 1; i <= 5; i++) {
      appendSaleWithAmount(100 + i, `batch_${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(storage.getSummaryDirty()).toBe(true);
    expect(syncMockState.setDocCalls.length).toBe(0);

    // At 14s after last change (1s elapsed inside loop + 13s here) -> not written yet
    await vi.advanceTimersByTimeAsync(13_000);
    expect(syncMockState.setDocCalls.length).toBe(0);

    // Hold write #1 open to verify mid-write change never overlaps and schedules trailing write
    let resolveInFlight!: () => void;
    syncMockState.setDocDeferred = {
      promise: new Promise<void>(res => {
        resolveInFlight = res;
      }),
      resolve: () => resolveInFlight(),
    };

    // Pass 15s debounce boundary -> triggers single write #1
    await vi.advanceTimersByTimeAsync(1200);
    expect(syncMockState.setDocCalls.length).toBe(1);

    // Another sale arrives while write #1 is in flight -> no overlapping write
    appendSaleWithAmount(250, 'mid_write');
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(true);

    // Resolve write #1
    syncMockState.setDocDeferred = null;
    resolveInFlight();
    await vi.advanceTimersByTimeAsync(50);
    expect(storage.getSummaryDirty()).toBe(true);

    // Trailing write runs cleanly after 15s debounce
    await vi.advanceTimersByTimeAsync(15_200);
    expect(syncMockState.setDocCalls.length).toBe(2);
    expect(storage.getSummaryDirty()).toBe(false);
  });

  it('2) كشف تغير أي بيانات مالية في setItem (مشتريات/تسوية مخزون) + منع تكرار الكتابة عند تطابق الحمولة (deduplication)', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(20);
    syncMockState.setDocCalls.length = 0;

    // Test recordStockAdjustment / PURCHASES via setItem WITHOUT calling notifyAction!
    const stockRes = storage.recordStockAdjustment({
      productId: storage.getProducts()[0].id,
      differencePieces: -100,
      reason: 'DAMAGE',
      reasonArabic: 'تالف اختبار تلقائي',
      performedBy: 'مدير',
    });
    expect(stockRes.success).toBe(true);
    expect(storage.getSummaryDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_100);
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(false);

    // Mutate PRODUCTS keeping exact same lowStockCount (e.g. changing name/description or identical payload re-set)
    const currentProducts = storage.getProducts();
    storage.setItem(STORAGE_KEYS.PRODUCTS, [...currentProducts]);
    expect(storage.getSummaryDirty()).toBe(true);

    // After 15s, payload is identical (excluding updatedAt) -> MUST skip setDoc AND clear summaryDirty!
    await vi.advanceTimersByTimeAsync(15_100);
    expect(syncMockState.setDocCalls.length).toBe(1); // still 1!
    expect(storage.getSummaryDirty()).toBe(false);
  });

  it('3) تفريغ فوري للملخص عند SHIFT_CLOSED و pagehide و visibilitychange(hidden) وقبل signOutStore()', async () => {
    const winTarget = new EventTarget();
    const docTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', winTarget);
    vi.stubGlobal('document', docTarget);

    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(20);
    syncMockState.setDocCalls.length = 0;

    // 3a. SHIFT_CLOSED triggers immediate flush without waiting 15s
    appendSaleWithAmount(120, 'shift_close_case');
    expect(syncMockState.setDocCalls.length).toBe(0);
    storage.notifyAction('SHIFT_CLOSED');
    await vi.advanceTimersByTimeAsync(20);
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(false);

    // 3b. visibilitychange -> hidden triggers immediate flush even under 15s cooldown
    appendSaleWithAmount(130, 'visibility_hidden_case');
    docTarget.visibilityState = 'hidden';
    docTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(20);
    expect(syncMockState.setDocCalls.length).toBe(2);
    expect(storage.getSummaryDirty()).toBe(false);
    docTarget.visibilityState = 'visible';

    // 3c. pagehide triggers immediate flush
    appendSaleWithAmount(140, 'pagehide_case');
    winTarget.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(20);
    expect(syncMockState.setDocCalls.length).toBe(3);
    expect(storage.getSummaryDirty()).toBe(false);

    // 3d. signOutStore() flushes dirty summary BEFORE fbSignOut
    appendSaleWithAmount(150, 'before_signout_case');
    syncMockState.authCallOrder.length = 0;
    await orgSyncService.signOutStore();
    expect(syncMockState.setDocCalls.length).toBe(4);
    expect(storage.getSummaryDirty()).toBe(false);
    expect(syncMockState.authCallOrder[0]).toContain('setDoc:');
    expect(syncMockState.authCallOrder[syncMockState.authCallOrder.length - 1]).toBe('signOut');
  });

  it('4) كسر الحلقة نهائياً: 100 إشعار ترخيص بنفس البصمة = 0 نبضات إضافية + حد 60ث للنبضة + 6س لمزامنة الساعة', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(30);

    // Startup runs exactly 1 heartbeat write + 1 clock reconciliation read (even though reconcileClockWithServer notifies listeners!)
    expect(syncMockState.updateDocCalls.length).toBe(1);
    expect(syncMockState.getDocCalls.length).toBe(1);

    // Emit 100 redundant license notifications with the same effective fingerprint
    for (let i = 0; i < 100; i++) {
      mockLicenseCtrl.setState({
        ...mockLicenseCtrl.getState(),
        daysRemaining: 30 - (i % 2),
        message: `إشعار مكرر رقم ${i}`,
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    // ZERO extra heartbeats or reads! Loop is 100% broken.
    expect(syncMockState.updateDocCalls.length).toBe(1);
    expect(syncMockState.getDocCalls.length).toBe(1);

    // Periodic heartbeat within 60s -> blocked by 60s min interval cooldown
    await vi.advanceTimersByTimeAsync(30_000);
    const blockedRes = await orgSyncService.sendHeartbeat({ reason: 'periodic' });
    expect(blockedRes.skipped).toBe(true);
    expect(syncMockState.updateDocCalls.length).toBe(1);

    // Periodic heartbeat AFTER 60s -> writes heartbeat #2, skips getDoc because < 6 hours since startup reconcile!
    await vi.advanceTimersByTimeAsync(35_000);
    const allowedRes = await orgSyncService.sendHeartbeat({ reason: 'periodic' });
    expect(allowedRes.success).toBe(true);
    expect(syncMockState.updateDocCalls.length).toBe(2);
    expect(syncMockState.getDocCalls.length).toBe(1); // still 1 read!

    // Advance 6 hours -> periodic heartbeat performs clock reconcile read #2
    await vi.advanceTimersByTimeAsync(CLOCK_RECONCILE_INTERVAL_MS);
    const reconcileRes = await orgSyncService.sendHeartbeat({ reason: 'periodic' });
    expect(reconcileRes.success).toBe(true);
    expect(syncMockState.getDocCalls.length).toBe(2);
  });

  it('5) Circuit Breaker يوقف المزامنة عند الحد اليومي مع الحفاظ على summaryDirty واستئناف تلقائي بعد منتصف الليل بالقاهرة', async () => {
    vi.useFakeTimers();
    // 2026-11-18T21:58:00Z -> 23:58:00 Africa/Cairo
    vi.setSystemTime(new Date('2026-11-18T21:58:00Z'));

    // Exceed write budget BEFORE starting actions
    cloudBudgetService.setUsageForTesting({
      dateStr: getYyyyMmDdCairo(new Date()),
      writes: 1500,
      reads: 0,
      deletes: 0,
    });

    orgSyncService.startService();
    expect(orgSyncService.getSyncState()).toBe('budget-paused');
    expect(orgSyncService.getLastError()).toBe(BUDGET_EXCEEDED_MESSAGE_AR);

    // Trigger data change -> summaryDirty stays true, ZERO Firestore calls made
    appendSaleWithAmount(500, 'while_budget_paused');
    expect(storage.getSummaryDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncMockState.setDocCalls.length).toBe(0);
    expect(syncMockState.updateDocCalls.length).toBe(0);
    expect(storage.getSummaryDirty()).toBe(true);

    // Advance 3 minutes across Cairo midnight (23:58:30 -> 00:01:30 next day)
    await vi.advanceTimersByTimeAsync(180_000);

    // Auto-resumed and flushed pending dirty summary + heartbeat!
    expect(orgSyncService.getSyncState()).not.toBe('budget-paused');
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(false);
  });

  it('6) سياسة الأخطاء: إيقاف 6 ساعات عند resource-exhausted و permission-denied + backoff أسي للأخطاء الأخرى وإعادة التصفير عند النجاح', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(20);
    syncMockState.updateDocCalls.length = 0;

    // 6a. resource-exhausted triggers immediate 6-hour pause (NO immediate retry or exponential backoff)
    syncMockState.updateDocError = Object.assign(new Error('Quota exceeded'), {
      code: 'resource-exhausted',
    });
    const resExhausted = await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(resExhausted.success).toBe(false);
    expect(orgSyncService.isSubscriptionPaused()).toBe(true);
    expect(orgSyncService.getSyncState()).toBe('subscription-paused');
    expect(orgSyncService.getPermissionRetryTimer()).not.toBeNull();
    expect(orgSyncService.getBackoffTimer()).toBeNull();

    // Advance 1 minute -> NO retries occurred during 6h pause
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncMockState.updateDocCalls.length).toBe(1);

    // License fingerprint change (branchId changed) resets 6h pause immediately!
    syncMockState.updateDocError = null;
    mockLicenseCtrl.setState({
      ...mockLicenseCtrl.getState(),
      payload: {
        ...mockLicenseCtrl.getState().payload,
        branchId: 'branch_2',
      },
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(orgSyncService.isSubscriptionPaused()).toBe(false);
    expect(syncMockState.updateDocCalls.length).toBe(2);

    // 6b. permission-denied also triggers 6h pause (SIX_HOUR_PAUSE_MS)
    syncMockState.updateDocError = Object.assign(new Error('Missing permissions'), {
      code: 'permission-denied',
    });
    await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(orgSyncService.isSubscriptionPaused()).toBe(true);
    expect(orgSyncService.getSyncState()).toBe('subscription-paused');

    // Clear after full 6h pause elapses cleanly
    syncMockState.updateDocError = null;
    await vi.advanceTimersByTimeAsync(SIX_HOUR_PAUSE_MS + 100);
    expect(orgSyncService.isSubscriptionPaused()).toBe(false);

    // 6c. Transient/other errors ('unavailable') advance exponential backoff step: 0 -> 1 -> 2 -> reset 0 on success
    syncMockState.updateDocError = Object.assign(new Error('Network unavailable'), {
      code: 'unavailable',
    });
    await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(orgSyncService.getBackoffStep()).toBe(1);
    expect(orgSyncService.isBackoffActive()).toBe(true);

    await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(orgSyncService.getBackoffStep()).toBe(2);

    // Fix error and succeed -> backoffStep resets back to 0!
    syncMockState.updateDocError = null;
    await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(orgSyncService.getBackoffStep()).toBe(0);
    expect(orgSyncService.isBackoffActive()).toBe(false);
  });

  it('7) علامة summaryDirty تبقى محفوظة في IndexedDB بعد الانقطاع وتُرفع فوراً عند الإقلاع وتفعيل الترخيص', async () => {
    vi.useFakeTimers();
    orgSyncService.startService();
    await vi.advanceTimersByTimeAsync(20);
    syncMockState.setDocCalls.length = 0;

    // Simulate failure during write
    syncMockState.setDocError = new Error('unavailable');
    appendSaleWithAmount(333, 'outage_sale');
    expect(storage.getSummaryDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_100);
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(storage.getSummaryDirty()).toBe(true);

    vi.useRealTimers();
    await storage.flush();
    const idbRecord = await idb.kv.get(STORAGE_KEYS.SUMMARY_DIRTY);
    expect(idbRecord?.value).toBe(true);

    orgSyncService.stopService();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    await storage.init();

    expect(orgSyncService.isSummaryDirty()).toBe(true);

    syncMockState.setDocError = null;
    syncMockState.setDocCalls.length = 0;

    orgSyncService.startService();
    await new Promise(r => setTimeout(r, 40));
    expect(syncMockState.setDocCalls.length).toBe(1);
    expect(orgSyncService.isSummaryDirty()).toBe(false);

    // Verify license activation flushes pending dirty summary
    orgSyncService.stopService();
    syncMockState.setDocCalls.length = 0;
    mockLicenseCtrl.setState({ status: 'unlicensed', daysRemaining: 0, message: 'غير مرخص' }, false);

    vi.useFakeTimers();
    orgSyncService.startService();
    appendSaleWithAmount(444, 'unlicensed_sale');
    await vi.advanceTimersByTimeAsync(15_100);
    expect(syncMockState.setDocCalls.length).toBe(0);
    expect(orgSyncService.isSummaryDirty()).toBe(true);

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
});
