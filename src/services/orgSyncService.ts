import { doc, updateDoc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from 'firebase/auth';
import { db, auth, isCloudConfigured } from './cloudService';
import { translateFirebaseError } from './firebaseErrorTranslator';
import { licenseService } from './licenseService';
import { detectEnvironment } from './environmentService';
import { storage } from './storageService';
import { DailySummaryDoc } from '../types/cloud';
import { SalesInvoice, PurchaseInvoice, Product, Customer, Supplier, SalesReturn } from '../types';
import { APP_VERSION } from '../config/appConfig';

export const SUMMARY_DEBOUNCE_MS = 3000;
export const SUMMARY_MIN_INTERVAL_MS = 3000;

export type SyncState =
  | 'idle'
  | 'unconfigured'
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
// Pure Helper: Rate-Limiting Decision Logic
// Maximum 1 write per minIntervalMs (default 3 seconds), unless forceImmediate is true.
// ---------------------------------------------------------------------------
export function shouldPushSummary(
  currentTimeMs: number,
  lastPushTimeMs: number,
  minIntervalMs: number = SUMMARY_MIN_INTERVAL_MS,
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
  private lastError: string | null = null;
  private listeners: (() => void)[] = [];

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rescheduleSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private isSubPaused: boolean = false;
  private isRunning: boolean = false;
  private isPushInFlight: boolean = false;
  private pendingRescheduleAfterPush: boolean = false;
  private actionSeq: number = 0;
  private cleanupFns: (() => void)[] = [];

  constructor() {
    // Timers and network listeners do NOT auto-start in constructor.
    // They start exclusively via startService() after winning the single-tab lock and storage.init().
  }

  public isServiceRunning(): boolean {
    return this.isRunning;
  }

  public isSummaryDirty(): boolean {
    return storage.getSummaryDirty();
  }

  public startService(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.initListeners();
    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return;
    }
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      this.sendHeartbeat().catch(() => {});
      if (this.isSummaryDirty()) {
        this.pushDailySummary(true).catch(() => {});
      }
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
    this.pendingRescheduleAfterPush = false;
    this.cleanupFns.forEach(fn => {
      try { fn(); } catch {}
    });
    this.cleanupFns = [];
  }

  private initListeners() {
    if (typeof window !== 'undefined') {
      // Network reconnect listener
      const onOnline = () => {
        if (this.syncState === 'offline') {
          this.syncState = 'idle';
          this.notifyListeners();
        }
        this.sendHeartbeat().catch(() => {});
        if (this.isSummaryDirty()) {
          this.pushDailySummary(true).catch(() => {});
        }
      };
      window.addEventListener('online', onOnline);
      this.cleanupFns.push(() => window.removeEventListener('online', onOnline));

      const onOffline = () => {
        this.syncState = 'offline';
        this.notifyListeners();
      };
      window.addEventListener('offline', onOffline);
      this.cleanupFns.push(() => window.removeEventListener('offline', onOffline));
    }

    if (typeof document !== 'undefined') {
      // Page visibility change
      const onVisibility = () => {
        if (document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          this.sendHeartbeat().catch(() => {});
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanupFns.push(() => document.removeEventListener('visibilitychange', onVisibility));

      // 15-minute periodic heartbeat timer
      this.heartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          this.sendHeartbeat().catch(() => {});
        }
      }, 15 * 60 * 1000);
    }

    // Storage action listener: sets persistent summaryDirty=true in IndexedDB + schedules 3-second debounced summary write
    const unsubStorage = storage.onAction(() => {
      this.handleStorageAction();
    });
    this.cleanupFns.push(unsubStorage);

    // License change listener: resets subscription pause and flushes any pending dirty summary immediately
    const unsubLicense = licenseService.subscribe(() => {
      if (this.isSubPaused) {
        this.resetSubscriptionPause();
      }
      const hasValidCtx = this.getContext() !== null;
      if (hasValidCtx && isCloudConfigured && db && auth && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        this.sendHeartbeat().catch(() => {});
        if (this.isSummaryDirty()) {
          this.pushDailySummary(true).catch(() => {});
        }
      } else {
        this.notifyListeners();
      }
    });
    this.cleanupFns.push(unsubLicense);

    // Restore & observe persisted local Firebase Auth session ONLY if configured
    if (isCloudConfigured && auth) {
      try {
        const unsubAuth = onAuthStateChanged(auth, (user) => {
          const context = this.getContext();
          if (!user) {
            if (context && (this.syncState === 'synced' || this.syncState === 'wrong-account')) {
              this.syncState = 'needs-login';
            }
            this.notifyListeners();
            return;
          }

          if (context && user.uid !== context.orgId) {
            this.syncState = 'wrong-account';
            this.lastError = 'الحساب المسجّل لا يطابق معرّف المنشأة (orgId) في ترخيص الجهاز.';
            this.notifyListeners();
            return;
          }

          if (context && user.uid === context.orgId) {
            if (this.syncState === 'needs-login' || this.syncState === 'idle') {
              this.syncState = 'idle';
              this.lastError = null;
              this.notifyListeners();
            } else {
              this.notifyListeners();
            }
            if ((typeof navigator === 'undefined' || navigator.onLine !== false) && storage.isStorageReady()) {
              this.sendHeartbeat().catch(() => {});
              if (this.isSummaryDirty()) {
                this.pushDailySummary(true).catch(() => {});
              }
            }
          } else {
            this.notifyListeners();
          }
        });
        this.cleanupFns.push(unsubAuth);
      } catch {}
    }
  }

  public handleStorageAction(): void {
    this.actionSeq++;
    storage.setSummaryDirty(true);
    this.notifyListeners();

    if (this.isSubPaused) {
      return;
    }

    if (this.isPushInFlight) {
      // Never overlap writes: mark to schedule a final trailing push once in-flight write completes
      this.pendingRescheduleAfterPush = true;
      return;
    }

    this.scheduleDebouncedDailySummary();
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

    const currentUser = auth?.currentUser || null;
    if (!currentUser) {
      return 'needs-login';
    }

    if (currentUser.uid !== context.orgId) {
      return 'wrong-account';
    }

    return 'ok';
  }

  // -------------------------------------------------------------------------
  // 3. Store Login with signInWithEmailAndPassword ONLY (never stores password)
  // -------------------------------------------------------------------------
  public async signInStore(email: string, pass: string): Promise<{ success: boolean; error?: string }> {
    if (!isCloudConfigured || !auth) {
      const msg = 'السحابة غير مُعدّة بعد. يرجى إدخال إعدادات Firebase أولاً.';
      this.syncState = 'unconfigured';
      this.lastError = msg;
      this.notifyListeners();
      return { success: false, error: msg };
    }

    const cleanEmail = email.trim();
    if (!cleanEmail || !pass) {
      return { success: false, error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور.' };
    }

    const context = this.getContext();
    if (!context) {
      const msg = 'لا يوجد ترخيص سارٍ على هذا الجهاز لتحديد معرّف المنشأة (orgId) والفرع (branchId).';
      this.lastError = msg;
      return { success: false, error: msg };
    }

    try {
      this.syncState = 'syncing';
      this.lastError = null;
      this.notifyListeners();

      // Reset subscription pause on any new sign-in attempt
      this.resetSubscriptionPause();

      // STRICT REQUIREMENT: signInWithEmailAndPassword ONLY for store sync login. Password is never persisted.
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, pass);
      const user = cred.user;

      // Verify that logged-in user UID matches the orgId in active license
      if (user.uid !== context.orgId) {
        try {
          await fbSignOut(auth);
        } catch {}
        const mismatchMsg = 'هذا الحساب لا يطابق ترخيص الجهاز (معرّف المنشأة orgId غير متطابق).';
        this.syncState = 'wrong-account';
        this.statusMessage = mismatchMsg;
        this.lastError = mismatchMsg;
        this.notifyListeners();
        return { success: false, error: mismatchMsg };
      }

      this.syncState = 'synced';
      this.statusMessage = 'تم تسجيل دخول المحل للمزامنة بنجاح.';
      this.lastError = null;
      this.notifyListeners();

      // Trigger initial heartbeat and summary (especially if summaryDirty is true)
      this.sendHeartbeat().catch(() => {});
      this.pushDailySummary(true).catch(() => {});

      return { success: true };
    } catch (err: unknown) {
      const errorMsg = translateFirebaseError(err);
      this.syncState = 'error';
      this.statusMessage = errorMsg;
      this.lastError = errorMsg;
      this.notifyListeners();
      return { success: false, error: errorMsg };
    }
  }

  public async signOutStore(): Promise<void> {
    try {
      if (isCloudConfigured && auth) {
        await fbSignOut(auth);
      }
    } catch {}
    this.syncState = isCloudConfigured ? 'needs-login' : 'unconfigured';
    this.statusMessage = null;
    this.lastError = null;
    this.notifyListeners();
  }

  // -------------------------------------------------------------------------
  // 4. sendHeartbeat(): updateDoc with serverTimestamp() + clock reconcile
  // -------------------------------------------------------------------------
  public async sendHeartbeat(): Promise<{ success: boolean; error?: string }> {
    if (!storage.isStorageReady()) return { success: false, error: 'storage-not-ready' };
    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.isSubPaused) return { success: false, error: 'subscription-paused' };

    const context = this.getContext();
    if (!context) {
      this.syncState = 'no-license';
      this.notifyListeners();
      return { success: false, error: 'لا يوجد ترخيص سارٍ لتحديد المحل والفرع.' };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.syncState = 'offline';
      this.notifyListeners();
      return { success: false, error: 'لا يوجد اتصال بالإنترنت حالياً.' };
    }

    const authCheck = this.ensureSignedIn();
    if (authCheck !== 'ok') {
      this.syncState = authCheck;
      this.notifyListeners();
      return {
        success: false,
        error:
          authCheck === 'wrong-account'
            ? 'الحساب المسجّل لا يطابق ترخيص الجهاز (orgId).'
            : 'يجب تسجيل دخول المحل للمزامنة أولاً.',
      };
    }

    try {
      const env = detectEnvironment();
      const branchRef = doc(db, 'orgs', context.orgId, 'branches', context.branchId);

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
      this.lastError = null;
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
  // 4b. Manual single-heartbeat test ("اختبار الاتصال")
  // -------------------------------------------------------------------------
  public async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (!isCloudConfigured || !db || !auth) {
        const msg = 'السحابة غير مُعدّة بعد.';
        this.syncState = 'unconfigured';
        this.lastError = msg;
        this.notifyListeners();
        return { success: false, message: msg };
      }

      if (this.isSubPaused) {
        this.resetSubscriptionPause();
      }

      const res = await this.sendHeartbeat();
      if (res.success) {
        if (this.isSummaryDirty()) {
          this.pushDailySummary(true).catch(() => {});
        }
        return {
          success: true,
          message: 'نجح الاتصال بالسحابة وتم إرسال نبضة الفرع بنجاح ✓',
        };
      }

      return {
        success: false,
        message: this.lastError || res.error || 'فشل الاتصال بالسحابة.',
      };
    } catch (err: unknown) {
      const msg = translateFirebaseError(err);
      this.lastError = msg;
      this.notifyListeners();
      return { success: false, message: msg };
    }
  }

  // -------------------------------------------------------------------------
  // 5. pushDailySummary(): 3-second debounce batching + max 1 write / 3s + no overlap
  // -------------------------------------------------------------------------
  private scheduleDebouncedDailySummary() {
    if (this.isSubPaused) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pushDailySummary(false).catch(() => {});
    }, SUMMARY_DEBOUNCE_MS);
  }

  public async pushDailySummary(forceImmediate: boolean = false): Promise<{ success: boolean; error?: string }> {
    if (!storage.isStorageReady()) return { success: false, error: 'storage-not-ready' };
    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.isSubPaused) return { success: false, error: 'subscription-paused' };

    const context = this.getContext();
    if (!context) {
      this.syncState = 'no-license';
      this.notifyListeners();
      return { success: false, error: 'no-valid-license' };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
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

    // Prevent overlapping writes: if a write is currently in progress, queue a trailing write
    if (this.isPushInFlight) {
      this.pendingRescheduleAfterPush = true;
      return { success: true };
    }

    // Protection rate-limit: maximum 1 write every 3 seconds unless forceImmediate is true
    const now = Date.now();
    if (!shouldPushSummary(now, this.lastDailySummaryPushMs, SUMMARY_MIN_INTERVAL_MS, forceImmediate)) {
      const elapsed = now - this.lastDailySummaryPushMs;
      const remainingMs = Math.max(50, SUMMARY_MIN_INTERVAL_MS - elapsed);
      if (this.rescheduleSummaryTimer) {
        clearTimeout(this.rescheduleSummaryTimer);
      }
      this.rescheduleSummaryTimer = setTimeout(() => {
        this.rescheduleSummaryTimer = null;
        this.pushDailySummary(false).catch(() => {});
      }, remainingMs);

      return { success: true };
    }

    if (this.rescheduleSummaryTimer) {
      clearTimeout(this.rescheduleSummaryTimer);
      this.rescheduleSummaryTimer = null;
    }

    this.isPushInFlight = true;
    const capturedSeq = this.actionSeq;

    try {
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
      this.lastDailySummaryPushMs = Date.now();
      this.lastError = null;
      this.syncState = 'synced';

      // Clear summaryDirty ONLY if no newer action arrived while setDoc was in flight
      if (this.actionSeq === capturedSeq) {
        storage.setSummaryDirty(false);
      } else {
        this.pendingRescheduleAfterPush = true;
      }

      this.notifyListeners();
      return { success: true };
    } catch (err: unknown) {
      // summaryDirty stays true on any write error so it retries when resolved
      return this.handleSyncError(err, 'pushDailySummary');
    } finally {
      this.isPushInFlight = false;
      if (this.pendingRescheduleAfterPush) {
        this.pendingRescheduleAfterPush = false;
        this.scheduleDebouncedDailySummary();
      }
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
    const errCode = (errObj?.code || '').toLowerCase();
    const errMessage = (errObj?.message || String(err)).toLowerCase();
    const translated = translateFirebaseError(err);

    console.warn(`OrgSyncService [${op}] encountered issue:`, errObj?.message || String(err));

    if (errCode.includes('permission-denied') || errMessage.includes('permission-denied') || errMessage.includes('insufficient permissions')) {
      this.isSubPaused = true;
      this.syncState = 'subscription-paused';
      this.statusMessage = translated;
      this.lastError = translated;
      this.schedulePermissionRetry();
      this.notifyListeners();
      return { success: false, error: translated };
    }

    if (errCode.includes('unavailable') || errMessage.includes('offline') || errCode.includes('network-request-failed') || errMessage.includes('unavailable')) {
      this.syncState = 'offline';
      this.statusMessage = translated;
      this.lastError = translated;
      this.notifyListeners();
      return { success: false, error: translated };
    }

    this.syncState = 'error';
    this.statusMessage = translated;
    this.lastError = translated;
    this.notifyListeners();
    return { success: false, error: translated };
  }

  // -------------------------------------------------------------------------
  // Getters & Test Helpers
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

  public getLastError(): string | null {
    return this.lastError;
  }

  public isSubscriptionPaused(): boolean {
    return this.isSubPaused;
  }

  public getRescheduleSummaryTimer(): ReturnType<typeof setTimeout> | null {
    return this.rescheduleSummaryTimer;
  }

  public getDebounceTimer(): ReturnType<typeof setTimeout> | null {
    return this.debounceTimer;
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

  public resetForTesting(): void {
    this.stopService();
    this.syncState = 'idle';
    this.lastHeartbeatDate = null;
    this.lastDailySummaryDate = null;
    this.lastDailySummaryPushMs = 0;
    this.statusMessage = null;
    this.lastError = null;
    this.isSubPaused = false;
    this.isPushInFlight = false;
    this.pendingRescheduleAfterPush = false;
    this.actionSeq = 0;
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
