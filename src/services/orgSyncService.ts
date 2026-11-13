import { doc, updateDoc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { signInWithEmailAndPassword, signOut as fbSignOut } from 'firebase/auth';
import { db, auth } from './cloudService';
import { licenseService } from './licenseService';
import { detectEnvironment } from './environmentService';
import { storage } from './storageService';
import { DailySummaryDoc } from '../types/cloud';
import { SalesInvoice, PurchaseInvoice, Product, Customer, Supplier, SalesReturn } from '../types';
import { APP_VERSION } from '../config/appConfig';

export type SyncState = 
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'needs-login'
  | 'wrong-account'
  | 'subscription-paused'
  | 'offline'
  | 'no-license'
  | 'error';

export interface RawStorageDailySummaryInput {
  invoices: SalesInvoice[];
  purchases: PurchaseInvoice[];
  products: Product[];
  customers: Customer[];
  suppliers: Supplier[];
  cashInDrawer: number;
  cairoDateStr: string;
  salesReturns?: SalesReturn[];
}

// ---------------------------------------------------------------------------
// Pure Helper: Cairo Date Formatter (Africa/Cairo)
// ---------------------------------------------------------------------------
export function getYyyyMmDdCairo(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

// ---------------------------------------------------------------------------
// Pure Helper: Calculate Daily Summary Data from Local Store
// ---------------------------------------------------------------------------
export function calculateDailySummaryData(input: RawStorageDailySummaryInput): Omit<DailySummaryDoc, 'updatedAt'> {
  const { invoices, purchases, products, customers, suppliers, cashInDrawer, cairoDateStr, salesReturns = [] } = input;

  // Filter sales invoices belonging to this Cairo calendar date
  const todaysInvoices = invoices.filter(inv => {
    const rawDate = inv.date;
    if (!rawDate) return false;
    const invDateStr = getYyyyMmDdCairo(new Date(rawDate));
    return invDateStr === cairoDateStr;
  });

  const grossSalesTotal = todaysInvoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);

  // Filter sales returns belonging to this Cairo calendar date & deduct from salesTotal
  const todaysReturns = salesReturns.filter(ret => {
    const rawDate = ret.date;
    if (!rawDate) return false;
    const retDateStr = getYyyyMmDdCairo(new Date(rawDate));
    return retDateStr === cairoDateStr;
  });
  const returnsTotal = todaysReturns.reduce((sum, ret) => sum + (Number(ret.totalAmount) || 0), 0);

  const salesTotal = grossSalesTotal - returnsTotal;
  const invoiceCount = todaysInvoices.length;

  // Filter purchase invoices belonging to this Cairo calendar date
  const todaysPurchases = purchases.filter(pur => {
    const rawDate = pur.date;
    if (!rawDate) return false;
    const purDateStr = getYyyyMmDdCairo(new Date(rawDate));
    return purDateStr === cairoDateStr;
  });
  const purchasesTotal = todaysPurchases.reduce((sum, p) => sum + (Number(p.totalCost) || 0), 0);

  // Total active customer debt (balances > 0)
  const customerDebt = customers.reduce((sum, c) => sum + (c.currentBalance > 0 ? c.currentBalance : 0), 0);

  // Total active supplier dues (balances > 0)
  const supplierDue = suppliers.reduce((sum, s) => sum + (s.currentBalance > 0 ? s.currentBalance : 0), 0);

  // Count products under minimum reorder level
  const lowStockCount = products.filter(p => (p.stockPieces || 0) <= (p.reorderLevelPieces || 5)).length;

  return {
    yyyyMMdd: cairoDateStr,
    salesTotal: Math.round(salesTotal * 100) / 100,
    invoiceCount,
    cashInDrawer: Math.round(cashInDrawer * 100) / 100,
    purchasesTotal: Math.round(purchasesTotal * 100) / 100,
    customerDebt: Math.round(customerDebt * 100) / 100,
    supplierDue: Math.round(supplierDue * 100) / 100,
    lowStockCount,
  };
}

// ---------------------------------------------------------------------------
// Pure Helper: Debounce & Rate-Limiting Decision Logic
// Minimum 10 minutes between two consecutive writes, unless forceImmediate is true.
// ---------------------------------------------------------------------------
export function shouldPushSummary(
  currentTimeMs: number,
  lastPushTimeMs: number,
  minIntervalMs: number = 10 * 60 * 1000,
  forceImmediate: boolean = false
): boolean {
  if (forceImmediate) return true;
  if (lastPushTimeMs === 0) return true;
  return (currentTimeMs - lastPushTimeMs) >= minIntervalMs;
}

// ---------------------------------------------------------------------------
// Organization Sync Service
// ---------------------------------------------------------------------------
class OrgSyncService {
  private syncState: SyncState = 'idle';
  private lastHeartbeatDate: Date | null = null;
  private lastDailySummaryDate: Date | null = null;
  private lastDailySummaryPushMs: number = 0;
  private statusMessage: string | null = null;
  private listeners: (() => void)[] = [];

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rescheduleSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private isSubPaused: boolean = false;
  private isRunning: boolean = false;
  private cleanupFns: (() => void)[] = [];

  constructor() {
    // Timers and network listeners do NOT auto-start in constructor
    // They start exclusively via startService() after winning the single-tab lock and storage.init()
  }

  public isServiceRunning(): boolean {
    return this.isRunning;
  }

  public startService(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.initListeners();
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      this.sendHeartbeat().catch(() => {});
    }
  }

  public stopService(): void {
    this.isRunning = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.rescheduleSummaryTimer) {
      clearTimeout(this.rescheduleSummaryTimer);
      this.rescheduleSummaryTimer = null;
    }
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
      this.permissionRetryTimer = null;
    }
    this.cleanupFns.forEach(fn => {
      try { fn(); } catch {}
    });
    this.cleanupFns = [];
  }

  private initListeners() {
    if (typeof window === 'undefined') return;

    // Network reconnect listener
    const onOnline = () => {
      if (this.syncState === 'offline') {
        this.syncState = 'idle';
        this.notifyListeners();
      }
      this.sendHeartbeat().catch(() => {});
      this.pushDailySummary(false).catch(() => {});
    };
    window.addEventListener('online', onOnline);
    this.cleanupFns.push(() => window.removeEventListener('online', onOnline));

    const onOffline = () => {
      this.syncState = 'offline';
      this.notifyListeners();
    };
    window.addEventListener('offline', onOffline);
    this.cleanupFns.push(() => window.removeEventListener('offline', onOffline));

    // Page visibility change
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        this.sendHeartbeat().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanupFns.push(() => document.removeEventListener('visibilitychange', onVisibility));

    // 15-minute periodic heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        this.sendHeartbeat().catch(() => {});
      }
    }, 15 * 60 * 1000);

    // Storage action listener for daily summary update (debounced 2 minutes)
    const unsubStorage = storage.onAction(() => {
      this.scheduleDebouncedDailySummary();
    });
    this.cleanupFns.push(unsubStorage);

    // License change listener: resets subscription pause and retries
    const unsubLicense = licenseService.subscribe(() => {
      if (this.isSubPaused) {
        this.resetSubscriptionPause();
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          this.sendHeartbeat().catch(() => {});
          this.pushDailySummary(false).catch(() => {});
        }
      } else {
        this.notifyListeners();
      }
    });
    this.cleanupFns.push(unsubLicense);
  }

  // -------------------------------------------------------------------------
  // 1. getContext(): Returns { orgId, branchId, mode } from active license ONLY
  // -------------------------------------------------------------------------
  public getContext(): { orgId: string; branchId: string; mode: 'offline' | 'online' } | null {
    const licState = licenseService.getLicenseState();
    if ((licState.status === 'valid' || licState.status === 'grace') && licState.payload) {
      if (licState.payload.orgId && licState.payload.branchId) {
        return {
          orgId: licState.payload.orgId,
          branchId: licState.payload.branchId,
          mode: licState.payload.mode || 'offline',
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 2. ensureSignedIn(): Validates auth.currentUser.uid == orgId
  // -------------------------------------------------------------------------
  public ensureSignedIn(): 'ok' | 'needs-login' | 'wrong-account' {
    const context = this.getContext();
    if (!context) return 'needs-login';

    const currentUser = auth.currentUser;
    if (!currentUser) {
      return 'needs-login';
    }

    if (currentUser.uid !== context.orgId) {
      return 'wrong-account';
    }

    return 'ok';
  }

  // -------------------------------------------------------------------------
  // 3. Store Login with signInWithEmailAndPassword ONLY
  // -------------------------------------------------------------------------
  public async signInStore(email: string, pass: string): Promise<{ success: boolean; error?: string }> {
    const cleanEmail = email.trim();
    if (!cleanEmail || !pass) {
      return { success: false, error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور.' };
    }

    const context = this.getContext();
    if (!context) {
      return {
        success: false,
        error: 'لا يوجد ترخيص أوفلاين سارٍ أو فعال على هذا الجهاز لتحديد هوية المحل والفرع.',
      };
    }

    try {
      this.syncState = 'syncing';
      this.notifyListeners();

      // Reset subscription pause on any new sign-in attempt
      this.resetSubscriptionPause();

      // STRICT REQUIREMENT: signInWithEmailAndPassword ONLY for store sync login.
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, pass);
      const user = cred.user;

      // Verify that logged-in user UID matches the orgId in active license
      if (user.uid !== context.orgId) {
        await fbSignOut(auth);
        this.syncState = 'wrong-account';
        this.statusMessage = 'هذا الحساب لا يطابق ترخيص الجهاز';
        this.notifyListeners();
        return { success: false, error: 'هذا الحساب لا يطابق ترخيص الجهاز' };
      }

      this.syncState = 'synced';
      this.statusMessage = 'تم تسجيل دخول المحل للمزامنة بنجاح.';
      this.notifyListeners();

      // Trigger initial heartbeat and summary
      this.sendHeartbeat().catch(() => {});
      this.pushDailySummary(true).catch(() => {});

      return { success: true };
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      let errorMsg = 'فشل تسجيل الدخول. يرجى التأكد من البريد الإلكتروني وكلمة المرور.';

      if (
        errObj.code === 'auth/wrong-password' ||
        errObj.code === 'auth/invalid-credential' ||
        errObj.code === 'auth/user-not-found'
      ) {
        errorMsg = 'فشل تسجيل الدخول: كلمة المرور أو البريد الإلكتروني غير صحيح.';
      } else if (errObj.code === 'auth/network-request-failed') {
        errorMsg = 'تعذر الاتصال بخوادم السحابة. تحقق من اتصال الإنترنت.';
      }

      this.syncState = 'error';
      this.statusMessage = errorMsg;
      this.notifyListeners();
      return { success: false, error: errorMsg };
    }
  }

  public async signOutStore(): Promise<void> {
    try {
      await fbSignOut(auth);
    } catch {}
    this.syncState = 'needs-login';
    this.statusMessage = null;
    this.notifyListeners();
  }

  // -------------------------------------------------------------------------
  // 4. sendHeartbeat(): updateDoc with serverTimestamp() + clock reconcile
  // -------------------------------------------------------------------------
  public async sendHeartbeat(): Promise<{ success: boolean; error?: string }> {
    if (this.isSubPaused) return { success: false, error: 'subscription-paused' };
    if (!storage.isStorageReady()) return { success: false, error: 'storage-not-ready' };

    const context = this.getContext();
    if (!context) {
      this.syncState = 'no-license';
      this.notifyListeners();
      return { success: false, error: 'no-valid-license' };
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.syncState = 'offline';
      this.notifyListeners();
      return { success: false, error: 'offline' };
    }

    const authCheck = this.ensureSignedIn();
    if (authCheck !== 'ok') {
      this.syncState = authCheck;
      this.notifyListeners();
      return { success: false, error: authCheck };
    }

    try {
      const env = detectEnvironment();
      const branchRef = doc(db, 'orgs', context.orgId, 'branches', context.branchId);

      // STRICT: lastSeenAt must be serverTimestamp() as enforced by firestore.rules
      // mode is taken from license payload, and appVersion from APP_VERSION constant
      await updateDoc(branchRef, {
        lastSeenAt: serverTimestamp(),
        appVersion: APP_VERSION,
        windowsVersion: env.windowsVersion,
        mode: context.mode,
      });

      // Read back server lastSeenAt to reconcile clock
      try {
        const branchSnap = await getDoc(branchRef);
        if (branchSnap.exists()) {
          const branchData = branchSnap.data();
          const serverTime = branchData?.lastSeenAt;
          if (serverTime) {
            let serverMs: number | null = null;
            if (typeof serverTime.toMillis === 'function') {
              serverMs = serverTime.toMillis();
            } else if (typeof serverTime.toDate === 'function') {
              serverMs = serverTime.toDate().getTime();
            } else if (serverTime instanceof Date) {
              serverMs = serverTime.getTime();
            } else if (typeof serverTime === 'number') {
              serverMs = serverTime;
            }
            if (serverMs !== null) {
              const clockRes = licenseService.reconcileClockWithServer(serverMs);
              if (!clockRes.reconciled && clockRes.warning) {
                this.statusMessage = clockRes.warning;
              }
            }
          }
        }
      } catch (clockErr) {
        console.warn('Clock reconciliation read error:', clockErr);
      }

      this.lastHeartbeatDate = new Date();
      if (this.syncState !== 'syncing') {
        this.syncState = 'synced';
      }
      this.notifyListeners();
      return { success: true };
    } catch (err: unknown) {
      return this.handleSyncError(err, 'sendHeartbeat');
    }
  }

  // -------------------------------------------------------------------------
  // 5. pushDailySummary(): calculate and setDoc in dailySummaries/{yyyy-MM-dd}
  // -------------------------------------------------------------------------
  private scheduleDebouncedDailySummary() {
    if (this.isSubPaused) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // 2-minute debounce
    this.debounceTimer = setTimeout(() => {
      this.pushDailySummary(false).catch(() => {});
    }, 2 * 60 * 1000);
  }

  public async pushDailySummary(forceImmediate: boolean = false): Promise<{ success: boolean; error?: string }> {
    if (!storage.isStorageReady()) return { success: false, error: 'storage-not-ready' };
    if (this.isSubPaused) return { success: false, error: 'subscription-paused' };

    const context = this.getContext();
    if (!context) {
      this.syncState = 'no-license';
      this.notifyListeners();
      return { success: false, error: 'no-valid-license' };
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.syncState = 'offline';
      this.notifyListeners();
      return { success: false, error: 'offline' };
    }

    const authCheck = this.ensureSignedIn();
    if (authCheck !== 'ok') {
      this.syncState = authCheck;
      this.notifyListeners();
      return { success: false, error: authCheck };
    }

    // Rate-limiting check: minimum 10 minutes between writes unless forceImmediate is true
    const now = Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    if (!shouldPushSummary(now, this.lastDailySummaryPushMs, TEN_MINUTES_MS, forceImmediate)) {
      // Re-schedule for remaining cooldown time so update is never lost
      const elapsed = now - this.lastDailySummaryPushMs;
      const remainingMs = Math.max(1000, TEN_MINUTES_MS - elapsed);
      if (this.rescheduleSummaryTimer) {
        clearTimeout(this.rescheduleSummaryTimer);
      }
      this.rescheduleSummaryTimer = setTimeout(() => {
        this.rescheduleSummaryTimer = null;
        this.pushDailySummary(false).catch(() => {});
      }, remainingMs);

      return { success: true };
    }

    // Clear pending reschedule timer if pushing now
    if (this.rescheduleSummaryTimer) {
      clearTimeout(this.rescheduleSummaryTimer);
      this.rescheduleSummaryTimer = null;
    }

    try {
      // Requirement 4: Reject if storage is not ready or data not loaded and all numbers zero
      if (!storage.isStorageReady()) {
        this.syncState = 'idle';
        this.notifyListeners();
        return { success: false, error: 'storage-not-ready' };
      }

      this.syncState = 'syncing';
      this.notifyListeners();

      const cairoDateStr = getYyyyMmDdCairo(new Date());

      const summaryPayload = calculateDailySummaryData({
        invoices: storage.getSalesInvoices(),
        purchases: storage.getPurchases(),
        products: storage.getProducts(),
        customers: storage.getCustomers(),
        suppliers: storage.getSuppliers(),
        cashInDrawer: storage.calculateCurrentCashInDrawer(),
        cairoDateStr,
        salesReturns: storage.getSalesReturns(),
      });

      const isAllZeros =
        summaryPayload.salesTotal === 0 &&
        summaryPayload.invoiceCount === 0 &&
        summaryPayload.purchasesTotal === 0 &&
        summaryPayload.customerDebt === 0 &&
        summaryPayload.supplierDue === 0 &&
        summaryPayload.lowStockCount === 0 &&
        summaryPayload.cashInDrawer === 0;

      if (isAllZeros && !storage.hasLoadedData()) {
        this.syncState = 'idle';
        this.notifyListeners();
        return { success: false, error: 'data-not-loaded-or-all-zeros' };
      }

      const summaryRef = doc(
        db,
        'orgs',
        context.orgId,
        'branches',
        context.branchId,
        'dailySummaries',
        cairoDateStr
      );

      await setDoc(summaryRef, {
        ...summaryPayload,
        updatedAt: serverTimestamp(),
      });

      this.lastDailySummaryDate = new Date();
      this.lastDailySummaryPushMs = now;
      this.syncState = 'synced';
      this.notifyListeners();
      return { success: true };
    } catch (err: unknown) {
      return this.handleSyncError(err, 'pushDailySummary');
    }
  }

  // -------------------------------------------------------------------------
  // Subscription Pause and 6-hour Retry Handling
  // -------------------------------------------------------------------------
  public resetSubscriptionPause(): void {
    this.isSubPaused = false;
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
      this.permissionRetryTimer = null;
    }
    if (this.syncState === 'subscription-paused') {
      this.syncState = 'idle';
    }
    this.notifyListeners();
  }

  public schedulePermissionRetry(retryDelayMs: number = 6 * 60 * 60 * 1000): void {
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
    }
    this.permissionRetryTimer = setTimeout(() => {
      this.permissionRetryTimer = null;
      this.resetSubscriptionPause();
      this.sendHeartbeat().catch(() => {});
      this.pushDailySummary(false).catch(() => {});
    }, retryDelayMs);
  }

  // -------------------------------------------------------------------------
  // Error Handler: Handle permission-denied with 6-hour retry without cashier crashes
  // -------------------------------------------------------------------------
  private handleSyncError(err: unknown, op: string): { success: boolean; error: string } {
    const errObj = err as { code?: string; message?: string };
    const errCode = errObj.code || '';
    const errMessage = errObj.message || String(err);

    console.warn(`OrgSyncService [${op}] encountered issue:`, errMessage);

    if (errCode.includes('permission-denied') || errMessage.includes('permission-denied')) {
      this.isSubPaused = true;
      this.syncState = 'subscription-paused';
      this.statusMessage = 'تم إيقاف المزامنة السحابية: اشتراك المنشأة منتهٍ أو معلق. يرجى تجديد الاشتراك للمتابعة.';
      this.schedulePermissionRetry();
      this.notifyListeners();
      return { success: false, error: 'subscription-paused' };
    }

    if (errCode.includes('unavailable') || errMessage.includes('offline') || errCode.includes('network-request-failed')) {
      this.syncState = 'offline';
      this.notifyListeners();
      return { success: false, error: 'offline' };
    }

    this.syncState = 'error';
    this.statusMessage = `تعذر استكمال المزامنة السحابية مؤقتاً: ${errMessage}`;
    this.notifyListeners();
    return { success: false, error: errMessage };
  }

  // -------------------------------------------------------------------------
  // Getters for UI and Tests
  // -------------------------------------------------------------------------
  public getSyncState(): SyncState {
    return this.syncState;
  }

  public getLastHeartbeatDate(): Date | null {
    return this.lastHeartbeatDate;
  }

  public getLastDailySummaryDate(): Date | null {
    return this.lastDailySummaryDate;
  }

  public getStatusMessage(): string | null {
    return this.statusMessage;
  }

  public isSubscriptionPaused(): boolean {
    return this.isSubPaused;
  }

  public getRescheduleSummaryTimer(): ReturnType<typeof setTimeout> | null {
    return this.rescheduleSummaryTimer;
  }

  public getPermissionRetryTimer(): ReturnType<typeof setTimeout> | null {
    return this.permissionRetryTimer;
  }

  public setLastDailySummaryPushMs(timeMs: number): void {
    this.lastDailySummaryPushMs = timeMs;
  }

  public setSyncState(state: SyncState): void {
    this.syncState = state;
    this.notifyListeners();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
}

export const orgSyncService = new OrgSyncService();
