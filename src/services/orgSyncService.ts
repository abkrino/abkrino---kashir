import { doc, serverTimestamp } from 'firebase/firestore';
import { signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from 'firebase/auth';
import { db, auth, isCloudConfigured } from './cloudService';
import { translateFirebaseError } from './firebaseErrorTranslator';
import { licenseService, LicenseStateResult } from './licenseService';
import { detectEnvironment } from './environmentService';
import { storage } from './storageService';
import { DailySummaryDoc } from '../types/cloud';
import { SalesInvoice, PurchaseInvoice, Product, Customer, Supplier, SalesReturn } from '../types';
import { APP_VERSION } from '../config/appConfig';
import {
  cloudBudgetService,
  BUDGET_EXCEEDED_MESSAGE_AR,
  SIX_HOUR_PAUSE_MS,
  ERROR_BACKOFF_STEPS_MS,
  computeBackoffDelayMs,
  isSixHourPauseError,
  isBudgetExceededError,
  getMsUntilNextCairoMidnight,
} from './cloudBudgetService';

export const SUMMARY_DEBOUNCE_MS = 15000;
export const SUMMARY_MIN_INTERVAL_MS = 15000;
export const HEARTBEAT_MIN_INTERVAL_MS = 60000;
export const CLOCK_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const LAST_SYNCED_SUMMARY_SIG_KEY = 'sm_last_synced_summary_sig_v1';

export type SyncState =
  | 'idle'
  | 'unconfigured'
  | 'syncing'
  | 'synced'
  | 'needs-login'
  | 'wrong-account'
  | 'subscription-paused'
  | 'budget-paused'
  | 'offline'
  | 'no-license'
  | 'error';

export type HeartbeatReason =
  | 'startup'
  | 'license-change'
  | 'sign-in'
  | 'manual'
  | 'periodic'
  | 'online'
  | 'visibility';

export interface HeartbeatOptions {
  force?: boolean;
  reason?: HeartbeatReason;
}

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
// Pure Helper: Compute Effective License Fingerprint
// Ignores volatile fields (daysRemaining, clockWarning, message)
// ---------------------------------------------------------------------------
export function computeEffectiveLicenseFingerprint(licState: LicenseStateResult): string {
  const payload = licState?.payload as (LicenseStateResult['payload'] & { features?: unknown }) | null | undefined;
  const isOperational =
    (licState?.status === 'valid' || licState?.status === 'grace') &&
    Boolean(payload?.orgId && payload?.branchId);

  if (!isOperational || !payload) {
    return `inactive:${licState?.status ?? 'unlicensed'}`;
  }

  return JSON.stringify({
    status: licState.status,
    orgId: payload.orgId,
    branchId: payload.branchId,
    validUntil: payload.validUntil,
    features: payload.features ?? null,
  });
}

// ---------------------------------------------------------------------------
// Pure Helper: Deterministic Daily Summary Payload Signature (without updatedAt)
// ---------------------------------------------------------------------------
export function computeDailySummarySignature(payload: Omit<DailySummaryDoc, 'updatedAt'>): string {
  return JSON.stringify({
    yyyyMMdd: payload.yyyyMMdd,
    salesTotal: payload.salesTotal,
    invoiceCount: payload.invoiceCount,
    cashInDrawer: payload.cashInDrawer,
    purchasesTotal: payload.purchasesTotal,
    customerDebt: payload.customerDebt,
    supplierDue: payload.supplierDue,
    lowStockCount: payload.lowStockCount,
  });
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
// Maximum 1 write per minIntervalMs (default 15 seconds), unless forceImmediate is true.
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
  private lastHeartbeatAttemptMs: number = 0;
  private lastClockReconcileMs: number = 0;
  private isHeartbeatInFlight: boolean = false;
  private lastDailySummaryDate: Date | null = null;
  private lastDailySummaryPushMs: number = 0;
  private lastSuccessfulSummarySig: string | null = null;
  private statusMessage: string | null = null;
  private lastError: string | null = null;
  private listeners: (() => void)[] = [];
  private signInListeners: (() => void)[] = [];
  private licenseChangeListeners: (() => void)[] = [];

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rescheduleSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private budgetResumeTimer: ReturnType<typeof setTimeout> | null = null;

  private isSubPaused: boolean = false;
  private backoffStep: number = 0;
  private backoffUntilMs: number = 0;
  private isRunning: boolean = false;
  private isPushInFlight: boolean = false;
  private pendingRescheduleAfterPush: boolean = false;
  private actionSeq: number = 0;
  private lastProcessedLicenseFingerprint: string | null = null;
  private lastSeenAuthUid: string | null = null;
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
    this.lastProcessedLicenseFingerprint = computeEffectiveLicenseFingerprint(
      licenseService.getLicenseState()
    );
    this.lastSeenAuthUid = auth?.currentUser?.uid || null;
    this.initListeners();

    // Hydrate persisted daily budget usage from IndexedDB (non-blocking)
    cloudBudgetService.init().catch(() => {});

    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return;
    }

    if (cloudBudgetService.isExceeded()) {
      this.enterBudgetPaused();
      return;
    }

    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      this.sendHeartbeat({ reason: 'startup', force: true }).catch(() => {});
      if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
        this.pushDailySummary(true).catch(() => {});
      }
    }
  }

  public stopService(): void {
    this.isRunning = false;
    this.isHeartbeatInFlight = false;
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
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.budgetResumeTimer) {
      clearTimeout(this.budgetResumeTimer);
      this.budgetResumeTimer = null;
    }
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
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
        if (this.syncState === 'budget-paused' && !cloudBudgetService.isExceeded()) {
          this.resumeFromBudgetPause();
        }
        this.sendHeartbeat({ reason: 'online' }).catch(() => {});
        if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
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

      // Immediate flush on pagehide before browser unloads page
      const onPageHide = () => {
        if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
          this.pushDailySummary(true).catch(() => {});
        }
      };
      window.addEventListener('pagehide', onPageHide);
      this.cleanupFns.push(() => window.removeEventListener('pagehide', onPageHide));
    }

    if (typeof document !== 'undefined') {
      // Page visibility change: flush dirty summary immediately on hidden; heartbeat on visible
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
            this.pushDailySummary(true).catch(() => {});
          }
          return;
        }
        if (document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          if (this.syncState === 'budget-paused' && !cloudBudgetService.isExceeded()) {
            this.resumeFromBudgetPause();
          }
          this.sendHeartbeat({ reason: 'visibility' }).catch(() => {});
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanupFns.push(() => document.removeEventListener('visibilitychange', onVisibility));

      // 15-minute periodic heartbeat timer
      this.heartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          if (this.syncState === 'budget-paused' && !cloudBudgetService.isExceeded()) {
            this.resumeFromBudgetPause();
          }
          this.sendHeartbeat({ reason: 'periodic' }).catch(() => {});
        }
      }, 15 * 60 * 1000);
    }

    // Core business data change listener in storageService.setItem():
    // Automatically sets summaryDirty=true and schedules 15-second debounced summary write.
    const unsubSummaryData = storage.onSummaryDataChange(() => {
      this.handleSummaryDataChange();
    });
    this.cleanupFns.push(unsubSummaryData);

    // Action listener for explicit shift closure immediate flush ONLY (no duplicate scheduling)
    const unsubAction = storage.onAction((actionName) => {
      if (actionName === 'SHIFT_CLOSED') {
        this.pushDailySummary(true).catch(() => {});
      }
    });
    this.cleanupFns.push(unsubAction);

    // Budget rollover listener: auto-resume when Cairo day changes
    const unsubBudget = cloudBudgetService.subscribe(() => {
      if (this.syncState === 'budget-paused' && !cloudBudgetService.isExceeded()) {
        this.resumeFromBudgetPause();
      }
    });
    this.cleanupFns.push(unsubBudget);

    // License change listener: strictly reacts ONLY when effective license fingerprint changes!
    const unsubLicense = licenseService.subscribe(() => {
      const nextFingerprint = computeEffectiveLicenseFingerprint(
        licenseService.getLicenseState()
      );
      if (nextFingerprint === this.lastProcessedLicenseFingerprint) {
        // Ignore all redundant license notifications (e.g. from clock reconciliation or unrelated refreshes)
        return;
      }
      this.lastProcessedLicenseFingerprint = nextFingerprint;

      if (this.isSubPaused) {
        this.resetSubscriptionPause();
      }
      this.resetBackoff();

      this.notifyLicenseChangeListeners();

      const hasValidCtx = this.getContext() !== null;
      const storedCtx = this.getStoredLicenseContext();
      if ((hasValidCtx || storedCtx?.isExpired) && isCloudConfigured && db && auth && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        this.sendHeartbeat({ reason: 'license-change', force: true }).catch(() => {});
        if (hasValidCtx && this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
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
          const nextUid = user?.uid || null;
          const prevUid = this.lastSeenAuthUid;
          this.lastSeenAuthUid = nextUid;
          const context = this.getContext();
          const storedContext = this.getStoredLicenseContext();
          const matchContext = context || storedContext;

          if (!user) {
            if (matchContext && (this.syncState === 'synced' || this.syncState === 'wrong-account')) {
              this.syncState = 'needs-login';
            }
            this.notifyListeners();
            return;
          }

          if (matchContext && user.uid !== matchContext.orgId) {
            this.syncState = 'wrong-account';
            this.lastError = 'الحساب المسجّل لا يطابق معرّف المنشأة (orgId) في ترخيص الجهاز.';
            this.notifyListeners();
            return;
          }

          if (matchContext && user.uid === matchContext.orgId) {
            if (this.syncState === 'needs-login' || this.syncState === 'idle') {
              this.syncState = 'idle';
              this.lastError = null;
            }
            this.notifyListeners();

            // Only trigger sign-in heartbeat & daily backup check if this is an auth transition (null -> uid)
            if (prevUid !== nextUid) {
              this.resetSubscriptionPause();
              this.resetBackoff();
              this.notifySignInListeners();
              if ((typeof navigator === 'undefined' || navigator.onLine !== false) && storage.isStorageReady()) {
                this.sendHeartbeat({ reason: 'sign-in', force: true }).catch(() => {});
                if (context && this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
                  this.pushDailySummary(true).catch(() => {});
                }
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

  public isCloudSummaryFeatureEnabled(): boolean {
    return typeof licenseService.isFeatureEnabled === 'function'
      ? licenseService.isFeatureEnabled('cloudSummary')
      : true;
  }

  public handleSummaryDataChange(): void {
    if (!this.isCloudSummaryFeatureEnabled()) {
      return;
    }
    this.actionSeq++;
    storage.setSummaryDirty(true);
    this.notifyListeners();

    if (this.isSubPaused || this.syncState === 'budget-paused' || this.isBackoffActive()) {
      return;
    }

    if (this.isPushInFlight) {
      // Never overlap writes: mark to schedule a final trailing push once in-flight write completes
      this.pendingRescheduleAfterPush = true;
      return;
    }

    this.scheduleDebouncedDailySummary();
  }

  public handleStorageAction(): void {
    this.handleSummaryDataChange();
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

  // Returns stored license orgId/branchId even when license is expired (used for cloud restore & online token renewal)
  public getStoredLicenseContext(): { orgId: string; branchId: string; mode: 'offline' | 'online'; isExpired: boolean } | null {
    const active = this.getContext();
    if (active) {
      return { ...active, isExpired: false };
    }
    const licState = licenseService.getLicenseState();
    if (licState.status === 'expired' && licState.payload) {
      if (licState.payload.orgId && licState.payload.branchId) {
        return {
          orgId: licState.payload.orgId,
          branchId: licState.payload.branchId,
          mode: licState.payload.mode || 'offline',
          isExpired: true,
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 2. ensureSignedIn(): Validates auth.currentUser.uid == orgId
  // -------------------------------------------------------------------------
  public ensureSignedIn(options?: { allowExpired?: boolean }): 'ok' | 'needs-login' | 'wrong-account' {
    const context = options?.allowExpired ? this.getStoredLicenseContext() : this.getContext();
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

    const context = this.getStoredLicenseContext();
    if (!context) {
      const msg = 'لا يوجد ترخيص مثبّت على هذا الجهاز لتحديد معرّف المنشأة والفرع.';
      this.lastError = msg;
      return { success: false, error: msg };
    }

    try {
      this.syncState = 'syncing';
      this.lastError = null;
      this.notifyListeners();

      // Reset pause and error backoff on any new sign-in attempt
      this.resetSubscriptionPause();
      this.resetBackoff();

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

      this.lastSeenAuthUid = user.uid;
      this.syncState = 'synced';
      this.statusMessage = 'تم تسجيل دخول المحل للمزامنة بنجاح.';
      this.lastError = null;
      this.notifyListeners();
      this.notifySignInListeners();

      // Trigger initial heartbeat/token check and summary (especially if summaryDirty is true)
      this.sendHeartbeat({ reason: 'sign-in', force: true }).catch(() => {});
      if (!context.isExpired && this.isCloudSummaryFeatureEnabled()) {
        this.pushDailySummary(true).catch(() => {});
      }

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
    // Requirement 4c: Flush dirty daily summary BEFORE signing out Firebase Auth
    if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
      await this.pushDailySummary(true).catch(() => {});
    }
    try {
      if (isCloudConfigured && auth) {
        await fbSignOut(auth);
      }
    } catch {}
    this.lastSeenAuthUid = null;
    this.syncState = isCloudConfigured ? 'needs-login' : 'unconfigured';
    this.statusMessage = null;
    this.lastError = null;
    this.notifyListeners();
  }

  // -------------------------------------------------------------------------
  // 4. sendHeartbeat(): Single-flight + 60s min interval + 6h clock reconcile + Circuit Breaker
  // -------------------------------------------------------------------------
  public async sendHeartbeat(options?: HeartbeatOptions): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
    const reason: HeartbeatReason = options?.reason || 'periodic';
    const bypassCooldown =
      Boolean(options?.force) ||
      reason === 'startup' ||
      reason === 'license-change' ||
      reason === 'sign-in' ||
      reason === 'manual';

    if (this.isHeartbeatInFlight) {
      return { success: false, skipped: true, error: 'heartbeat-in-flight' };
    }
    if (!storage.isStorageReady()) return { success: false, skipped: true, error: 'storage-not-ready' };
    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.isSubPaused) return { success: false, skipped: true, error: 'subscription-paused' };

    if (cloudBudgetService.isExceeded()) {
      this.enterBudgetPaused();
      return { success: false, skipped: true, error: BUDGET_EXCEEDED_MESSAGE_AR };
    }

    if (!bypassCooldown && this.isBackoffActive()) {
      return { success: false, skipped: true, error: 'backoff-active' };
    }

    const now = Date.now();
    if (!bypassCooldown && this.lastHeartbeatAttemptMs > 0 && (now - this.lastHeartbeatAttemptMs) < HEARTBEAT_MIN_INTERVAL_MS) {
      return { success: false, skipped: true, error: 'heartbeat-cooldown' };
    }

    const context = this.getContext();
    const storedContext = context ? null : this.getStoredLicenseContext();

    if (!context && !storedContext?.isExpired) {
      this.syncState = 'no-license';
      this.notifyListeners();
      return { success: false, error: 'لا يوجد ترخيص سارٍ لتحديد المحل والفرع.' };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.syncState = 'offline';
      this.notifyListeners();
      return { success: false, error: 'لا يوجد اتصال بالإنترنت حالياً.' };
    }

    const authCheck = this.ensureSignedIn({ allowExpired: Boolean(storedContext?.isExpired) });
    if (authCheck !== 'ok') {
      this.syncState = authCheck;
      this.notifyListeners();
      return {
        success: false,
        error:
          authCheck === 'wrong-account'
            ? 'الحساب المسجّل لا يطابق ترخيص الجهاز.'
            : 'يجب تسجيل دخول المحل للمزامنة أولاً.',
      };
    }

    // If license is EXPIRED, do NOT write heartbeats; perform read-only branch check only at startup / 6h / manual / sign-in
    // to detect whether a newly signed licenseToken was deployed to the branch document.
    if (!context && storedContext?.isExpired) {
      const shouldCheckExpiredToken =
        this.lastClockReconcileMs === 0 ||
        (now - this.lastClockReconcileMs) >= CLOCK_RECONCILE_INTERVAL_MS ||
        reason === 'manual' ||
        reason === 'sign-in';

      if (!shouldCheckExpiredToken) {
        return { success: false, skipped: true, error: 'انتهى اشتراك البرنامج.' };
      }

      this.isHeartbeatInFlight = true;
      this.lastHeartbeatAttemptMs = now;
      try {
        const branchRef = doc(db, 'orgs', storedContext.orgId, 'branches', storedContext.branchId);
        const branchSnap = await cloudBudgetService.budgetedGetDoc(branchRef);
        this.lastClockReconcileMs = Date.now();
        if (branchSnap.exists()) {
          const branchData = branchSnap.data();
          if (
            typeof branchData?.licenseToken === 'string' &&
            branchData.licenseToken.trim().length > 0 &&
            typeof licenseService.tryAutoInstallBranchToken === 'function'
          ) {
            const installRes = await licenseService.tryAutoInstallBranchToken(branchData.licenseToken.trim());
            if (installRes.updated) {
              this.lastError = null;
              this.statusMessage = 'تم تحديث وتجديد الترخيص تلقائياً من السحابة.';
              this.syncState = 'synced';
              this.notifyListeners();
              return { success: true };
            }
          }
        }
        return { success: false, error: 'انتهى اشتراك البرنامج.' };
      } catch (err: unknown) {
        return this.handleSyncError(err, 'sendHeartbeat:expiredTokenCheck');
      } finally {
        this.isHeartbeatInFlight = false;
      }
    }

    const activeCtx = context!;
    this.isHeartbeatInFlight = true;
    this.lastHeartbeatAttemptMs = now;

    try {
      const env = detectEnvironment();
      const branchRef = doc(db, 'orgs', activeCtx.orgId, 'branches', activeCtx.branchId);

      await cloudBudgetService.budgetedUpdateDoc(branchRef, {
        lastSeenAt: serverTimestamp(),
        appVersion: APP_VERSION,
        windowsVersion: env.windowsVersion,
        mode: activeCtx.mode,
      });

      this.resetBackoff();

      // Reconcile clock ONLY at startup (lastClockReconcileMs === 0) or every 6 hours
      // Piggyback branchDoc.licenseToken auto-renewal check on the SAME read (zero extra reads).
      const nowAfterWrite = Date.now();
      const shouldReconcileClock =
        this.lastClockReconcileMs === 0 ||
        (nowAfterWrite - this.lastClockReconcileMs) >= CLOCK_RECONCILE_INTERVAL_MS;

      if (shouldReconcileClock) {
        try {
          const branchSnap = await cloudBudgetService.budgetedGetDoc(branchRef);
          this.lastClockReconcileMs = Date.now();
          if (branchSnap.exists()) {
            const branchData = branchSnap.data();
            if (
              typeof branchData?.licenseToken === 'string' &&
              branchData.licenseToken.trim().length > 0 &&
              typeof licenseService.tryAutoInstallBranchToken === 'function'
            ) {
              await licenseService.tryAutoInstallBranchToken(branchData.licenseToken.trim()).catch(() => {});
            }
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
          if (isBudgetExceededError(clockErr)) {
            this.enterBudgetPaused();
            return { success: false, error: BUDGET_EXCEEDED_MESSAGE_AR };
          }
          console.warn('Clock reconciliation read error:', clockErr);
        }
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
    } finally {
      this.isHeartbeatInFlight = false;
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
      this.resetBackoff();

      const res = await this.sendHeartbeat({ force: true, reason: 'manual' });
      if (res.success) {
        if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
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
  // 5. pushDailySummary(): 15-second debounce + max 1 write / 15s + no overlap + deduplication
  // -------------------------------------------------------------------------
  private getLastSyncedSignature(): string | null {
    if (this.lastSuccessfulSummarySig) return this.lastSuccessfulSummarySig;
    if (typeof localStorage !== 'undefined') {
      try {
        return localStorage.getItem(LAST_SYNCED_SUMMARY_SIG_KEY);
      } catch {
        return null;
      }
    }
    return null;
  }

  private saveLastSyncedSignature(sig: string): void {
    this.lastSuccessfulSummarySig = sig;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LAST_SYNCED_SUMMARY_SIG_KEY, sig);
      } catch {}
    }
  }

  private clearLastSyncedSignature(): void {
    this.lastSuccessfulSummarySig = null;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(LAST_SYNCED_SUMMARY_SIG_KEY);
      } catch {}
    }
  }

  private scheduleDebouncedDailySummary() {
    if (this.isSubPaused || this.syncState === 'budget-paused' || this.isBackoffActive()) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pushDailySummary(false).catch(() => {});
    }, SUMMARY_DEBOUNCE_MS);
  }

  public async pushDailySummary(forceImmediate: boolean = false): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
    if (!storage.isStorageReady()) return { success: false, error: 'storage-not-ready' };
    if (!this.isCloudSummaryFeatureEnabled()) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      if (this.rescheduleSummaryTimer) {
        clearTimeout(this.rescheduleSummaryTimer);
        this.rescheduleSummaryTimer = null;
      }
      return {
        success: false,
        skipped: true,
        error: 'ميزة الملخص السحابي غير مضمّنة في باقتك.',
      };
    }
    if (!isCloudConfigured || !db || !auth) {
      this.syncState = 'unconfigured';
      this.notifyListeners();
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.isSubPaused) return { success: false, error: 'subscription-paused' };

    if (cloudBudgetService.isExceeded()) {
      this.enterBudgetPaused();
      return { success: false, skipped: true, error: BUDGET_EXCEEDED_MESSAGE_AR };
    }

    if (!forceImmediate && this.isBackoffActive()) {
      return { success: false, skipped: true, error: 'backoff-active' };
    }

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

    if (forceImmediate && this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Prevent overlapping writes: if a write is currently in progress, queue a trailing write
    if (this.isPushInFlight) {
      this.pendingRescheduleAfterPush = true;
      return { success: true };
    }

    // Protection rate-limit: maximum 1 write every 15 seconds unless forceImmediate is true
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

      // Requirement 4d: Payload deduplication (excluding updatedAt)
      const scopedSig = `${context.orgId}:${context.branchId}:${computeDailySummarySignature(summaryPayload)}`;
      if (this.getLastSyncedSignature() === scopedSig) {
        if (this.actionSeq === capturedSeq) {
          storage.setSummaryDirty(false);
        } else {
          this.pendingRescheduleAfterPush = true;
        }
        this.lastError = null;
        this.syncState = 'synced';
        this.notifyListeners();
        return { success: true, skipped: true };
      }

      this.syncState = 'syncing';
      this.notifyListeners();

      const summaryRef = doc(
        db,
        'orgs',
        context.orgId,
        'branches',
        context.branchId,
        'dailySummaries',
        cairoDateStr
      );

      await cloudBudgetService.budgetedSetDoc(summaryRef, {
        ...summaryPayload,
        updatedAt: serverTimestamp(),
      });

      this.saveLastSyncedSignature(scopedSig);
      this.lastDailySummaryDate = new Date();
      this.lastDailySummaryPushMs = Date.now();
      this.lastError = null;
      this.syncState = 'synced';
      this.resetBackoff();

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
  // Budget Circuit Breaker Pause & Cairo Midnight Auto-Resume
  // -------------------------------------------------------------------------
  private enterBudgetPaused(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.rescheduleSummaryTimer) {
      clearTimeout(this.rescheduleSummaryTimer);
      this.rescheduleSummaryTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.pendingRescheduleAfterPush = false;
    this.syncState = 'budget-paused';
    this.statusMessage = BUDGET_EXCEEDED_MESSAGE_AR;
    this.lastError = BUDGET_EXCEEDED_MESSAGE_AR;
    this.scheduleBudgetMidnightResume();
    this.notifyListeners();
  }

  private scheduleBudgetMidnightResume(): void {
    if (this.budgetResumeTimer) {
      clearTimeout(this.budgetResumeTimer);
    }
    const msUntilMidnight = getMsUntilNextCairoMidnight(new Date());
    this.budgetResumeTimer = setTimeout(() => {
      this.budgetResumeTimer = null;
      // Checking getUsage() rolls over if Cairo calendar date changed
      cloudBudgetService.getUsage();
      if (!cloudBudgetService.isExceeded()) {
        this.resumeFromBudgetPause();
      } else {
        this.scheduleBudgetMidnightResume();
      }
    }, msUntilMidnight);
  }

  private resumeFromBudgetPause(): void {
    if (this.budgetResumeTimer) {
      clearTimeout(this.budgetResumeTimer);
      this.budgetResumeTimer = null;
    }
    if (this.syncState === 'budget-paused') {
      this.syncState = 'idle';
      this.statusMessage = null;
      this.lastError = null;
      this.notifyListeners();
      if (this.isRunning && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        this.sendHeartbeat({ reason: 'periodic' }).catch(() => {});
        if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
          this.pushDailySummary(true).catch(() => {});
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Subscription / Quota Pause (6h) and Exponential Error Backoff (30s..30m)
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

  public schedulePermissionRetry(retryDelayMs: number = SIX_HOUR_PAUSE_MS): void {
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
    }
    this.permissionRetryTimer = setTimeout(() => {
      this.permissionRetryTimer = null;
      this.resetSubscriptionPause();
      this.sendHeartbeat({ reason: 'periodic' }).catch(() => {});
      if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
        this.pushDailySummary(false).catch(() => {});
      }
    }, retryDelayMs);
  }

  public isBackoffActive(): boolean {
    return this.backoffUntilMs > Date.now();
  }

  public getBackoffStep(): number {
    return this.backoffStep;
  }

  public getBackoffUntilMs(): number {
    return this.backoffUntilMs;
  }

  public getBackoffTimer(): ReturnType<typeof setTimeout> | null {
    return this.backoffTimer;
  }

  private resetBackoff(): void {
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private scheduleErrorBackoff(): number {
    const delayMs = computeBackoffDelayMs(this.backoffStep);
    this.backoffStep = Math.min(this.backoffStep + 1, ERROR_BACKOFF_STEPS_MS.length - 1);
    this.backoffUntilMs = Date.now() + delayMs;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
    }
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.backoffUntilMs = 0;
      if (!this.isRunning || this.isSubPaused || this.syncState === 'budget-paused') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      this.sendHeartbeat({ reason: 'periodic' }).catch(() => {});
      if (this.isSummaryDirty() && this.isCloudSummaryFeatureEnabled()) {
        this.pushDailySummary(false).catch(() => {});
      }
    }, delayMs);
    return delayMs;
  }

  // -------------------------------------------------------------------------
  // Unified Error Handler
  // -------------------------------------------------------------------------
  private handleSyncError(err: unknown, op: string): { success: boolean; error: string } {
    if (isBudgetExceededError(err)) {
      this.enterBudgetPaused();
      return { success: false, error: BUDGET_EXCEEDED_MESSAGE_AR };
    }

    const errObj = err as { code?: string; message?: string };
    const errCode = (errObj?.code || '').toLowerCase();
    const errMessage = (errObj?.message || String(err)).toLowerCase();
    const translated = translateFirebaseError(err);

    console.warn(`OrgSyncService [${op}] encountered issue:`, errObj?.message || String(err));

    // permission-denied & resource-exhausted -> 6h pause with NO immediate retry
    if (isSixHourPauseError(err)) {
      this.isSubPaused = true;
      this.syncState = 'subscription-paused';
      this.statusMessage = translated;
      this.lastError = translated;
      this.resetBackoff();
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      if (this.rescheduleSummaryTimer) {
        clearTimeout(this.rescheduleSummaryTimer);
        this.rescheduleSummaryTimer = null;
      }
      this.pendingRescheduleAfterPush = false;
      this.schedulePermissionRetry(SIX_HOUR_PAUSE_MS);
      this.notifyListeners();
      return { success: false, error: translated };
    }

    // All other errors -> exponential backoff (30s -> 1m -> 2m -> 5m -> 15m -> 30m max + jitter)
    this.scheduleErrorBackoff();

    if (
      errCode.includes('unavailable') ||
      errMessage.includes('offline') ||
      errCode.includes('network-request-failed') ||
      errMessage.includes('unavailable')
    ) {
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

  public getLastClockReconcileMs(): number {
    return this.lastClockReconcileMs;
  }

  public setLastClockReconcileMsForTesting(ms: number): void {
    this.lastClockReconcileMs = ms;
  }

  public setLastHeartbeatAttemptMsForTesting(ms: number): void {
    this.lastHeartbeatAttemptMs = ms;
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

  public getBudgetResumeTimer(): ReturnType<typeof setTimeout> | null {
    return this.budgetResumeTimer;
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
    this.lastHeartbeatAttemptMs = 0;
    this.lastClockReconcileMs = 0;
    this.isHeartbeatInFlight = false;
    this.lastDailySummaryDate = null;
    this.lastDailySummaryPushMs = 0;
    this.clearLastSyncedSignature();
    this.statusMessage = null;
    this.lastError = null;
    this.isSubPaused = false;
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
    this.isPushInFlight = false;
    this.pendingRescheduleAfterPush = false;
    this.actionSeq = 0;
    this.lastProcessedLicenseFingerprint = null;
    this.lastSeenAuthUid = null;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  public onStoreSignIn(listener: () => void): () => void {
    this.signInListeners.push(listener);
    return () => {
      this.signInListeners = this.signInListeners.filter(l => l !== listener);
    };
  }

  public onLicenseFingerprintChange(listener: () => void): () => void {
    this.licenseChangeListeners.push(listener);
    return () => {
      this.licenseChangeListeners = this.licenseChangeListeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  private notifySignInListeners() {
    for (const listener of this.signInListeners) {
      try {
        listener();
      } catch {}
    }
  }

  private notifyLicenseChangeListeners() {
    for (const listener of this.licenseChangeListeners) {
      try {
        listener();
      } catch {}
    }
  }
}

export const orgSyncService = new OrgSyncService();
