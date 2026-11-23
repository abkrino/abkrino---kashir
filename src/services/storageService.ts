import {
  Product, Customer, Supplier, SalesInvoice, PurchaseInvoice,
  CashMovement, Expense, AuditLog, SystemShift, User, StockAdjustment, ParkedCart,
  StoreProfile, DEFAULT_STORE_PROFILE, LEGACY_STORE_PROFILE,
  AccountingMode, FundingSource, FundingSourceType, CashMovementFunding,
  CashOutEvaluation, DEFAULT_FUNDING_SOURCES,
  SalesReturn, SalesReturnItem, SalesReturnReason, SalesReturnRefundMethod,
  SALES_RETURN_REASON_LABELS, InvoiceLineItem
} from '../types';
import {
  INITIAL_PRODUCTS, INITIAL_CUSTOMERS, INITIAL_SUPPLIERS, INITIAL_SHIFT,
  INITIAL_EXPENSES, INITIAL_CASH_MOVEMENTS, INITIAL_INVOICES, INITIAL_USERS
} from '../data/initialData';
import { licenseService, WriteOperationCategory, WriteGateContext } from './licenseService';
export type { WriteOperationCategory, WriteGateContext };
import { idb, type KVRecord } from './idbStore';

export const STORAGE_KEYS = {
  PRODUCTS: 'sm_products_v3',
  CUSTOMERS: 'sm_customers_v3',
  SUPPLIERS: 'sm_suppliers_v3',
  INVOICES: 'sm_invoices_v3',
  PURCHASES: 'sm_purchases_v3',
  CASH_MOVEMENTS: 'sm_cash_movements_v3',
  EXPENSES: 'sm_expenses_v3',
  AUDIT_LOGS: 'sm_audit_logs_v3',
  STOCK_ADJUSTMENTS: 'sm_stock_adjustments_v3',
  SHIFT: 'sm_current_shift_v3',
  USERS: 'sm_users_v3',
  ACTIVE_USER_ID: 'pos_active_user_id',
  PARKED_CARTS: 'sm_parked_carts_v3',
  STORE_PROFILE: 'sm_store_profile_v1',
  STORE_PROFILE_REVIEWED: 'sm_store_profile_reviewed',
  ACCOUNTING_MODE: 'sm_accounting_mode_v1',
  MONTHLY_POOL_INCLUDES_CAP_INJ: 'sm_monthly_pool_cap_inj_v1',
  FUNDING_SOURCES: 'sm_funding_sources_v1',
  SALES_RETURNS: 'sm_sales_returns_v1',
  DOCUMENT_SEQUENCES: 'sm_doc_sequences_v1',
  CREDENTIALS_RESET_REQUIRED: 'sm_credentials_reset_required_v1',
  SUMMARY_DIRTY: 'sm_summary_dirty_v1',
};

export const SUMMARY_TRACKED_KEYS = new Set<string>([
  STORAGE_KEYS.PRODUCTS,
  STORAGE_KEYS.CUSTOMERS,
  STORAGE_KEYS.SUPPLIERS,
  STORAGE_KEYS.INVOICES,
  STORAGE_KEYS.PURCHASES,
  STORAGE_KEYS.CASH_MOVEMENTS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.SALES_RETURNS,
  STORAGE_KEYS.STOCK_ADJUSTMENTS,
  STORAGE_KEYS.SHIFT,
]);

export const BUSINESS_KEYS = [
  STORAGE_KEYS.PRODUCTS,
  STORAGE_KEYS.CUSTOMERS,
  STORAGE_KEYS.SUPPLIERS,
  STORAGE_KEYS.INVOICES,
  STORAGE_KEYS.PURCHASES,
  STORAGE_KEYS.CASH_MOVEMENTS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.AUDIT_LOGS,
  STORAGE_KEYS.STOCK_ADJUSTMENTS,
  STORAGE_KEYS.SHIFT,
  STORAGE_KEYS.USERS,
  STORAGE_KEYS.ACTIVE_USER_ID,
  STORAGE_KEYS.PARKED_CARTS,
  STORAGE_KEYS.STORE_PROFILE,
  STORAGE_KEYS.ACCOUNTING_MODE,
  STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ,
  STORAGE_KEYS.FUNDING_SOURCES,
  STORAGE_KEYS.SALES_RETURNS,
  STORAGE_KEYS.DOCUMENT_SEQUENCES,
];

const CAIRO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function getCairoDateString(date: Date = new Date()): string {
  return CAIRO_DATE_FORMATTER.format(date);
}

export function getCairoMonthPrefix(date: Date = new Date()): string {
  return getCairoDateString(date).slice(0, 7);
}

export function getMovementCairoMonthPrefix(movementDate: string): string {
  if (!movementDate) return '';
  const trimmed = movementDate.trim();
  if (trimmed.includes('T') || /\d{2}:\d{2}/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return getCairoMonthPrefix(parsed);
    }
  }
  const prefixMatch = trimmed.match(/^(\d{4}-\d{2})/);
  if (prefixMatch) return prefixMatch[1];
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return getCairoMonthPrefix(parsed);
  }
  return '';
}

class StorageService {
  private cache: Map<string, any> = new Map();
  private pendingWrites: Map<string, any> = new Map();
  private batchTimer: any = null;
  private activeCommitPromise: Promise<any> | null = null;
  private writeError: string | null = null;
  private writeErrorListeners: ((error: string | null) => void)[] = [];
  private migrationWarning: string | null = null;
  private isPersisted: boolean = false;
  private isFallback: boolean = false;
  private isReady: boolean = false;
  private migrationRecoveryRequired: boolean = false;
  private legacyBackupTimestamp: number = 0;
  private onActionCallbacks: ((actionName: string) => void)[] = [];
  private onSummaryDataChangeCallbacks: ((key: string) => void)[] = [];
  private initPromise: Promise<void> | null = null;

  constructor() {
    if (typeof licenseService.registerShiftStateReader === 'function') {
      licenseService.registerShiftStateReader(() => this.getCurrentShift());
    }
  }

  public onAction(cb: (actionName: string) => void): () => void {
    this.onActionCallbacks.push(cb);
    return () => {
      this.onActionCallbacks = this.onActionCallbacks.filter(c => c !== cb);
    };
  }

  public onSummaryDataChange(cb: (key: string) => void): () => void {
    this.onSummaryDataChangeCallbacks.push(cb);
    return () => {
      this.onSummaryDataChangeCallbacks = this.onSummaryDataChangeCallbacks.filter(c => c !== cb);
    };
  }

  private notifySummaryDataChange(key: string): void {
    this.onSummaryDataChangeCallbacks.forEach(cb => {
      try {
        cb(key);
      } catch (err) {
        console.error('Error in onSummaryDataChange callback:', err);
      }
    });
  }

  public getSummaryDirty(): boolean {
    return Boolean(this.getItem<boolean>(STORAGE_KEYS.SUMMARY_DIRTY, false));
  }

  public setSummaryDirty(dirty: boolean): void {
    const val = Boolean(dirty);
    this.cache.set(STORAGE_KEYS.SUMMARY_DIRTY, val);
    if (this.isFallback && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.SUMMARY_DIRTY, JSON.stringify(val));
      } catch {}
    }
    this.pendingWrites.set(STORAGE_KEYS.SUMMARY_DIRTY, val);
    this.scheduleBatchWrite();
  }

  public notifyAction(actionName: string): void {
    this.onActionCallbacks.forEach(cb => {
      try {
        cb(actionName);
      } catch (err) {
        console.error('Error in onAction callback:', err);
      }
    });
  }

  public assertWriteAllowed(
    category: WriteOperationCategory,
    actionDescription?: string,
    context?: WriteGateContext
  ): { allowed: boolean; error?: string } {
    if (typeof licenseService.canPerformWrite !== 'function') {
      return { allowed: true };
    }

    // Never trust a caller-supplied isShiftClose boolean; pass only the candidate targetShift
    // so licenseService validates the transition against the real stored shift state.
    const sanitizedContext: WriteGateContext | undefined =
      category === 'SHIFT'
        ? { targetShift: context?.targetShift ?? null }
        : context;

    const gate = licenseService.canPerformWrite(category, sanitizedContext);
    if (gate.allowed) {
      return { allowed: true };
    }

    const errorMsg =
      gate.reason ||
      'العملية غير مسموحة في حالة الاشتراك الحالية.';

    this.addAuditLog(
      'LICENSE_BLOCK',
      'رفض عملية كتابة بسبب حالة الاشتراك',
      'الترخيص',
      category,
      `تم رفض (${actionDescription || category}) في مرحلة ${gate.phase}: ${errorMsg}`
    );

    return { allowed: false, error: errorMsg };
  }

  public getWriteError(): string | null {
    return this.writeError;
  }

  public setWriteError(error: string | null): void {
    this.writeError = error;
    this.writeErrorListeners.forEach(listener => {
      try { listener(error); } catch {}
    });
  }

  public onWriteError(cb: (error: string | null) => void): () => void {
    this.writeErrorListeners.push(cb);
    return () => {
      this.writeErrorListeners = this.writeErrorListeners.filter(l => l !== cb);
    };
  }

  public getMigrationWarning(): string | null {
    return this.migrationWarning;
  }

  public isStorageFallback(): boolean {
    return this.isFallback;
  }

  public isStoragePersisted(): boolean {
    return this.isPersisted;
  }

  public isStorageReady(): boolean {
    return this.isReady;
  }

  public hasLoadedData(): boolean {
    return this.cache.size > 0;
  }

  public isMigrationRecoveryRequired(): boolean {
    return this.migrationRecoveryRequired;
  }

  public getLegacyBackupTimestamp(): number {
    return this.legacyBackupTimestamp;
  }

  public getItem<T>(key: string, defaultValue: T): T {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.cache.set(key, parsed);
          return parsed as T;
        }
      } catch {
        // ignore
      }
    }
    return defaultValue;
  }

  public setItem<T>(key: string, value: T): void {
    // 1. Synchronously update in-memory cache
    this.cache.set(key, value);

    // 2. Synchronous write to localStorage if fallback mode is active
    if (this.isFallback && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err: any) {
        this.setWriteError('فشل التخزين في localStorage: ' + (err?.message || 'مساحة ممتلئة'));
      }
    }

    // 3. Queue asynchronous write-through to IndexedDB
    this.pendingWrites.set(key, value);
    this.scheduleBatchWrite();

    // 4. Detect changes to core business keys automatically (even if notifyAction wasn't called)
    if (this.isReady && SUMMARY_TRACKED_KEYS.has(key)) {
      this.setSummaryDirty(true);
      this.notifySummaryDataChange(key);
    }
  }

  private scheduleBatchWrite(): void {
    if (this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.commitPendingWrites().catch(err => {
        console.error('Error committing pending writes to IDB:', err);
      });
    }, 15);
  }

  private async commitPendingWrites(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const records: KVRecord[] = entries.map(([key, value]) => ({
      key,
      value,
      updatedAt: Date.now(),
    }));

    if (typeof indexedDB === 'undefined' || this.isFallback) {
      if (typeof localStorage !== 'undefined') {
        try {
          for (const rec of records) {
            localStorage.setItem(rec.key, JSON.stringify(rec.value));
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    try {
      this.activeCommitPromise = idb.kv.bulkPut(records);
      await this.activeCommitPromise;
    } catch (err: any) {
      console.error('IndexedDB write failure:', err);
      this.setWriteError(err?.message || 'تعذر حفظ البيانات في IndexedDB');
      // Emergency write to localStorage so data isn't lost from this session
      if (typeof localStorage !== 'undefined') {
        try {
          for (const rec of records) {
            localStorage.setItem(rec.key, JSON.stringify(rec.value));
          }
        } catch {
          // ignore
        }
      }
    } finally {
      this.activeCommitPromise = null;
    }
  }

  public async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await this.commitPendingWrites();
    }
    if (this.activeCommitPromise) {
      await this.activeCommitPromise;
    }
  }

  public init(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.internalInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async internalInit(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') {
        this.isFallback = true;
        this.migrationWarning = 'قاعدة بيانات IndexedDB غير متوفرة في هذا المتصفح، يعمل النظام عبر localStorage';
        this.loadFromLocalStorageIntoCache();
        this.initDatabase();
        this.isReady = true;
        return;
      }

      let idbCount = 0;
      let idbAvailable = true;

      try {
        idbCount = await idb.kv.count();
      } catch (err) {
        console.warn('IndexedDB not available or failed to open:', err);
        idbAvailable = false;
      }

      if (!idbAvailable) {
        this.isFallback = true;
        this.migrationWarning = 'قاعدة بيانات IndexedDB غير متوفرة في هذا المتصفح، يعمل النظام عبر localStorage';
        this.loadFromLocalStorageIntoCache();
        this.initDatabase();
        this.isReady = true;
        return;
      }

      let hasLocalStorageData = false;
      let migratedAtTimestamp: number | null = null;
      let migratedKeysCount = BUSINESS_KEYS.length;
      if (typeof localStorage !== 'undefined') {
        try {
          hasLocalStorageData = Boolean(localStorage.getItem(STORAGE_KEYS.PRODUCTS));
          const rawMigratedAt = localStorage.getItem('idb_migrated_at');
          if (rawMigratedAt) {
            migratedAtTimestamp = Number(rawMigratedAt);
          }
          const rawCount = localStorage.getItem('idb_migrated_keys_count');
          if (rawCount) {
            migratedKeysCount = Number(rawCount);
          }
        } catch {
          hasLocalStorageData = false;
        }
      }

      // REQUIREMENT 2: Anti-Regression Migration Protection
      // If idb_migrated_at is found AND IndexedDB is empty or incomplete (< migratedKeysCount),
      // DO NOT automatically copy from localStorage! Show explicit recovery alert screen.
      if (migratedAtTimestamp && (idbCount === 0 || idbCount < migratedKeysCount)) {
        this.migrationRecoveryRequired = true;
        this.legacyBackupTimestamp = migratedAtTimestamp;
        this.isReady = false;
        return;
      }

      // CASE 1: IndexedDB is empty, no previous migration recorded, and business data exists in localStorage -> ONE-TIME INITIAL MIGRATION
      if (idbCount === 0 && hasLocalStorageData && !migratedAtTimestamp) {
        const toMigrate: KVRecord[] = [];
        for (const key of BUSINESS_KEYS) {
          try {
            const raw = localStorage.getItem(key);
            if (raw !== null) {
              const val = JSON.parse(raw);
              toMigrate.push({
                key,
                value: val,
                updatedAt: Date.now(),
              });
            }
          } catch (e) {
            console.error(`Failed to read/parse ${key} from localStorage:`, e);
          }
        }

        if (toMigrate.length > 0) {
          try {
            await idb.kv.bulkPut(toMigrate);

            // Verification of record counts and integrity
            let verificationPassed = true;
            for (const rec of toMigrate) {
              const saved = await idb.kv.get(rec.key);
              if (!saved) {
                verificationPassed = false;
                break;
              }
              if (Array.isArray(rec.value)) {
                if (!Array.isArray(saved.value) || saved.value.length !== rec.value.length) {
                  verificationPassed = false;
                  break;
                }
              }
            }

            if (verificationPassed) {
              try {
                localStorage.setItem('idb_migrated_at', String(Date.now()));
                localStorage.setItem('idb_migrated_keys_count', String(toMigrate.length));
              } catch {}
              for (const rec of toMigrate) {
                this.cache.set(rec.key, rec.value);
              }
              this.isFallback = false;
            } else {
              // Verification failed! Fall back to localStorage with warning
              this.isFallback = true;
              this.migrationWarning = 'فشل التحقق من تطابق نقل البيانات إلى IndexedDB، يعمل النظام الآن من التخزين المحلي (localStorage)';
              this.loadFromLocalStorageIntoCache();
            }
          } catch (err: any) {
            console.error('Migration to IDB failed:', err);
            this.isFallback = true;
            this.migrationWarning = 'تعذر نسخ البيانات إلى IndexedDB، يعمل النظام الآن من التخزين المحلي (localStorage)';
            this.loadFromLocalStorageIntoCache();
          }
        } else {
          this.initDatabase();
        }
      } else if (idbCount > 0) {
        // CASE 2: IndexedDB has records -> Read all into in-memory cache
        const allRecords = await idb.kv.toArray();
        const hasBusinessRecords = allRecords.some(rec => BUSINESS_KEYS.includes(rec.key));
        for (const rec of allRecords) {
          this.cache.set(rec.key, rec.value);
        }
        this.isFallback = false;

        if (!hasBusinessRecords) {
          this.initDatabase();
          await this.flush();
        }

        // Clean up old localStorage business data ONLY after 30 days of documented successful migration
        if (typeof localStorage !== 'undefined') {
          try {
            const migratedAt = Number(localStorage.getItem('idb_migrated_at'));
            if (migratedAt && (Date.now() - migratedAt >= 30 * 24 * 60 * 60 * 1000)) {
              for (const k of BUSINESS_KEYS) {
                localStorage.removeItem(k);
              }
            }
          } catch {
            // ignore
          }
        }
      } else {
        // CASE 3: Both empty -> Seed database
        this.initDatabase();
        await this.flush();
      }

      // Check and request persistence
      if (typeof navigator !== 'undefined' && navigator.storage) {
        try {
          if (navigator.storage.persist) {
            this.isPersisted = await navigator.storage.persist();
          }
        } catch {
          // ignore
        }
      }

      this.isReady = true;
    } catch (err: any) {
      console.error('storage.init() critical error:', err);
      throw err;
    }
  }

  private loadFromLocalStorageIntoCache(): void {
    if (typeof localStorage === 'undefined') return;
    for (const key of BUSINESS_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          this.cache.set(key, JSON.parse(raw));
        }
      } catch {
        // ignore
      }
    }
  }

  public async restoreFromLegacyLocalStorage(): Promise<{ success: boolean; error?: string }> {
    const toMigrate: KVRecord[] = [];
    if (typeof localStorage === 'undefined') {
      return { success: false, error: 'التخزين المحلي غير متاح في هذا المتصفح' };
    }

    for (const key of BUSINESS_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          const val = JSON.parse(raw);
          toMigrate.push({
            key,
            value: val,
            updatedAt: Date.now(),
          });
        }
      } catch (e) {
        console.error(`Failed to read/parse ${key} from localStorage:`, e);
      }
    }

    if (toMigrate.length === 0) {
      return { success: false, error: 'لا توجد بيانات صالحة في النسخة القديمة للتخزين المحلي' };
    }

    try {
      if (typeof indexedDB !== 'undefined') {
        await idb.kv.bulkPut(toMigrate);
      }
      for (const rec of toMigrate) {
        this.cache.set(rec.key, rec.value);
      }
      try {
        localStorage.setItem('idb_migrated_at', String(Date.now()));
        localStorage.setItem('idb_migrated_keys_count', String(toMigrate.length));
      } catch {}

      this.migrationRecoveryRequired = false;
      this.isReady = true;
      this.isFallback = false;
      await this.flush();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'فشلت عملية الاستعادة إلى IndexedDB' };
    }
  }

  public async getStorageStatus(): Promise<{
    persisted: boolean;
    usageBytes: number;
    quotaBytes: number;
    migrationDate: string | null;
    isFallback: boolean;
    migrationWarning: string | null;
  }> {
    let persisted = this.isPersisted;
    let usageBytes = 0;
    let quotaBytes = 0;

    if (typeof navigator !== 'undefined' && navigator.storage) {
      try {
        if (navigator.storage.persisted) {
          persisted = await navigator.storage.persisted();
          this.isPersisted = persisted;
        }
        if (navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          usageBytes = est.usage || 0;
          quotaBytes = est.quota || 0;
        }
      } catch {
        // ignore
      }
    }

    let migrationDate: string | null = null;
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('idb_migrated_at');
      if (raw) {
        migrationDate = new Date(Number(raw)).toLocaleString('ar-EG');
      }
    }

    return {
      persisted,
      usageBytes,
      quotaBytes,
      migrationDate,
      isFallback: this.isFallback,
      migrationWarning: this.migrationWarning,
    };
  }

  public async requestPersistence(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      try {
        this.isPersisted = await navigator.storage.persist();
        return this.isPersisted;
      } catch {
        return false;
      }
    }
    return false;
  }

  // --- INITIALIZATION ---
  public initDatabase(seedDemoData: boolean = false): void {
    if (!this.cache.has(STORAGE_KEYS.PRODUCTS)) {
      this.setItem(STORAGE_KEYS.PRODUCTS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_PRODUCTS)) : []);
      this.setItem(STORAGE_KEYS.CUSTOMERS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_CUSTOMERS)) : []);
      this.setItem(STORAGE_KEYS.SUPPLIERS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_SUPPLIERS)) : []);
      this.setItem(STORAGE_KEYS.INVOICES, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_INVOICES)) : []);
      this.setItem(STORAGE_KEYS.PURCHASES, []);
      this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_CASH_MOVEMENTS)) : []);
      this.setItem(STORAGE_KEYS.EXPENSES, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_EXPENSES)) : []);
      this.setItem(STORAGE_KEYS.SHIFT, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_SHIFT)) : null);
      this.setItem(STORAGE_KEYS.USERS, []);
      this.setItem(STORAGE_KEYS.PARKED_CARTS, []);
      this.setItem(STORAGE_KEYS.AUDIT_LOGS, []);
      this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, []);
      this.setItem(STORAGE_KEYS.STORE_PROFILE, seedDemoData ? JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE)) : JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE)));
      this.addAuditLog('SYSTEM', 'إعداد النظام', 'النظام', 'sys-0', 'تمت تهيئة نظام الكاشير وإدارة المبيعات');
    }
  }

  public loadDemoData(): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تحميل بيانات تجريبية');
    if (!gate.allowed) return { success: false, error: gate.error };

    this.setItem(STORAGE_KEYS.PRODUCTS, JSON.parse(JSON.stringify(INITIAL_PRODUCTS)));
    this.setItem(STORAGE_KEYS.CUSTOMERS, JSON.parse(JSON.stringify(INITIAL_CUSTOMERS)));
    this.setItem(STORAGE_KEYS.SUPPLIERS, JSON.parse(JSON.stringify(INITIAL_SUPPLIERS)));
    this.addAuditLog('SYSTEM', 'تحميل بيانات تجريبية', 'النظام', 'sys-demo', 'تم استيراد الأصناف والعملاء والموردين التجريبيين');
    this.notifyAction('تحميل بيانات تجريبية');
    return { success: true };
  }

  // --- STORE PROFILE MANAGEMENT ---
  public getStoreProfile(): StoreProfile {
    if (this.cache.has(STORAGE_KEYS.STORE_PROFILE)) {
      const cached = this.cache.get(STORAGE_KEYS.STORE_PROFILE);
      if (cached && typeof cached === 'object' && cached.name) {
        return cached as StoreProfile;
      }
    }

    // Check if we have an existing installation with business data
    const existingProducts = this.getItem<Product[]>(STORAGE_KEYS.PRODUCTS, []);
    const existingInvoices = this.getItem<SalesInvoice[]>(STORAGE_KEYS.INVOICES, []);
    const existingUsers = this.getItem<User[]>(STORAGE_KEYS.USERS, []);

    const hasLegacyData = (Array.isArray(existingProducts) && existingProducts.length > 0) ||
                          (Array.isArray(existingInvoices) && existingInvoices.length > 0) ||
                          (Array.isArray(existingUsers) && existingUsers.length > 0);

    if (hasLegacyData) {
      // Auto-create from legacy defaults with dairy & weighingScale enabled
      const legacyProfile: StoreProfile = JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE));
      this.setItem(STORAGE_KEYS.STORE_PROFILE, legacyProfile);
      // Mark as not reviewed so non-blocking banner is shown
      if (!this.cache.has(STORAGE_KEYS.STORE_PROFILE_REVIEWED)) {
        this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, false);
      }
      return legacyProfile;
    }

    // New installation: default store profile
    const defaultProfile: StoreProfile = JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE));
    return defaultProfile;
  }

  public saveStoreProfile(profile: StoreProfile): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تعديل بيانات المحل');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!profile.name || !profile.name.trim()) {
      return { success: false, error: 'اسم المحل مطلوب' };
    }

    // Validate logo size (<= 100KB: 100 * 1024 bytes)
    if (profile.logo) {
      const approxBytes = Math.round((profile.logo.length * 3) / 4);
      if (approxBytes > 105 * 1024) {
        return { success: false, error: 'حجم اللوجو يتجاوز 100 كيلوبايت. يرجى اختيار صورة أصغر حجماً.' };
      }
    }

    // Ensure currency has a default
    if (!profile.currency || !profile.currency.trim()) {
      profile.currency = 'EGP';
    }

    // Ensure modules object exists with booleans
    profile.modules = {
      dairy: Boolean(profile.modules?.dairy),
      weighingScale: Boolean(profile.modules?.weighingScale),
      delivery: Boolean(profile.modules?.delivery),
    };

    this.setItem(STORAGE_KEYS.STORE_PROFILE, profile);
    this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
    this.addAuditLog('SYSTEM', 'تعديل بيانات المحل', 'الإعدادات', 'admin', `تم تحديث بيانات المحل: ${profile.name}`);
    this.notifyAction(`تحديث بيانات المحل: ${profile.name}`);
    return { success: true };
  }

  public isStoreProfileReviewed(): boolean {
    return this.getItem<boolean>(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
  }

  public setStoreProfileReviewed(reviewed: boolean): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تحديث حالة مراجعة بيانات المحل');
    if (!gate.allowed) return { success: false, error: gate.error };

    this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, reviewed);
    return { success: true };
  }

  public hasConfiguredStoreProfile(): boolean {
    if (!this.cache.has(STORAGE_KEYS.STORE_PROFILE)) return false;
    const profile = this.cache.get(STORAGE_KEYS.STORE_PROFILE) as StoreProfile;
    return Boolean(profile && profile.name && profile.name.trim() !== '' && profile.name !== 'اسم المحل');
  }

  // --- ACCOUNTING MODE & FUNDING SOURCES ---
  public getAccountingMode(): AccountingMode {
    const mode = this.getItem<string>(STORAGE_KEYS.ACCOUNTING_MODE, 'DAILY_DRAWER');
    if (mode === 'DAILY_DRAWER' || mode === 'MONTHLY_POOL' || mode === 'CAPITAL') {
      return mode;
    }
    return 'DAILY_DRAWER';
  }

  public async setAccountingMode(
    newMode: AccountingMode,
    adminUser: User | null | undefined,
    passwordOrPin: string
  ): Promise<{ success: boolean; error?: string }> {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تغيير النظام المحاسبي');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (newMode !== 'DAILY_DRAWER' && newMode !== 'MONTHLY_POOL' && newMode !== 'CAPITAL') {
      return { success: false, error: 'نظام المحاسبة المحدد غير صالح' };
    }

    if (!adminUser || adminUser.role !== 'ADMIN' || adminUser.isActive === false) {
      return { success: false, error: 'غير مصرح: تغيير النظام المحاسبي مقتصر على مدير النظام فقط' };
    }

    const currentShift = this.getCurrentShift();
    if (currentShift && currentShift.status === 'OPEN') {
      return {
        success: false,
        error: 'لا يمكن تغيير النظام المحاسبي أثناء وجود وردية مفتوحة. يجب مطابقة الدرج وإغلاق الوردية الحالية أولاً.',
      };
    }

    const { authSecurityService } = await import('./authSecurityService');
    const verification = await authSecurityService.verifyUserPassword(adminUser.id, passwordOrPin);
    if (!verification.valid) {
      return {
        success: false,
        error: verification.error || 'كلمة مرور المدير غير صحيحة. تم رفض تبديل النظام المحاسبي.',
      };
    }

    const prevMode = this.getAccountingMode();
    if (prevMode === newMode) {
      return { success: true };
    }

    this.setItem(STORAGE_KEYS.ACCOUNTING_MODE, newMode);

    const modeLabels: Record<AccountingMode, string> = {
      DAILY_DRAWER: 'الدرج اليومي الفعلي (DAILY_DRAWER)',
      MONTHLY_POOL: 'الوعاء الشهري التراكمي (MONTHLY_POOL)',
      CAPITAL: 'التمويل من رأس المال (CAPITAL)',
    };

    this.addAuditLog(
      'ACCOUNTING_MODE',
      'تغيير النظام المحاسبي',
      'الإعدادات',
      newMode,
      `قام المدير (${adminUser.fullName}) بتبديل نظام المحاسبة من [${modeLabels[prevMode]}] إلى [${modeLabels[newMode]}] (يسري على العمليات الجديدة فقط)`
    );
    this.notifyAction(`تغيير النظام المحاسبي إلى ${modeLabels[newMode]}`);

    return { success: true };
  }

  public getMonthlyPoolIncludesCapitalInjection(): boolean {
    return Boolean(this.getItem<boolean>(STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ, false));
  }

  public async setMonthlyPoolIncludesCapitalInjection(
    enabled: boolean,
    adminUser: User | null | undefined,
    passwordOrPin: string
  ): Promise<{ success: boolean; error?: string }> {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تعديل إعداد وعاء رأس المال');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!adminUser || adminUser.role !== 'ADMIN' || adminUser.isActive === false) {
      return { success: false, error: 'غير مصرح: تعديل هذا الإعداد مقتصر على مدير النظام فقط' };
    }

    const { authSecurityService } = await import('./authSecurityService');
    const verification = await authSecurityService.verifyUserPassword(adminUser.id, passwordOrPin);
    if (!verification.valid) {
      return {
        success: false,
        error: verification.error || 'كلمة مرور المدير غير صحيحة. تم رفض تعديل الإعداد.',
      };
    }

    const nextVal = Boolean(enabled);
    const prevVal = this.getMonthlyPoolIncludesCapitalInjection();
    if (prevVal === nextVal) {
      return { success: true };
    }

    this.setItem(STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ, nextVal);

    this.addAuditLog(
      'ACCOUNTING_SETTINGS',
      'تعديل إعداد وعاء رأس المال الشهري',
      'الإعدادات',
      'monthlyPoolIncludesCapitalInjection',
      `قام المدير (${adminUser.fullName}) بتغيير إعداد احتساب إيداعات رأس المال في رصيد الشهر (monthlyPoolIncludesCapitalInjection) من [${prevVal ? 'مفعّل' : 'معطل'}] إلى [${nextVal ? 'مفعّل' : 'معطل'}] (يسري على العمليات الجديدة فقط)`
    );
    this.notifyAction(
      nextVal
        ? 'تفعيل احتساب إيداعات رأس المال في رصيد الشهر'
        : 'إيقاف احتساب إيداعات رأس المال في رصيد الشهر'
    );

    return { success: true };
  }

  public getFundingSources(): FundingSource[] {
    const stored = this.getItem<FundingSource[] | null>(STORAGE_KEYS.FUNDING_SOURCES, null);
    if (!stored || !Array.isArray(stored) || stored.length === 0) {
      return JSON.parse(JSON.stringify(DEFAULT_FUNDING_SOURCES));
    }
    return stored;
  }

  public getActiveFundingSources(): FundingSource[] {
    return this.getFundingSources().filter(s => s.isActive !== false);
  }

  public addFundingSource(
    adminUser: User | null | undefined,
    params: { type: FundingSourceType; label: string; note?: string }
  ): { success: boolean; error?: string; source?: FundingSource } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'إضافة مصدر تمويل');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!adminUser || adminUser.role !== 'ADMIN' || adminUser.isActive === false) {
      return { success: false, error: 'غير مصرح: تعديل مصادر التمويل مقتصر على المدير العام فقط' };
    }

    const cleanLabel = (params.label || '').trim();
    if (!cleanLabel) {
      return { success: false, error: 'يرجى كتابة اسم مصدر التمويل' };
    }

    const validTypes: FundingSourceType[] = ['DRAWER', 'OWNER_LOAN', 'CUSTODY', 'EXTERNAL_FUNDING', 'DRAWER_NEGATIVE', 'OTHER'];
    if (!validTypes.includes(params.type)) {
      return { success: false, error: 'نوع مصدر التمويل غير صالح' };
    }

    const sources = this.getFundingSources();
    const newSource: FundingSource = {
      id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: params.type,
      label: cleanLabel,
      note: params.note?.trim() || undefined,
      isActive: true,
      isSystemDefault: false,
    };

    sources.push(newSource);
    this.setItem(STORAGE_KEYS.FUNDING_SOURCES, sources);

    this.addAuditLog(
      'SETTINGS',
      'إضافة مصدر تمويل',
      'الإعدادات',
      newSource.id,
      `أضاف المدير (${adminUser.fullName}) مصدر تمويل جديد: ${newSource.label} (${newSource.type})`
    );

    return { success: true, source: newSource };
  }

  public toggleFundingSource(
    adminUser: User | null | undefined,
    sourceId: string
  ): { success: boolean; error?: string; source?: FundingSource } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'تعديل مصدر تمويل');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!adminUser || adminUser.role !== 'ADMIN' || adminUser.isActive === false) {
      return { success: false, error: 'غير مصرح: تعديل مصادر التمويل مقتصر على المدير العام فقط' };
    }

    const sources = this.getFundingSources();
    const idx = sources.findIndex(s => s.id === sourceId);
    if (idx === -1) {
      return { success: false, error: 'مصدر التمويل غير موجود' };
    }

    if (sources[idx].id === 'fs-drawer') {
      return { success: false, error: 'لا يمكن إيقاف المصدر الأساسي (نقدية الدرج المباشرة)' };
    }

    sources[idx] = { ...sources[idx], isActive: !sources[idx].isActive };
    this.setItem(STORAGE_KEYS.FUNDING_SOURCES, sources);

    this.addAuditLog(
      'SETTINGS',
      sources[idx].isActive ? 'تفعيل مصدر تمويل' : 'إيقاف مصدر تمويل',
      'الإعدادات',
      sources[idx].id,
      `قام المدير (${adminUser.fullName}) بـ ${sources[idx].isActive ? 'تفعيل' : 'إيقاف'} مصدر التمويل: ${sources[idx].label}`
    );

    return { success: true, source: sources[idx] };
  }

  public validateFundingDetails(funding?: CashMovementFunding): {
    valid: boolean;
    error?: string;
    normalized?: CashMovementFunding;
  } {
    if (!funding) {
      return { valid: false, error: 'يرجى تحديد مصدر التمويل' };
    }
    if (funding.type === 'OTHER' && (!funding.note || !funding.note.trim())) {
      return {
        valid: false,
        error: 'عند اختيار "أخرى" يجب كتابة توضيح مصدر التمويل في مربع النص الإلزامي',
      };
    }
    return {
      valid: true,
      normalized: {
        type: funding.type,
        label: (funding.label || '').trim() || funding.type,
        note: funding.note?.trim() || undefined,
      },
    };
  }

  // --- USERS & ROLES MANAGEMENT ---
  public getUsers(): User[] {
    const users = this.getItem<User[]>(STORAGE_KEYS.USERS, []);
    let migrated = false;
    for (const u of users) {
      if (!u.permissions) {
        u.permissions = {
          canEditPrice: true,
          canGiveDiscount: true,
          canSellNegativeStock: true,
          canDeleteInvoice: u.role === 'ADMIN',
          canEditInvoice: true,
          canViewProfits: u.role === 'ADMIN',
          canManageProducts: u.role === 'ADMIN',
          canManagePurchases: u.role === 'ADMIN',
          canManageCash: u.role === 'ADMIN',
        };
        migrated = true;
      }
    }
    if (migrated) {
      this.setItem(STORAGE_KEYS.USERS, users);
    }
    return users;
  }

  public getActiveUser(): User | null {
    const users = this.getUsers();
    if (!users || users.length === 0) return null;
    let activeId: string | null = null;
    if (typeof localStorage !== 'undefined') {
      const storedActive = localStorage.getItem(STORAGE_KEYS.ACTIVE_USER_ID);
      if (!storedActive) {
        this.cache.delete(STORAGE_KEYS.ACTIVE_USER_ID);
        return null;
      }
      activeId = storedActive;
    } else {
      activeId = this.getItem<string>(STORAGE_KEYS.ACTIVE_USER_ID, '');
    }
    if (!activeId) return null;
    const found = users.find(u => u.id === activeId);
    return found || null;
  }

  public setActiveUser(userId: string): void {
    this.setItem(STORAGE_KEYS.ACTIVE_USER_ID, userId);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_USER_ID, userId);
      } catch {}
    }
  }

  public clearActiveUser(): void {
    this.cache.delete(STORAGE_KEYS.ACTIVE_USER_ID);
    this.pendingWrites.delete(STORAGE_KEYS.ACTIVE_USER_ID);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_USER_ID);
      } catch {}
    }
    if (typeof indexedDB !== 'undefined') {
      idb.kv.delete(STORAGE_KEYS.ACTIVE_USER_ID).catch(() => {});
    }
  }

  public getCredentialsResetRequired(): boolean {
    return Boolean(this.getItem<boolean>(STORAGE_KEYS.CREDENTIALS_RESET_REQUIRED, false));
  }

  public setCredentialsResetRequired(required: boolean): void {
    this.setItem(STORAGE_KEYS.CREDENTIALS_RESET_REQUIRED, Boolean(required));
  }

  public saveUser(
    user: User,
    options?: { bypassLicenseCheck?: boolean }
  ): { success: boolean; error?: string } {
    if (!options?.bypassLicenseCheck) {
      const gate = this.assertWriteAllowed('ADMIN_DATA', `حفظ مستخدم: ${user.username}`);
      if (!gate.allowed) return { success: false, error: gate.error };
    }

    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      users[idx] = user;
    } else {
      // Check duplicate username
      if (users.some(u => u.username.toLowerCase() === user.username.toLowerCase())) {
        return { success: false, error: 'اسم المستخدم مسجل مسبقاً' };
      }
      users.push(user);
    }
    this.setItem(STORAGE_KEYS.USERS, users);
    return { success: true };
  }

  public deleteUser(userId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حذف مستخدم: ${userId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    
    // Prevent deleting last admin
    const admins = users.filter(u => u.role === 'ADMIN' && u.isActive !== false);
    if (user.role === 'ADMIN' && admins.length <= 1) {
      return { success: false, error: 'لا يمكن حذف آخر مدير نظام متبقي في البرنامج' };
    }

    const filtered = users.filter(u => u.id !== userId);
    this.setItem(STORAGE_KEYS.USERS, filtered);
    this.addAuditLog('USER', 'حذف مستخدم', 'المستخدمين', userId, `تم حذف المستخدم: ${user.fullName}`);
    return { success: true };
  }

  public authenticate(userId: string, pin: string): { success: boolean; error?: string; user?: User } {
    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    if (user.isActive === false) return { success: false, error: 'هذا الحساب معطل حالياً' };
    
    // Legacy fallback check if pinCode exists
    if (user.pinCode && user.pinCode.trim() === pin.trim()) {
      this.setActiveUser(user.id);
      return { success: true, user };
    }
    return { success: false, error: 'الرقم السري غير صحيح أو يتطلب تحقق أمني' };
  }

  public changeUserPin(userId: string, oldPin: string, newPin: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `تعديل الرقم السري للمستخدم: ${userId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    if (user.pinCode && user.pinCode !== oldPin) return { success: false, error: 'الرقم السري الحالي غير صحيح' };
    if (newPin.trim().length < 4) return { success: false, error: 'الرقم السري يجب ألا يقل عن 4 خانات' };

    user.pinCode = newPin.trim();
    this.setItem(STORAGE_KEYS.USERS, users);
    this.addAuditLog('AUTH', 'تعديل الباسورد', 'الأمان', user.id, `تم تغيير الرقم السري للمستخدم: ${user.fullName}`);
    return { success: true };
  }

  // --- PRODUCTS (SINGLE WAREHOUSE) ---
  public getProducts(): Product[] {
    let products = this.getItem<Product[]>(STORAGE_KEYS.PRODUCTS, []);
    if (!products || !Array.isArray(products)) {
      products = [];
      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }
    // Backward compatibility migration for single warehouse
    let migrated = false;
    for (const p of products) {
      if (p.stockPieces === undefined) {
        p.stockPieces = ((p as any).stockShopPieces || 0) + ((p as any).stockWarehousePieces || 0);
        migrated = true;
      }
    }
    if (migrated) {
      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }
    return products;
  }

  public saveProduct(product: Product): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حفظ صنف: ${product.name}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const stockPieces = Number(product.stockPieces);
    if (!Number.isFinite(stockPieces) || stockPieces < 0) {
      return { success: false, error: 'رصيد الصنف يجب أن يكون رقمًا صحيحًا أو كسريًا صالحًا ولا يمكن أن يكون بالسالب.' };
    }

    const products = this.getProducts();
    const index = products.findIndex(p => p.id === product.id);
    if (index >= 0) {
      products[index] = product;
    } else {
      products.unshift(product);
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);
    this.addAuditLog('PRODUCT', 'حفظ صنف', 'الأصناف', product.id, `حفظ الصنف: ${product.name} (المخزن: ${product.stockPieces} قطعة)`);
    this.notifyAction(`حفظ صنف: ${product.name}`);
    return { success: true };
  }

  public deleteProduct(productId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حذف صنف: ${productId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const products = this.getProducts();
    const prod = products.find(p => p.id === productId);
    if (!prod) return { success: false, error: 'الصنف غير موجود' };

    const filtered = products.filter(p => p.id !== productId);
    this.setItem(STORAGE_KEYS.PRODUCTS, filtered);
    this.addAuditLog('PRODUCT', 'حذف صنف', 'الأصناف', productId, `تم حذف الصنف: ${prod.name}`);
    this.notifyAction(`حذف صنف: ${prod.name}`);
    return { success: true };
  }

  // --- CUSTOMERS & STATEMENTS ---
  public getCustomers(): Customer[] {
    const custs = this.getItem<Customer[]>(STORAGE_KEYS.CUSTOMERS, []);
    if (!custs || !Array.isArray(custs)) {
      this.setItem(STORAGE_KEYS.CUSTOMERS, []);
      return [];
    }
    return custs;
  }

  public saveCustomer(customer: Customer): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حفظ عميل: ${customer.name}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const customers = this.getCustomers();
    const index = customers.findIndex(c => c.id === customer.id);
    if (index >= 0) {
      customers[index] = customer;
    } else {
      customers.unshift(customer);
    }
    this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    this.addAuditLog('CUSTOMER', 'حفظ عميل', 'العملاء', customer.id, `حفظ بيانات العميل: ${customer.name}`);
    this.notifyAction(`حفظ عميل: ${customer.name}`);
    return { success: true };
  }

  public deleteCustomer(customerId: string, clearDebtAndForce: boolean = false): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حذف عميل: ${customerId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const customers = this.getCustomers();
    const cust = customers.find(c => c.id === customerId);
    if (!cust) return { success: false, error: 'العميل غير موجود' };
    
    if (cust.currentBalance > 0 && !clearDebtAndForce) {
      return { success: false, error: `لا يمكن حذف العميل لأن عليه مديونية قائمة قدرها ${cust.currentBalance} ج.م` };
    }

    const filtered = customers.filter(c => c.id !== customerId);
    this.setItem(STORAGE_KEYS.CUSTOMERS, filtered);
    this.addAuditLog('CUSTOMER', 'حذف عميل', 'العملاء', customerId, `تم حذف العميل: ${cust.name} ${cust.currentBalance > 0 ? `(تم إسقاط مديونية قدرها ${cust.currentBalance} ج.م)` : ''}`);
    return { success: true };
  }

  public getCustomerStatement(customerId: string): {
    customer: Customer;
    invoices: SalesInvoice[];
    payments: CashMovement[];
    returns: SalesReturn[];
  } | null {
    const cust = this.getCustomers().find(c => c.id === customerId);
    if (!cust) return null;

    const invoices = this.getSalesInvoices().filter(inv => inv.customerId === customerId);
    const payments = this.getCashMovements().filter(
      m => m.category === 'CUSTOMER_COLLECTION' && m.description.includes(cust.name)
    );
    const returns = this.getSalesReturns().filter(r => r.customerId === customerId);

    return { customer: cust, invoices, payments, returns };
  }

  // --- SUPPLIERS ---
  public getSuppliers(): Supplier[] {
    const suppliers = this.getItem<Supplier[]>(STORAGE_KEYS.SUPPLIERS, []);
    if (!suppliers || !Array.isArray(suppliers)) {
      this.setItem(STORAGE_KEYS.SUPPLIERS, []);
      return [];
    }
    return suppliers;
  }

  public saveSupplier(supplier: Supplier): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حفظ مورد: ${supplier.name}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const suppliers = this.getSuppliers();
    const index = suppliers.findIndex(s => s.id === supplier.id);
    if (index >= 0) {
      suppliers[index] = supplier;
    } else {
      suppliers.unshift(supplier);
    }
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    return { success: true };
  }

  public deleteSupplier(supplierId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `حذف مورد: ${supplierId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === supplierId);
    if (!supp) return { success: false, error: 'المورد غير موجود' };
    if (supp.currentBalance > 0) {
      return { success: false, error: `لا يمكن حذف المورد لأن له مستحقات قائمة قدرها ${supp.currentBalance} ج.م` };
    }
    const filtered = suppliers.filter(s => s.id !== supplierId);
    this.setItem(STORAGE_KEYS.SUPPLIERS, filtered);
    return { success: true };
  }

  // --- SHIFTS & DRAWER CASH ---
  public getCurrentShift(): SystemShift {
    const shift = this.getItem<SystemShift | null>(STORAGE_KEYS.SHIFT, INITIAL_SHIFT);
    // Corrupt or legacy null values must never crash the cash screen.
    return shift && typeof shift === 'object' && typeof shift.id === 'string' &&
      (shift.status === 'OPEN' || shift.status === 'CLOSED')
      ? shift
      : INITIAL_SHIFT;
  }

  public saveCurrentShift(shift: SystemShift): { success: boolean; error?: string } {
    const actionLabel =
      shift?.status === 'CLOSED' ? 'إغلاق الوردية' : 'فتح / حفظ الوردية';
    const gate = this.assertWriteAllowed('SHIFT', actionLabel, {
      targetShift: shift ?? null,
    });
    if (!gate.allowed) return { success: false, error: gate.error };

    this.setItem(STORAGE_KEYS.SHIFT, shift);
    if (shift?.status === 'CLOSED') {
      this.notifyAction('SHIFT_CLOSED');
    }
    return { success: true };
  }

  public calculateCurrentCashInDrawer(): number {
    const movements = this.getCashMovements();
    return movements.reduce((acc, m) => {
      if (m.affectsDrawer === false) return acc;
      return m.type === 'IN' ? acc + m.amount : acc - m.amount;
    }, 0);
  }

  public calculateMonthlyPoolAvailable(referenceDate?: Date): number {
    const now = referenceDate || new Date();
    const currentMonthPrefix = getCairoMonthPrefix(now);
    const includeCapInjection = this.getMonthlyPoolIncludesCapitalInjection();
    const movements = this.getCashMovements();
    return movements.reduce((acc, m) => {
      if (m.affectsDrawer === false) return acc;
      if (!m.date || getMovementCairoMonthPrefix(m.date) !== currentMonthPrefix) return acc;
      // صافي النقدية الداخلة للدرج منذ أول الشهر (بتوقيت Africa/Cairo) باستثناء الرصيد الافتتاحي؛
      // وتُستثنى حركات ضخ رأس المال CAPITAL_INJECTION إلا عند تفعيل monthlyPoolIncludesCapitalInjection
      if (m.category === 'OPENING_BALANCE') return acc;
      if (m.category === 'CAPITAL_INJECTION' && !includeCapInjection) return acc;
      return m.type === 'IN' ? acc + m.amount : acc - m.amount;
    }, 0);
  }

  /**
   * Unified Cash-Out Coverage & Funding Source Evaluator (Service Layer)
   */
  public evaluateCashOut(
    amount: number,
    context?: {
      user?: User | null;
      operation?: 'SUPPLIER_PAYMENT' | 'EXPENSE' | 'PURCHASE_CASH' | 'MANUAL_WITHDRAWAL' | 'SALES_REFUND' | string;
      allowNegativeCash?: boolean;
      fundingDetails?: CashMovementFunding;
    }
  ): CashOutEvaluation {
    const mode = this.getAccountingMode();
    const isSalesRefund = context?.operation === 'SALES_REFUND';
    // Cash sales refunds ALWAYS check physical drawer balance regardless of accountingMode
    const available = isSalesRefund
      ? this.calculateCurrentCashInDrawer()
      : mode === 'DAILY_DRAWER'
      ? this.calculateCurrentCashInDrawer()
      : mode === 'MONTHLY_POOL'
      ? this.calculateMonthlyPoolAvailable()
      : Infinity;

    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        allowed: false,
        requiresFundingSource: false,
        available,
        mode,
        reason: 'المبلغ يجب أن يكون أكبر من صفر',
      };
    }

    // Validate structured fundingDetails if provided (strictly reject OTHER without note in ALL modes)
    if (context?.fundingDetails) {
      const check = this.validateFundingDetails(context.fundingDetails);
      if (!check.valid) {
        return {
          allowed: false,
          requiresFundingSource: true,
          available,
          mode,
          reason: check.error,
        };
      }
    }

    // CAPITAL mode: No drawer coverage check for expenses & purchases, EXCEPT sales refunds which ALWAYS come from drawer
    if (mode === 'CAPITAL' && !isSalesRefund) {
      return {
        allowed: true,
        requiresFundingSource: false,
        available,
        mode,
      };
    }

    // Check against available liquidity (drawer cash for DAILY_DRAWER & SALES_REFUND; monthly pool for MONTHLY_POOL)
    if (available >= amount) {
      return {
        allowed: true,
        requiresFundingSource: false,
        available,
        mode,
      };
    }

    // Insufficient funds -> Requires Funding Source & Negative/External Permission (ADMIN or explicit permission)
    const actingUser = context?.user !== undefined ? context.user : this.getActiveUser();
    const canNegative = Boolean(
      actingUser &&
        actingUser.isActive !== false &&
        (actingUser.role === 'ADMIN' || actingUser.permissions?.canWithdrawNegativeCash)
    );

    if (!canNegative) {
      const reason = isSalesRefund
        ? `رصيد الدرج المتاح (${available} ج.م) لا يكفي لرد ${amount} ج.م نقداً. يرجى اختيار "رصيد للعميل" بدلاً من الرد النقدي، أو مراجعة المدير العام.`
        : `الرصيد المتاح (${available} ج.م) لا يكفي لصرف ${amount} ج.م. السحب بالسالب أو التمويل البديل مقتصر على المدير العام أو بصلاحية صريحة فقط.`;
      return {
        allowed: false,
        requiresFundingSource: true,
        available,
        mode,
        reason,
      };
    }

    if (!context?.allowNegativeCash) {
      const msg = isSalesRefund
        ? `الرصيد النقدي بالدرج (${available} ج.م) لا يكفي لرد ${amount} ج.م نقداً. يمكنك اختيار رد المبلغ كـ "رصيد للعميل" أو تحديد مصدر التمويل لتجاوز الدرج.`
        : mode === 'MONTHLY_POOL'
        ? `صافي الوعاء الشهري المتاح منذ أول الشهر (${available} ج.م) لا يكفي لصرف ${amount} ج.م. يرجى تحديد مصدر التمويل للمتابعة.`
        : `الرصيد النقدي بالدرج (${available} ج.م) لا يكفي لصرف ${amount} ج.م. يرجى تحديد مصدر التمويل أو تفعيل السحب بالسالب.`;
      return {
        allowed: false,
        requiresFundingSource: true,
        available,
        mode,
        reason: msg,
      };
    }

    if (!context.fundingDetails) {
      return {
        allowed: false,
        requiresFundingSource: true,
        available,
        mode,
        reason: 'يرجى تحديد مصدر التمويل المنظّم قبل تأكيد الصرف.',
      };
    }

    return {
      allowed: true,
      requiresFundingSource: true,
      available,
      mode,
    };
  }

  // --- CASH MOVEMENTS ---
  public getCashMovements(): CashMovement[] {
    return this.getItem<CashMovement[]>(STORAGE_KEYS.CASH_MOVEMENTS, INITIAL_CASH_MOVEMENTS);
  }

  public addCashMovement(
    movement: CashMovement,
    options?: {
      user?: User | null;
      allowNegativeCash?: boolean;
      skipCashOutCheck?: boolean;
      bypassLicenseCheck?: boolean;
    }
  ): { success: boolean; error?: string } {
    if (!options?.bypassLicenseCheck) {
      const gate = this.assertWriteAllowed('CASH_OPS', `تسجيل حركة نقدية يدوية: ${movement.categoryLabelArabic}`);
      if (!gate.allowed) return { success: false, error: gate.error };
    }

    if (
      !options?.skipCashOutCheck &&
      movement.type === 'OUT' &&
      movement.category !== 'INVOICE_REVERSAL' &&
      movement.affectsDrawer !== false
    ) {
      const evalRes = this.evaluateCashOut(movement.amount, {
        user: options?.user,
        operation: movement.category,
        allowNegativeCash: options?.allowNegativeCash,
        fundingDetails: movement.fundingDetails,
      });
      if (!evalRes.allowed) {
        return { success: false, error: evalRes.reason || 'تعذر تنفيذ حركة السحب النقدي' };
      }
      if (evalRes.mode === 'CAPITAL' && movement.category !== 'SALES_REFUND') {
        movement.affectsDrawer = false;
      }
    }

    const movements = this.getCashMovements();
    movements.unshift(movement);
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);
    return { success: true };
  }

  public recordManualWithdrawal(params: {
    amount: number;
    description: string;
    performedBy: string;
    user?: User | null;
    allowNegativeCash?: boolean;
    fundingDetails?: CashMovementFunding;
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('CASH_OPS', 'سحب نقدي يدوي');
    if (!gate.allowed) return { success: false, error: gate.error };

    const cleanDesc = (params.description || '').trim();
    if (!cleanDesc) {
      return { success: false, error: 'يرجى كتابة سبب أو بيان السحب اليدوي' };
    }

    const evalRes = this.evaluateCashOut(params.amount, {
      user: params.user,
      operation: 'MANUAL_WITHDRAWAL',
      allowNegativeCash: params.allowNegativeCash,
      fundingDetails: params.fundingDetails,
    });

    if (!evalRes.allowed) {
      return { success: false, error: evalRes.reason };
    }

    const affectsDrawer = evalRes.mode !== 'CAPITAL';
    const resolvedFunding: CashMovementFunding = params.fundingDetails
      ? this.validateFundingDetails(params.fundingDetails).normalized!
      : evalRes.mode === 'CAPITAL'
      ? { type: 'EXTERNAL_FUNDING', label: 'رأس مال المحل (لا يؤثر على الدرج)' }
      : { type: 'DRAWER', label: 'نقدية الدرج المباشرة' };

    const fundingText = resolvedFunding.note
      ? `${resolvedFunding.label} — ${resolvedFunding.note}`
      : resolvedFunding.label;

    const now = new Date();
    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: getCairoDateString(now),
        time: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'OUT',
        category: 'DRAWER_ADJUSTMENT',
        categoryLabelArabic: 'سحب نقدي يدوي',
        amount: params.amount,
        description: `سحب يدوي: ${cleanDesc} (${fundingText})`,
        performedBy: params.performedBy,
        fundingSource: resolvedFunding.type,
        fundingDetails: resolvedFunding,
        affectsDrawer,
      },
      { skipCashOutCheck: true, bypassLicenseCheck: true }
    );

    this.addAuditLog(
      'CASH_WITHDRAWAL',
      'سحب نقدي يدوي',
      'الخزينة',
      'drawer',
      `سحب يدوي بقيمة ${params.amount} ج.م: ${cleanDesc} [${fundingText}]`
    );
    this.notifyAction(`سحب نقدي يدوي: ${params.amount} ج.م`);
    return { success: true };
  }

  public recordManualDeposit(params: {
    amount: number;
    description: string;
    performedBy: string;
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('CASH_OPS', 'إيداع نقدي يدوي');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };
    }
    const cleanDesc = (params.description || '').trim() || 'إيداع نقدي بالدرج';
    const now = new Date();

    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: getCairoDateString(now),
        time: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'IN',
        category: 'DRAWER_ADJUSTMENT',
        categoryLabelArabic: 'إيداع نقدي بالدرج',
        amount: params.amount,
        description: cleanDesc,
        performedBy: params.performedBy,
        affectsDrawer: true,
        fundingDetails: { type: 'DRAWER', label: 'إيداع نقدي مباشر بالدرج' },
      },
      { skipCashOutCheck: true, bypassLicenseCheck: true }
    );

    this.addAuditLog('CASH_DEPOSIT', 'إيداع بالدرج', 'الخزينة', 'drawer', `إيداع بالدرج بقيمة ${params.amount} ج.م: ${cleanDesc}`);
    this.notifyAction(`إيداع نقدي بالدرج: ${params.amount} ج.م`);
    return { success: true };
  }

  public recordCapitalInjection(params: {
    amount: number;
    description?: string;
    performedBy: string;
    user?: User | null;
    affectsDrawer?: boolean;
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('CASH_OPS', 'إيداع رأس مال');
    if (!gate.allowed) return { success: false, error: gate.error };

    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      return { success: false, error: 'قيمة إيداع رأس المال يجب أن تكون أكبر من صفر' };
    }
    const actingUser = params.user !== undefined ? params.user : this.getActiveUser();
    if (actingUser && actingUser.role !== 'ADMIN' && !actingUser.permissions?.canManageCash) {
      return { success: false, error: 'غير مصرح بتسجيل إيداعات رأس المال' };
    }

    const cleanDesc = (params.description || '').trim() || 'ضخ / إيداع رأس مال من المالك';
    const now = new Date();
    const resolvedAffectsDrawer =
      params.affectsDrawer !== undefined
        ? Boolean(params.affectsDrawer)
        : this.getAccountingMode() !== 'CAPITAL';

    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: getCairoDateString(now),
        time: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'IN',
        category: 'CAPITAL_INJECTION',
        categoryLabelArabic: 'إيداع رأس مال (غير إيرادي)',
        amount: params.amount,
        description: cleanDesc,
        performedBy: params.performedBy,
        affectsDrawer: resolvedAffectsDrawer,
        fundingSource: 'OWNER_LOAN',
        fundingDetails: { type: 'OWNER_LOAN', label: 'إيداع رأس مال من المالك', note: cleanDesc },
      },
      { skipCashOutCheck: true, bypassLicenseCheck: true }
    );

    this.addAuditLog(
      'CAPITAL_INJECTION',
      'إيداع رأس مال',
      'الخزينة',
      'capital',
      `ضخ رأس مال بقيمة ${params.amount} ج.م (حركة منفصلة غير إيرادية ${resolvedAffectsDrawer ? 'أُودعت بالدرج' : 'لا تؤثر على الدرج'} ولا تدخل في الأرباح): ${cleanDesc}`
    );
    this.notifyAction(`إيداع رأس مال: ${params.amount} ج.م`);
    return { success: true };
  }

  // --- EXPENSES ---
  public getExpenses(): Expense[] {
    return this.getItem<Expense[]>(STORAGE_KEYS.EXPENSES, INITIAL_EXPENSES);
  }

  public recordExpense(
    expense: Expense,
    options?: { user?: User | null; allowNegativeCash?: boolean; fundingDetails?: CashMovementFunding }
  ): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('CASH_OPS', `تسجيل مصروف: ${expense.categoryLabelArabic}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const evalRes = this.evaluateCashOut(expense.amount, {
      user: options?.user,
      operation: 'EXPENSE',
      allowNegativeCash: options?.allowNegativeCash,
      fundingDetails: options?.fundingDetails || expense.fundingDetails,
    });

    if (!evalRes.allowed) {
      return { success: false, error: evalRes.reason };
    }

    const affectsDrawer = evalRes.mode !== 'CAPITAL';
    const rawFunding = options?.fundingDetails || expense.fundingDetails;
    const resolvedFunding: CashMovementFunding = rawFunding
      ? this.validateFundingDetails(rawFunding).normalized!
      : evalRes.mode === 'CAPITAL'
      ? { type: 'EXTERNAL_FUNDING', label: 'رأس مال المحل (لا يؤثر على الدرج)' }
      : { type: 'DRAWER', label: 'نقدية الدرج المباشرة' };

    const expenseToSave: Expense = {
      ...expense,
      fundingDetails: resolvedFunding,
      affectsDrawer,
    };

    const expenses = this.getExpenses();
    expenses.unshift(expenseToSave);
    this.setItem(STORAGE_KEYS.EXPENSES, expenses);

    const fundingText = resolvedFunding.note
      ? `${resolvedFunding.label} — ${resolvedFunding.note}`
      : resolvedFunding.label;

    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: expense.date,
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'OUT',
        category: 'EXPENSE',
        categoryLabelArabic: expense.categoryLabelArabic,
        amount: expense.amount,
        referenceId: expense.id,
        description: `مصروف: ${expense.categoryLabelArabic} - ${expense.notes} (${fundingText})`,
        performedBy: expense.recordedBy,
        fundingSource: resolvedFunding.type,
        fundingDetails: resolvedFunding,
        affectsDrawer,
      },
      { skipCashOutCheck: true, bypassLicenseCheck: true }
    );

    this.addAuditLog(
      'EXPENSE',
      'تسجيل مصروف',
      'المصروفات',
      expense.id,
      `تسجيل مصروف بقيمة ${expense.amount} ج.م - ${expense.categoryLabelArabic} [${fundingText}]`
    );
    this.notifyAction(`تسجيل مصروف: ${expense.categoryLabelArabic}`);
    return { success: true };
  }

  // --- SALES INVOICES: POST, UPDATE, DELETE & NEGATIVE STOCK ---
  public getSalesInvoices(): SalesInvoice[] {
    return this.getItem<SalesInvoice[]>(STORAGE_KEYS.INVOICES, INITIAL_INVOICES);
  }

  public postSalesInvoice(invoice: SalesInvoice): { success: boolean; error?: string; hasNegativeStock?: boolean } {
    const gate = this.assertWriteAllowed('SALES', `إنشاء فاتورة بيع ${invoice.invoiceNumber}`);
    if (!gate.allowed) {
      return {
        success: false,
        error: `لا يمكن إنشاء فاتورة بيع جديدة: ${gate.error}`,
      };
    }

    const products = this.getProducts();
    const customers = this.getCustomers();

    // Enforce non-negative stock in the data layer. Aggregate duplicate
    // invoice lines by product so splitting a quantity across lines cannot bypass the check.
    const requestedByProduct = new Map<string, number>();
    for (const item of invoice.items || []) {
      const quantity = Number(item.piecesCount);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `كمية غير صالحة للصنف ${item.productName || item.productId}.` };
      }
      const prod = products.find(p => p.id === item.productId);
      if (!prod) {
        return { success: false, error: `الصنف غير موجود في المخزون: ${item.productName || item.productId}.` };
      }
      requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) || 0) + quantity);
    }

    for (const [productId, requested] of requestedByProduct) {
      const prod = products.find(p => p.id === productId)!;
      const available = Number(prod.stockPieces) || 0;
      if (requested > available) {
        return {
          success: false,
          hasNegativeStock: true,
          error: `لا يمكن إتمام البيع للصنف "${prod.name}". المتاح ${available} قطعة، والمطلوب ${requested} قطعة. تم إيقاف الفاتورة دون تغيير المخزون أو الحسابات.`,
        };
      }
    }
    invoice.hasNegativeStockItem = false;

    // Apply stock deductions only after every invoice line passes validation.
    for (const [productId, requested] of requestedByProduct) {
      const prod = products.find(p => p.id === productId)!;
      prod.stockPieces -= requested;
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    // Update Customer Balance
    const cust = customers.find(c => c.id === invoice.customerId);
    const previousDebt = cust ? cust.currentBalance : 0;
    invoice.previousCustomerBalance = previousDebt;

    if (invoice.remainingAmount > 0 && cust) {
      cust.currentBalance += invoice.remainingAmount;
      this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    }
    invoice.newCustomerBalance = cust ? cust.currentBalance : 0;

    // Record Cash Movement if cash was paid
    if (invoice.paidAmount > 0) {
      this.addCashMovement(
        {
          id: `cm-${Date.now()}`,
          date: invoice.date,
          time: invoice.time,
          type: 'IN',
          category: 'SALES_CASH',
          categoryLabelArabic: 'مبيعات نقدية',
          amount: invoice.paidAmount,
          referenceId: invoice.invoiceNumber,
          description: `تحصيل فاتورة مبيعات ${invoice.invoiceNumber} - العميل: ${invoice.customerName}`,
          performedBy: invoice.salespersonName,
        },
        { bypassLicenseCheck: true }
      );
    }

    // Save Invoice
    const invoices = this.getSalesInvoices();
    invoices.unshift(invoice);
    this.setItem(STORAGE_KEYS.INVOICES, invoices);

    this.addAuditLog(
      'SALES',
      'إصدار فاتورة مبيعات',
      'فواتير المبيعات',
      invoice.invoiceNumber,
      `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ج.م للعميل: ${invoice.customerName} (ربح الفاتورة: ${invoice.totalProfit} ج.م)`
    );
    this.notifyAction(`فاتورة مبيعات: ${invoice.invoiceNumber}`);

    return { success: true, hasNegativeStock: false };
  }

  // DELETE SALES INVOICE (With full stock restoration and customer debt deletion)
  public deleteSalesInvoice(invoiceId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SALES', `حذف فاتورة مبيعات ${invoiceId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const invoices = this.getSalesInvoices();
    const invoice = invoices.find(inv => inv.id === invoiceId || inv.invoiceNumber === invoiceId);
    if (!invoice) return { success: false, error: 'الفاتورة غير موجودة' };
    if (this.getSalesReturns(invoice.id).length > 0) {
      return { success: false, error: 'لا يمكن حذف فاتورة لها مرتجعات مسجلة. راجع المرتجعات المرتبطة بها أولاً.' };
    }

    // Validate every linked record before preparing any mutation.
    if (!Array.isArray(invoice.items) || invoice.items.length === 0) {
      return { success: false, error: 'لا يمكن حذف الفاتورة: تفاصيل الأصناف غير موجودة أو غير مكتملة.' };
    }
    const paidAmount = Number(invoice.paidAmount ?? 0);
    const remainingAmount = Number(invoice.remainingAmount ?? 0);
    if (!Number.isFinite(paidAmount) || paidAmount < 0 ||
        !Number.isFinite(remainingAmount) || remainingAmount < 0) {
      return { success: false, error: 'لا يمكن حذف الفاتورة: بيانات المبالغ غير صالحة.' };
    }

    const products = this.getProducts();
    const customers = this.getCustomers();
    const nextProducts = products.map(product => ({ ...product }));
    const quantitiesByProduct = new Map<string, number>();

    for (const item of invoice.items) {
      const quantity = Number(item.piecesCount);
      if (!item.productId || !Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `لا يمكن حذف الفاتورة: بيانات كمية أو صنف غير صالحة (${item.productName || item.productId || 'غير معروف'}).` };
      }
      if (!products.some(product => product.id === item.productId)) {
        return { success: false, error: `لا يمكن حذف الفاتورة: الصنف المرتبط بها غير موجود في المخزون (${item.productName || item.productId}).` };
      }
      quantitiesByProduct.set(item.productId, (quantitiesByProduct.get(item.productId) || 0) + quantity);
    }

    for (const [productId, quantity] of quantitiesByProduct) {
      const product = nextProducts.find(p => p.id === productId)!;
      const currentStock = Number(product.stockPieces);
      if (!Number.isFinite(currentStock) || currentStock < 0) {
        return { success: false, error: `لا يمكن حذف الفاتورة: رصيد المخزون غير صالح للصنف ${product.name}.` };
      }
      product.stockPieces = currentStock + quantity;
    }

    const nextCustomers = customers.map(customer => ({ ...customer }));
    if (remainingAmount > 0) {
      const customer = nextCustomers.find(c => c.id === invoice.customerId);
      if (!customer) {
        return { success: false, error: 'لا يمكن حذف الفاتورة: العميل المرتبط بها غير موجود، ولا يمكن تسوية مديونيته بأمان.' };
      }
      const currentBalance = Number(customer.currentBalance);
      if (!Number.isFinite(currentBalance) || currentBalance < 0) {
        return { success: false, error: 'لا يمكن حذف الفاتورة: رصيد العميل غير صالح.' };
      }
      customer.currentBalance = Math.max(0, Math.round((currentBalance - remainingAmount) * 100) / 100);
    }

    // All linked records passed validation; now apply the prepared changes.
    this.setItem(STORAGE_KEYS.PRODUCTS, nextProducts);
    if (remainingAmount > 0) {
      this.setItem(STORAGE_KEYS.CUSTOMERS, nextCustomers);
    }

    if (paidAmount > 0) {
      this.addCashMovement(
        {
          id: `cm-${Date.now()}`,
          date: getCairoDateString(),
          time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
          type: 'OUT',
          category: 'INVOICE_REVERSAL',
          categoryLabelArabic: 'إلغاء فاتورة مبيعات',
          amount: paidAmount,
          referenceId: invoice.invoiceNumber,
          description: `رد نقدية لحذف فاتورة المبيعات رقم ${invoice.invoiceNumber}`,
          performedBy: this.getActiveUser()?.fullName || 'النظام',
        },
        { bypassLicenseCheck: true }
      );
    }

    this.setItem(STORAGE_KEYS.INVOICES, invoices.filter(inv => inv.id !== invoice.id));
    this.addAuditLog(
      'SALES',
      'حذف فاتورة مبيعات',
      'فواتير المبيعات',
      invoice.invoiceNumber,
      `تم حذف الفاتورة ${invoice.invoiceNumber} وإرجاع بضاعة الأصناف للمخزن وحذف مديونية العميل (${remainingAmount} ج.م)`
    );
    this.notifyAction(`حذف فاتورة: ${invoice.invoiceNumber}`);

    return { success: true };
  }

  // UPDATE SALES INVOICE (Edit existing invoice)
  public updateSalesInvoice(updatedInvoice: SalesInvoice): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SALES', `تعديل فاتورة مبيعات ${updatedInvoice.invoiceNumber}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const invoices = this.getSalesInvoices();
    const oldIndex = invoices.findIndex(inv => inv.id === updatedInvoice.id);
    if (oldIndex === -1) return { success: false, error: 'الفاتورة غير موجودة' };

    const oldInvoice = invoices[oldIndex];
    if (this.getSalesReturns(oldInvoice.id).length > 0) {
      return {
        success: false,
        error: 'لا يمكن تعديل فاتورة لها مرتجعات مسجلة؛ لأن المرتجعات مرتبطة بأصناف وكميات الفاتورة الأصلية. راجع المرتجعات أولاً.',
      };
    }

    const products = this.getProducts();
    const customers = this.getCustomers();
    const nextCustomerId = updatedInvoice.customerId;
    const oldCustomerId = oldInvoice.customerId;
    const nextCustomer = customers.find(c => c.id === nextCustomerId);
    const oldCustomer = customers.find(c => c.id === oldCustomerId);
    const oldDebt = Number(oldInvoice.remainingAmount ?? 0);
    const nextDebt = Number(updatedInvoice.remainingAmount);
    const oldPaid = Number(oldInvoice.paidAmount ?? 0);
    const nextPaid = Number(updatedInvoice.paidAmount);

    if (!nextCustomer) {
      return { success: false, error: 'لا يمكن تعديل الفاتورة: العميل المحدد غير موجود في سجل العملاء.' };
    }
    if (oldDebt > 0 && !oldCustomer) {
      return { success: false, error: 'لا يمكن تعديل الفاتورة: حساب العميل الأصلي غير موجود، ولا يمكن تسوية مديونيته بأمان.' };
    }
    if (![oldDebt, nextDebt, oldPaid, nextPaid, Number(updatedInvoice.total)].every(Number.isFinite) ||
        oldDebt < 0 || nextDebt < 0 || oldPaid < 0 || nextPaid < 0 || Number(updatedInvoice.total) < 0) {
      return { success: false, error: 'لا يمكن تعديل الفاتورة: توجد مبالغ غير صالحة في بيانات الدفع أو المديونية.' };
    }

    // Calculate stock changes without mutating the cached records.
    const projectedStock = new Map<string, number>();
    for (const product of products) {
      const current = Number(product.stockPieces);
      if (!Number.isFinite(current) || current < 0) {
        return { success: false, error: `رصيد المخزون غير صالح للصنف: ${product.name}.` };
      }
      projectedStock.set(product.id, current);
    }

    for (const item of oldInvoice.items || []) {
      const current = projectedStock.get(item.productId);
      const quantity = Number(item.piecesCount);
      if (current === undefined || !Number.isFinite(quantity) || quantity < 0) {
        return {
          success: false,
          error: `لا يمكن تعديل الفاتورة: بيانات الصنف الأصلي غير مكتملة (${item.productName || item.productId}).`,
        };
      }
      projectedStock.set(item.productId, current + quantity);
    }

    if (!Array.isArray(updatedInvoice.items) || updatedInvoice.items.length === 0) {
      return { success: false, error: 'لا يمكن حفظ فاتورة بيع بدون أصناف.' };
    }

    const requestedByProduct = new Map<string, number>();
    for (const item of updatedInvoice.items) {
      const quantity = Number(item.piecesCount);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `كمية غير صالحة للصنف ${item.productName || item.productId}.` };
      }
      const product = products.find(p => p.id === item.productId);
      if (!product) {
        return { success: false, error: `الصنف غير موجود في المخزون: ${item.productName || item.productId}.` };
      }
      requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) || 0) + quantity);
    }

    for (const [productId, requested] of requestedByProduct) {
      const product = products.find(p => p.id === productId)!;
      const availableAfterReversal = projectedStock.get(productId) || 0;
      if (requested > availableAfterReversal) {
        return {
          success: false,
          error: `لا يمكن تعديل الفاتورة: المتاح من الصنف "${product.name}" بعد إلغاء أثر الفاتورة القديمة هو ${availableAfterReversal} قطعة، والمطلوب ${requested} قطعة.`,
        };
      }
      projectedStock.set(productId, availableAfterReversal - requested);
    }

    // Prepare all related records before applying any changes.
    const nextProducts = products.map(product => ({
      ...product,
      stockPieces: projectedStock.get(product.id) ?? product.stockPieces,
    }));
    const nextCustomers = customers.map(customer => ({ ...customer }));
    const nextOldCustomer = nextCustomers.find(c => c.id === oldCustomerId);
    const nextCustomerRecord = nextCustomers.find(c => c.id === nextCustomerId)!;
    const previousNewCustomerBalance = Number(nextCustomerRecord.currentBalance) || 0;

    if (oldCustomerId === nextCustomerId) {
      nextCustomerRecord.currentBalance = Math.round((previousNewCustomerBalance - oldDebt + nextDebt) * 100) / 100;
    } else {
      if (oldDebt > 0 && nextOldCustomer) {
        nextOldCustomer.currentBalance = Math.round((Number(nextOldCustomer.currentBalance) - oldDebt) * 100) / 100;
      }
      nextCustomerRecord.currentBalance = Math.round((previousNewCustomerBalance + nextDebt) * 100) / 100;
    }

    updatedInvoice.previousCustomerBalance = previousNewCustomerBalance;
    updatedInvoice.newCustomerBalance = nextCustomerRecord.currentBalance;

    // Keep the drawer ledger aligned with edited invoice payments:
    // reverse the old collected amount, then record the newly collected amount.
    const nextCashMovements = this.getCashMovements().slice();
    const now = new Date();
    const date = getCairoDateString(now);
    const time = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const actor = this.getActiveUser()?.fullName || updatedInvoice.salespersonName || 'النظام';
    const movementId = () => `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (oldPaid > 0) {
      nextCashMovements.unshift({
        id: movementId(),
        date,
        time,
        type: 'OUT',
        category: 'INVOICE_REVERSAL',
        categoryLabelArabic: 'عكس تحصيل فاتورة معدلة',
        amount: oldPaid,
        referenceId: oldInvoice.invoiceNumber,
        description: `عكس المبلغ المحصل سابقاً عند تعديل فاتورة المبيعات ${oldInvoice.invoiceNumber}`,
        performedBy: actor,
      });
    }
    if (nextPaid > 0) {
      nextCashMovements.unshift({
        id: movementId(),
        date: updatedInvoice.date || date,
        time: updatedInvoice.time || time,
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'تحصيل فاتورة مبيعات معدلة',
        amount: nextPaid,
        referenceId: updatedInvoice.invoiceNumber,
        description: `المبلغ المحصل بعد تعديل فاتورة المبيعات ${updatedInvoice.invoiceNumber} - العميل: ${updatedInvoice.customerName}`,
        performedBy: updatedInvoice.salespersonName || actor,
      });
    }

    updatedInvoice.status = 'MODIFIED';
    const nextInvoices = invoices.slice();
    nextInvoices[oldIndex] = updatedInvoice;

    // All validation is complete. Apply the prepared records.
    this.setItem(STORAGE_KEYS.PRODUCTS, nextProducts);
    this.setItem(STORAGE_KEYS.CUSTOMERS, nextCustomers);
    if (oldPaid > 0 || nextPaid > 0) {
      this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, nextCashMovements);
    }
    this.setItem(STORAGE_KEYS.INVOICES, nextInvoices);

    this.addAuditLog(
      'SALES',
      'تعديل فاتورة مبيعات',
      'فواتير المبيعات',
      updatedInvoice.invoiceNumber,
      `تم تعديل الفاتورة ${updatedInvoice.invoiceNumber} بقيمة جديدة ${updatedInvoice.total} ج.م`
    );
    this.notifyAction(`تعديل فاتورة: ${updatedInvoice.invoiceNumber}`);

    return { success: true };
  }

  // --- SEQUENTIAL DOCUMENT NUMBERING (INV / PUR / RET) ---
  public nextDocumentNumber(prefix: 'INV' | 'PUR' | 'RET', date?: Date): string {
    const year = (date || new Date()).getFullYear();
    const seqKey = `${prefix}-${year}`;
    const storedSequences = this.getItem<Record<string, number>>(STORAGE_KEYS.DOCUMENT_SEQUENCES, {});
    const sequences = storedSequences && typeof storedSequences === 'object' ? { ...storedSequences } : {};

    let maxExisting = 0;
    const regex = new RegExp(`^${prefix}-${year}-(\\d+)$`);
    const existingNumbers =
      prefix === 'INV'
        ? this.getSalesInvoices().map(inv => inv.invoiceNumber)
        : prefix === 'PUR'
        ? this.getPurchases().map(pur => pur.invoiceNumber)
        : this.getSalesReturns().map(ret => ret.returnNumber);

    for (const docNum of existingNumbers) {
      if (typeof docNum === 'string') {
        const m = docNum.match(regex);
        if (m) {
          const parsed = parseInt(m[1], 10);
          if (Number.isFinite(parsed) && parsed > maxExisting) {
            maxExisting = parsed;
          }
        }
      }
    }

    const nextSeq = Math.max(sequences[seqKey] || 0, maxExisting) + 1;
    sequences[seqKey] = nextSeq;
    this.setItem(STORAGE_KEYS.DOCUMENT_SEQUENCES, sequences);

    return `${prefix}-${year}-${String(nextSeq).padStart(5, '0')}`;
  }

  // --- SALES RETURNS (مرتجعات المبيعات) ---
  public getSalesReturns(invoiceId?: string): SalesReturn[] {
    const list = this.getItem<SalesReturn[]>(STORAGE_KEYS.SALES_RETURNS, []);
    if (!Array.isArray(list)) {
      this.setItem(STORAGE_KEYS.SALES_RETURNS, []);
      return [];
    }
    return invoiceId ? list.filter(r => r.originalInvoiceId === invoiceId) : list;
  }

  public getInvoiceLineKey(item: InvoiceLineItem): string {
    return item.id || `${item.productId}::${item.unit}`;
  }

  public getReturnedQtyByInvoice(invoiceId: string): Record<string, number> {
    const returns = this.getSalesReturns(invoiceId);
    const map: Record<string, number> = {};
    for (const ret of returns) {
      for (const it of ret.items) {
        const key = it.itemKey || `${it.productId}::${it.unit}`;
        map[key] = Math.round(((map[key] || 0) + Number(it.quantity || 0)) * 1000) / 1000;
      }
    }
    return map;
  }

  public getInvoiceReturnSummary(invoice: SalesInvoice): {
    status: 'NONE' | 'PARTIAL' | 'FULL';
    totalSoldQty: number;
    totalReturnedQty: number;
    totalReturnedAmount: number;
    returnedCount: number;
    returnedQtyByKey: Record<string, number>;
  } {
    const returns = this.getSalesReturns(invoice.id);
    const returnedQtyByKey: Record<string, number> = {};
    for (const ret of returns) {
      for (const it of ret.items) {
        const key = it.itemKey || `${it.productId}::${it.unit}`;
        returnedQtyByKey[key] = Math.round(((returnedQtyByKey[key] || 0) + Number(it.quantity || 0)) * 1000) / 1000;
      }
    }

    let totalSoldQty = 0;
    let totalReturnedQty = 0;
    let allItemsFullyReturned = invoice.items.length > 0;

    for (const orig of invoice.items) {
      const key = this.getInvoiceLineKey(orig);
      const fallbackKey = `${orig.productId}::${orig.unit}`;
      const returnedForItem =
        returnedQtyByKey[key] !== undefined
          ? returnedQtyByKey[key]
          : (returnedQtyByKey[fallbackKey] || 0);
      totalSoldQty += Number(orig.quantity || 0);
      totalReturnedQty += returnedForItem;
      if (returnedForItem + 1e-6 < Number(orig.quantity || 0)) {
        allItemsFullyReturned = false;
      }
    }

    const totalReturnedAmount = Math.round(returns.reduce((s, r) => s + Number(r.totalAmount || 0), 0) * 100) / 100;
    const status: 'NONE' | 'PARTIAL' | 'FULL' =
      returns.length === 0 || totalReturnedQty <= 1e-6
        ? 'NONE'
        : allItemsFullyReturned
        ? 'FULL'
        : 'PARTIAL';

    return {
      status,
      totalSoldQty: Math.round(totalSoldQty * 1000) / 1000,
      totalReturnedQty: Math.round(totalReturnedQty * 1000) / 1000,
      totalReturnedAmount,
      returnedCount: returns.length,
      returnedQtyByKey,
    };
  }

  public canInvoiceRefundToCustomerCredit(invoice: SalesInvoice): {
    eligible: boolean;
    customer?: Customer;
    reason?: string;
  } {
    if (
      !invoice.customerId ||
      invoice.customerId === 'cust-walkin' ||
      invoice.customerId === 'walk-in' ||
      invoice.customerId === 'c-cash'
    ) {
      return {
        eligible: false,
        reason: 'هذه الفاتورة لعميل نقدي مباشر؛ رد المبلغ كرصيد متاح فقط لفواتير العملاء المسجلين على حساب.',
      };
    }

    const customer = this.getCustomers().find(c => c.id === invoice.customerId);
    if (!customer) {
      return {
        eligible: false,
        reason: 'حساب العميل المرتبط بهذه الفاتورة غير موجود في سجل العملاء.',
      };
    }

    const isCustomerAccount =
      invoice.paymentType === 'CREDIT' ||
      invoice.paymentType === 'SPLIT' ||
      invoice.remainingAmount > 0 ||
      Boolean(customer.isCreditAllowed) ||
      customer.currentBalance !== 0;

    if (!isCustomerAccount) {
      return {
        eligible: false,
        customer,
        reason: 'هذه الفاتورة مدفوعة نقداً لعميل غير مفعل له حساب آجل؛ يمكن الرد نقداً من الدرج.',
      };
    }

    return { eligible: true, customer };
  }

  public processSalesReturn(params: {
    invoiceId: string;
    items: Array<{
      invoiceItemId?: string;
      productId: string;
      unit?: 'CARTON' | 'PIECE' | 'KG' | 'GRAM';
      quantity: number;
    }>;
    reason: SalesReturnReason;
    reasonNote?: string;
    refundMethod: SalesReturnRefundMethod;
    returnToStock: boolean;
    user?: User | null;
    allowNegativeCash?: boolean;
    fundingDetails?: CashMovementFunding;
  }): { success: boolean; error?: string; salesReturn?: SalesReturn } {
    const gate = this.assertWriteAllowed('RETURNS', `مرتجع مبيعات على الفاتورة ${params.invoiceId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    // 1. Permission check
    const actingUser = params.user !== undefined ? params.user : this.getActiveUser();
    if (
      !actingUser ||
      actingUser.isActive === false ||
      (actingUser.role !== 'ADMIN' && !actingUser.permissions?.canProcessReturns)
    ) {
      return { success: false, error: 'غير مصرح: ليس لديك صلاحية تسجيل مرتجعات المبيعات' };
    }

    // 2. Invoice lookup
    const invoices = this.getSalesInvoices();
    const invoice = invoices.find(inv => inv.id === params.invoiceId || inv.invoiceNumber === params.invoiceId);
    if (!invoice) {
      return { success: false, error: 'فاتورة المبيعات الأصلية غير موجودة' };
    }

    // 3. Reason validation
    if (!params.reason || !SALES_RETURN_REASON_LABELS[params.reason]) {
      return { success: false, error: 'يرجى تحديد سبب المرتجع' };
    }
    const cleanReasonNote = (params.reasonNote || '').trim();
    if (params.reason === 'OTHER' && !cleanReasonNote) {
      return { success: false, error: 'عند اختيار سبب "أخرى" يجب كتابة توضيح سبب المرتجع في مربع النص الإلزامي.' };
    }

    // 4. Items validation & remaining quantity check
    if (!Array.isArray(params.items) || params.items.length === 0) {
      return { success: false, error: 'يرجى اختيار صنف واحد على الأقل بكمية مرتجعة موجبة' };
    }

    const products = this.getProducts();
    const summary = this.getInvoiceReturnSummary(invoice);
    const requestedPerKey: Record<string, number> = {};
    const returnItems: SalesReturnItem[] = [];

    for (const req of params.items) {
      const qty = Number(req.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, error: 'الكمية المرتجعة يجب أن تكون أكبر من صفر' };
      }

      const origItem = invoice.items.find(it => {
        if (req.invoiceItemId && it.id === req.invoiceItemId) return true;
        if (req.invoiceItemId) return false;
        return it.productId === req.productId && (!req.unit || it.unit === req.unit);
      });

      if (!origItem) {
        return { success: false, error: 'أحد الأصناف المختارة غير موجود في فاتورة البيع الأصلية' };
      }

      const lineKey = this.getInvoiceLineKey(origItem);
      const fallbackKey = `${origItem.productId}::${origItem.unit}`;
      const alreadyReturned =
        summary.returnedQtyByKey[lineKey] !== undefined
          ? summary.returnedQtyByKey[lineKey]
          : (summary.returnedQtyByKey[fallbackKey] || 0);
      const batchRequested = (requestedPerKey[lineKey] || 0) + qty;
      const maxReturnable = Math.max(0, Math.round((origItem.quantity - alreadyReturned) * 1000) / 1000);

      if (batchRequested > maxReturnable + 1e-6) {
        return {
          success: false,
          error: `الكمية المرتجعة للصنف (${origItem.productName}) تتجاوز المتاح للاسترجاع (${maxReturnable}) بعد خصم المرتجعات السابقة.`,
        };
      }
      requestedPerKey[lineKey] = batchRequested;

      const prod = products.find(p => p.id === origItem.productId);
      const piecesPerUnit =
        origItem.unit === 'KG'
          ? 1
          : origItem.unit === 'CARTON'
          ? (origItem.quantity > 0 && origItem.piecesCount > 0
              ? origItem.piecesCount / origItem.quantity
              : (prod?.piecesPerWholesaleUnit || 1))
          : 1;

      const normalizedQty = origItem.unit === 'KG' ? Math.round(qty * 1000) / 1000 : qty;
      const piecesCount =
        origItem.unit === 'KG'
          ? normalizedQty
          : Math.round(normalizedQty * piecesPerUnit * 1000) / 1000;

      const unitSellingPrice = Number(origItem.unitPrice) || 0;
      const fallbackUnitCost = prod
        ? (origItem.unit === 'CARTON' ? prod.costPricePerCarton : prod.costPricePerBase)
        : 0;
      const unitCostPrice = origItem.costPrice !== undefined ? Number(origItem.costPrice) : fallbackUnitCost;

      const subtotal = Math.round(normalizedQty * unitSellingPrice * 100) / 100;
      const costTotal = Math.round(normalizedQty * unitCostPrice * 100) / 100;

      returnItems.push({
        itemKey: lineKey,
        productId: origItem.productId,
        productCode: origItem.productCode || prod?.code || '-',
        productName: origItem.productName,
        unit: origItem.unit,
        unitLabel: origItem.unitLabel,
        quantity: normalizedQty,
        piecesCount,
        unitSellingPrice,
        unitCostPrice,
        subtotal,
        costTotal,
      });
    }

    const subtotal = Math.round(returnItems.reduce((s, it) => s + it.subtotal, 0) * 100) / 100;
    const totalCost = Math.round(returnItems.reduce((s, it) => s + it.costTotal, 0) * 100) / 100;

    // Apply proportional invoice-level discount if original invoice had a discount
    let discountAdjustedAmount = 0;
    if (invoice.discountAmount > 0 && invoice.subtotal > 0) {
      const discountRatio = Math.max(0, Math.min(1, invoice.discountAmount / invoice.subtotal));
      discountAdjustedAmount = Math.round(subtotal * discountRatio * 100) / 100;
    }
    let totalAmount = Math.max(0, Math.round((subtotal - discountAdjustedAmount) * 100) / 100);
    const maxRemainingInvoiceAmount = Math.max(0, Math.round((invoice.total - summary.totalReturnedAmount) * 100) / 100);
    if (totalAmount > maxRemainingInvoiceAmount) {
      totalAmount = maxRemainingInvoiceAmount;
      discountAdjustedAmount = Math.max(0, Math.round((subtotal - totalAmount) * 100) / 100);
    }
    const totalProfitReversed = Math.round((totalAmount - totalCost) * 100) / 100;

    // 5. Refund Method checks BEFORE applying any side effects
    let resolvedFunding: CashMovementFunding | undefined;
    const customers = this.getCustomers();
    let targetCustomer: Customer | undefined;

    if (params.refundMethod === 'CUSTOMER_CREDIT') {
      const creditEligibility = this.canInvoiceRefundToCustomerCredit(invoice);
      if (!creditEligibility.eligible) {
        return { success: false, error: creditEligibility.reason };
      }
      targetCustomer = customers.find(c => c.id === invoice.customerId);
      if (!targetCustomer) {
        return { success: false, error: 'حساب العميل غير موجود' };
      }
    } else if (params.refundMethod === 'CASH') {
      if (totalAmount > 0) {
        const evalRes = this.evaluateCashOut(totalAmount, {
          user: actingUser,
          operation: 'SALES_REFUND',
          allowNegativeCash: params.allowNegativeCash,
          fundingDetails: params.fundingDetails,
        });
        if (!evalRes.allowed) {
          return { success: false, error: evalRes.reason };
        }
        resolvedFunding = params.fundingDetails
          ? this.validateFundingDetails(params.fundingDetails).normalized!
          : { type: 'DRAWER', label: 'نقدية الدرج المباشرة' };
      }
    } else {
      return { success: false, error: 'طريقة رد المرتجع غير صالحة' };
    }

    // 6. Execute state changes (stock, customer balance / cash movement, record, audit log)
    const now = new Date();
    const dateStr = getCairoDateString(now);
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const returnNumber = this.nextDocumentNumber('RET', now);

    if (params.returnToStock) {
      for (const item of returnItems) {
        const prod = products.find(p => p.id === item.productId);
        if (prod) {
          prod.stockPieces = Math.round((prod.stockPieces + item.piecesCount) * 1000) / 1000;
        }
      }
      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }

    if (params.refundMethod === 'CUSTOMER_CREDIT' && targetCustomer) {
      targetCustomer.currentBalance = Math.round((targetCustomer.currentBalance - totalAmount) * 100) / 100;
      this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    } else if (params.refundMethod === 'CASH' && totalAmount > 0) {
      const fundingLabel = resolvedFunding?.note
        ? `${resolvedFunding.label} — ${resolvedFunding.note}`
        : (resolvedFunding?.label || 'نقدية الدرج المباشرة');

      this.addCashMovement(
        {
          id: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          date: dateStr,
          time: timeStr,
          type: 'OUT',
          category: 'SALES_REFUND',
          categoryLabelArabic: 'مرتجع مبيعات نقدي',
          amount: totalAmount,
          referenceId: returnNumber,
          description: `رد نقدي لمرتجع مبيعات ${returnNumber} (فاتورة ${invoice.invoiceNumber}) - ${invoice.customerName} (${fundingLabel})`,
          performedBy: actingUser.fullName,
          fundingSource: resolvedFunding?.type || 'DRAWER',
          fundingDetails: resolvedFunding || { type: 'DRAWER', label: 'نقدية الدرج المباشرة' },
          affectsDrawer: true, // Cash sales refunds ALWAYS affect drawer
        },
        { skipCashOutCheck: true, bypassLicenseCheck: true }
      );
    }

    const salesReturn: SalesReturn = {
      id: `ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      returnNumber,
      date: dateStr,
      time: timeStr,
      originalInvoiceId: invoice.id,
      originalInvoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      items: returnItems,
      reason: params.reason,
      reasonLabelArabic: SALES_RETURN_REASON_LABELS[params.reason],
      reasonNote: cleanReasonNote || undefined,
      refundMethod: params.refundMethod,
      returnToStock: Boolean(params.returnToStock),
      subtotal,
      discountAdjustedAmount,
      totalAmount,
      totalCost,
      totalProfitReversed,
      performedByUserId: actingUser.id,
      performedBy: actingUser.fullName,
      fundingDetails: resolvedFunding,
      affectsDrawer: params.refundMethod === 'CASH',
    };

    const allReturns = this.getSalesReturns();
    allReturns.unshift(salesReturn);
    this.setItem(STORAGE_KEYS.SALES_RETURNS, allReturns);

    const reasonText = cleanReasonNote
      ? `${SALES_RETURN_REASON_LABELS[params.reason]} (${cleanReasonNote})`
      : SALES_RETURN_REASON_LABELS[params.reason];

    this.addAuditLog(
      'SALES_RETURN',
      'تسجيل مرتجع مبيعات',
      'مرتجعات المبيعات',
      returnNumber,
      `مرتجع ${returnNumber} على الفاتورة ${invoice.invoiceNumber} بقيمة ${totalAmount} ج.م • الرد: ${params.refundMethod === 'CASH' ? 'نقدي من الدرج' : 'رصيد للعميل'} • المخزن: ${params.returnToStock ? 'أُعيد للمخزن' : 'تالف لم يُعد'} • السبب: ${reasonText}`
    );
    this.notifyAction(`مرتجع مبيعات: ${returnNumber}`);

    return { success: true, salesReturn };
  }

  // --- CUSTOMER DEBT COLLECTION (سند قبض) ---
  public recordCustomerCollection(params: {
    customerId: string;
    amount: number;
    notes?: string;
    collectedBy: string;
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('COLLECTIONS', `سند قبض عميل ${params.customerId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const customers = this.getCustomers();
    const cust = customers.find(c => c.id === params.customerId);
    if (!cust) return { success: false, error: 'العميل غير موجود' };
    if (params.amount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    cust.currentBalance -= params.amount;
    this.setItem(STORAGE_KEYS.CUSTOMERS, customers);

    const voucherNum = `RCV-${Date.now().toString().slice(-6)}`;
    const now = new Date();
    const dateStr = getCairoDateString(now);
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: dateStr,
        time: timeStr,
        type: 'IN',
        category: 'CUSTOMER_COLLECTION',
        categoryLabelArabic: 'سند تحصيل مديونية عميل',
        amount: params.amount,
        referenceId: voucherNum,
        description: `سند قبض رقم ${voucherNum} من العميل: ${cust.name} ${params.notes ? `(${params.notes})` : ''}`,
        performedBy: params.collectedBy,
      },
      { bypassLicenseCheck: true }
    );

    this.addAuditLog(
      'COLLECTION',
      'سند قبض عميل',
      'العملاء',
      cust.id,
      `تحصيل مبلغ ${params.amount} ج.م من العميل: ${cust.name}، الرصيد المتبقي: ${cust.currentBalance} ج.م`
    );
    this.notifyAction(`سند تحصيل عميل: ${cust.name}`);

    return { success: true };
  }

  // --- SUPPLIER PAYMENT (سند صرف مورد مع الفحص الموحد ومصدر التمويل المنظم) ---
  public recordSupplierPayment(params: {
    supplierId: string;
    amount: number;
    notes?: string;
    paidBy: string;
    user?: User | null;
    allowNegativeCash?: boolean;
    fundingDetails?: CashMovementFunding;
    fundingSource?: FundingSourceType | 'PERSONAL_LOAN' | 'DRAWER_NEGATIVE' | 'DRAWER' | 'OTHER';
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SUPPLIER_PAYMENTS', `سند صرف مورد ${params.supplierId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === params.supplierId);
    if (!supp) return { success: false, error: 'المورد غير موجود' };
    if (params.amount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    // Normalize legacy fundingSource enum if passed without fundingDetails
    let resolvedInputFunding: CashMovementFunding | undefined = params.fundingDetails;
    if (!resolvedInputFunding && params.fundingSource) {
      const legacyMap: Record<string, { type: FundingSourceType; label: string }> = {
        DRAWER: { type: 'DRAWER', label: 'نقدية الدرج المباشرة' },
        PERSONAL_LOAN: { type: 'OWNER_LOAN', label: 'سلفة / تمويل شخصي من صاحب العمل' },
        OWNER_LOAN: { type: 'OWNER_LOAN', label: 'سلفة / تمويل شخصي من صاحب العمل' },
        CUSTODY: { type: 'CUSTODY', label: 'عهدة نقدية خارجية مستلمة' },
        EXTERNAL_FUNDING: { type: 'EXTERNAL_FUNDING', label: 'تمويل خارجي مستقل' },
        DRAWER_NEGATIVE: { type: 'DRAWER_NEGATIVE', label: 'سحب مباشر بالسالب مع تسوية الوردية لاحقاً' },
        OTHER: { type: 'OTHER', label: 'أخرى (مصدر مخصص)' },
      };
      const mapped = legacyMap[params.fundingSource];
      if (mapped) {
        resolvedInputFunding = { type: mapped.type, label: mapped.label };
      }
    }

    const evalRes = this.evaluateCashOut(params.amount, {
      user: params.user,
      operation: 'SUPPLIER_PAYMENT',
      allowNegativeCash: params.allowNegativeCash,
      fundingDetails: resolvedInputFunding,
    });

    if (!evalRes.allowed) {
      return { success: false, error: evalRes.reason };
    }

    const affectsDrawer = evalRes.mode !== 'CAPITAL';
    const finalFunding: CashMovementFunding = resolvedInputFunding
      ? this.validateFundingDetails(resolvedInputFunding).normalized!
      : evalRes.mode === 'CAPITAL'
      ? { type: 'EXTERNAL_FUNDING', label: 'رأس مال المحل (لا يؤثر على الدرج)' }
      : { type: 'DRAWER', label: 'نقدية الدرج المباشرة' };

    supp.currentBalance -= params.amount;
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);

    const voucherNum = `PAY-${Date.now().toString().slice(-6)}`;
    const now = new Date();
    const dateStr = getCairoDateString(now);
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    const fundingLabel = finalFunding.note
      ? `${finalFunding.label} — ${finalFunding.note}`
      : finalFunding.label;

    this.addCashMovement(
      {
        id: `cm-${Date.now()}`,
        date: dateStr,
        time: timeStr,
        type: 'OUT',
        category: 'SUPPLIER_PAYMENT',
        categoryLabelArabic: 'سند صرف مورد',
        amount: params.amount,
        referenceId: voucherNum,
        supplierId: supp.id,
        supplierName: supp.name,
        fundingSource: finalFunding.type,
        fundingDetails: finalFunding,
        affectsDrawer,
        description: `سند صرف للمورد: ${supp.name} (${fundingLabel}) ${params.notes ? `• ${params.notes}` : ''}`,
        performedBy: params.paidBy,
      },
      { skipCashOutCheck: true, bypassLicenseCheck: true }
    );

    this.addAuditLog(
      'PAYMENT',
      'سند صرف مورد',
      'الموردين',
      supp.id,
      `صرف مبلغ ${params.amount} ج.م للمورد: ${supp.name} (${fundingLabel})، المتبقي له: ${supp.currentBalance} ج.م`
    );
    this.notifyAction(`سند صرف مورد: ${supp.name}`);

    return { success: true };
  }

  // احضار سجل دفعات الموردين
  public getSupplierPayments(supplierId?: string): CashMovement[] {
    const movements = this.getCashMovements();
    return movements.filter(m => {
      if (m.category !== 'SUPPLIER_PAYMENT') return false;
      if (supplierId && m.supplierId !== supplierId) return false;
      return true;
    });
  }

  // تعديل دفعة مورد
  public updateSupplierPayment(movementId: string, newAmount: number, newNotes?: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SUPPLIER_PAYMENTS', `تعديل سند صرف مورد ${movementId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    if (newAmount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };
    const movements = this.getCashMovements();
    const idx = movements.findIndex(m => m.id === movementId);
    if (idx === -1) return { success: false, error: 'حركة الدفع غير موجودة' };

    const oldMovement = movements[idx];
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === oldMovement.supplierId);

    if (supp) {
      // الفرق في المبلغ: إذا زاد المبلغ المصروف يقل رصيد المورد، والعكس
      const diff = newAmount - oldMovement.amount;
      supp.currentBalance -= diff;
      this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    }

    oldMovement.amount = newAmount;
    if (newNotes) {
      oldMovement.description = `سند صرف للمورد: ${oldMovement.supplierName || ''} • ${newNotes}`;
    }
    movements[idx] = oldMovement;
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);

    this.addAuditLog(
      'PAYMENT_UPDATE',
      'تعديل سند صرف مورد',
      'سندات الصرف',
      movementId,
      `تم تعديل سند صرف بقيمة ${newAmount} ج.م للمورد: ${oldMovement.supplierName || ''}`
    );

    return { success: true };
  }

  // حذف دفعة مورد (إلغاء سند الصرف ورد المديونية)
  public deleteSupplierPayment(movementId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SUPPLIER_PAYMENTS', `حذف سند صرف مورد ${movementId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const movements = this.getCashMovements();
    const target = movements.find(m => m.id === movementId);
    if (!target) return { success: false, error: 'حركة الدفع غير موجودة' };

    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === target.supplierId);
    if (supp) {
      supp.currentBalance += target.amount; // إعادة المبلغ لمستحقات المورد
      this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    }

    const filtered = movements.filter(m => m.id !== movementId);
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, filtered);

    this.addAuditLog(
      'PAYMENT_DELETE',
      'حذف سند صرف مورد',
      'سندات الصرف',
      movementId,
      `تم حذف سند صرف بقيمة ${target.amount} ج.م وإعادة المبلغ لمستحقات المورد: ${target.supplierName || ''}`
    );

    return { success: true };
  }

  // كشف حساب المورد مع الفواتير والدفعات
  public getSupplierStatement(supplierId: string): {
    supplier: Supplier;
    purchases: PurchaseInvoice[];
    payments: CashMovement[];
  } | null {
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === supplierId);
    if (!supp) return null;

    const purchases = this.getPurchases().filter(p => p.supplierId === supplierId);
    const payments = this.getSupplierPayments(supplierId);

    return { supplier: supp, purchases, payments };
  }

  // --- PURCHASING (RECEIVING STOCK & INVOICE MANAGEMENT) ---
  public getPurchases(): PurchaseInvoice[] {
    return this.getItem<PurchaseInvoice[]>(STORAGE_KEYS.PURCHASES, []);
  }

  public postPurchaseInvoice(
    purchase: PurchaseInvoice,
    options?: { user?: User | null; allowNegativeCash?: boolean; fundingDetails?: CashMovementFunding }
  ): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('PURCHASES', `تسجيل فاتورة شراء ${purchase.invoiceNumber}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const products = this.getProducts();
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === purchase.supplierId);
    if (!supp) return { success: false, error: 'المورد غير محدد' };

    // Validate the complete purchase before touching cash, supplier balances or stock.
    if (!Array.isArray(purchase.items) || purchase.items.length === 0) {
      return { success: false, error: 'فاتورة الشراء يجب أن تحتوي على صنف واحد على الأقل.' };
    }
    for (const item of purchase.items) {
      const prod = products.find(p => p.id === item.productId);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unitCost);
      if (!prod) return { success: false, error: `الصنف غير موجود في المخزون: ${item.productName || item.productId}.` };
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `كمية الشراء غير صالحة للصنف "${prod.name}".` };
      }
      if (!['CARTON', 'PIECE', 'PALLET'].includes(item.unit)) {
        return { success: false, error: `وحدة الشراء غير صالحة للصنف "${prod.name}".` };
      }
      if (!Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(Number(item.totalCost)) || Number(item.totalCost) < 0) {
        return { success: false, error: `تكلفة الشراء غير صالحة للصنف "${prod.name}".` };
      }
    }
    if (purchase.bonusType === 'GOODS' &&
        (!Number.isFinite(Number(purchase.bonusGoodsQuantity)) || Number(purchase.bonusGoodsQuantity) < 0)) {
      return { success: false, error: 'كمية بونص البضاعة غير صالحة.' };
    }

    // Service-layer cash-out coverage check BEFORE modifying stock or balances
    let affectsDrawer = true;
    let resolvedFunding: CashMovementFunding | undefined;

    if (purchase.paidAmount > 0) {
      const evalRes = this.evaluateCashOut(purchase.paidAmount, {
        user: options?.user,
        operation: 'PURCHASE_CASH',
        allowNegativeCash: options?.allowNegativeCash,
        fundingDetails: options?.fundingDetails || purchase.fundingDetails,
      });

      if (!evalRes.allowed) {
        return { success: false, error: evalRes.reason };
      }

      affectsDrawer = evalRes.mode !== 'CAPITAL';
      const rawFunding = options?.fundingDetails || purchase.fundingDetails;
      resolvedFunding = rawFunding
        ? this.validateFundingDetails(rawFunding).normalized!
        : evalRes.mode === 'CAPITAL'
        ? { type: 'EXTERNAL_FUNDING', label: 'رأس مال المحل (لا يؤثر على الدرج)' }
        : { type: 'DRAWER', label: 'نقدية الدرج المباشرة' };

      purchase.affectsDrawer = affectsDrawer;
      purchase.fundingDetails = resolvedFunding;
    }

    // حساب المديونيات
    purchase.previousSupplierBalance = supp.currentBalance;

    // إذا كانت البضاعة مدرجة في المخزن
    if (purchase.isStockInserted) {
      for (const item of purchase.items) {
        const prod = products.find(p => p.id === item.productId);
        if (prod) {
          const piecesPerUnit = item.unit === 'CARTON' 
            ? prod.piecesPerWholesaleUnit 
            : item.unit === 'PALLET' 
            ? (prod.piecesPerWholesaleUnit * 20) 
            : 1;

          const addedPieces = item.quantity * piecesPerUnit;
          const totalPiecesBefore = prod.stockPieces;
          
          prod.stockPieces += addedPieces;

          // Moving Weighted Average Cost update
          const totalOldValue = Math.max(0, totalPiecesBefore) * prod.costPricePerBase;
          const unitPieceCostReceived = item.unitCost / piecesPerUnit;
          const totalNewAddedValue = addedPieces * unitPieceCostReceived;
          
          const newTotalPieces = Math.max(0, totalPiecesBefore) + addedPieces;
          if (newTotalPieces > 0) {
            const newAvgBaseCost = (totalOldValue + totalNewAddedValue) / newTotalPieces;
            prod.costPricePerBase = Math.round(newAvgBaseCost * 100) / 100;
            prod.costPricePerCarton = Math.round(prod.costPricePerBase * prod.piecesPerWholesaleUnit * 100) / 100;
          }
          if (item.batchNumber) prod.batchNumber = item.batchNumber;
          if (item.expiryDate) prod.expiryDate = item.expiryDate;
        }
      }

      // إذا كان هناك بونص بضاعة مجانية: يتم إضافتها للمخزن بتكلفة صفر
      if (purchase.bonusType === 'GOODS' && purchase.bonusGoodsQuantity && purchase.items.length > 0) {
        const firstProd = products.find(p => p.id === purchase.items[0].productId);
        if (firstProd) {
          firstProd.stockPieces += (purchase.bonusGoodsQuantity * firstProd.piecesPerWholesaleUnit);
        }
      }

      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }

    // تحديث رصيد المورد
    if (purchase.remainingAmount > 0) {
      supp.currentBalance += purchase.remainingAmount;
    }
    purchase.newSupplierBalance = supp.currentBalance;
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);

    // سداد نقدي من الدرج أو رأس المال إن وجد
    if (purchase.paidAmount > 0 && resolvedFunding) {
      const fundingLabel = resolvedFunding.note
        ? `${resolvedFunding.label} — ${resolvedFunding.note}`
        : resolvedFunding.label;

      this.addCashMovement(
        {
          id: `cm-${Date.now()}`,
          date: purchase.date,
          time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
          type: 'OUT',
          category: 'SUPPLIER_PAYMENT',
          categoryLabelArabic: 'دفعة مشتريات نقدية',
          amount: purchase.paidAmount,
          referenceId: purchase.invoiceNumber,
          supplierId: supp.id,
          supplierName: supp.name,
          fundingSource: resolvedFunding.type,
          fundingDetails: resolvedFunding,
          affectsDrawer,
          description: `سداد نقدي لفاتورة شراء ${purchase.invoiceNumber} من ${supp.name} (${fundingLabel})`,
          performedBy: options?.user?.fullName || this.getActiveUser()?.fullName || 'النظام',
        },
        { skipCashOutCheck: true, bypassLicenseCheck: true }
      );
    }

    const purchases = this.getPurchases();
    purchases.unshift(purchase);
    this.setItem(STORAGE_KEYS.PURCHASES, purchases);

    this.addAuditLog(
      'PURCHASE',
      'تسجيل فاتورة شراء',
      'فواتير الشراء',
      purchase.invoiceNumber,
      `فاتورة شراء رقم ${purchase.invoiceNumber} بقيمة إجمالية ${purchase.totalCost} ج.م من ${supp.name} ${purchase.isStockInserted ? '(أُدرجت بالمخزن)' : '(مسودة غير مدرجة بالمخزن)'}`
    );

    return { success: true };
  }

  // حذف فاتورة مشتريات وإلغاء إدراجها من المخزن إن تم إدراجها
  public deletePurchaseInvoice(invoiceId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('PURCHASES', `حذف فاتورة شراء ${invoiceId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const purchases = this.getPurchases();
    const purchase = purchases.find(p => p.id === invoiceId || p.invoiceNumber === invoiceId);
    if (!purchase) return { success: false, error: 'فاتورة الشراء غير موجودة' };

    const products = this.getProducts();
    const suppliers = this.getSuppliers();
    const paidAmount = Number(purchase.paidAmount ?? 0);
    const remainingAmount = Number(purchase.remainingAmount ?? 0);
    if (!Number.isFinite(paidAmount) || paidAmount < 0 ||
        !Number.isFinite(remainingAmount) || remainingAmount < 0) {
      return { success: false, error: 'لا يمكن حذف فاتورة الشراء: بيانات المبالغ غير صالحة.' };
    }
    if (!Array.isArray(purchase.items) || purchase.items.length === 0) {
      return { success: false, error: 'لا يمكن حذف فاتورة الشراء: تفاصيل الأصناف غير موجودة.' };
    }

    const nextProducts = products.map(product => ({ ...product }));
    const removalByProduct = new Map<string, number>();
    if (purchase.isStockInserted) {
      for (const item of purchase.items) {
        const product = products.find(p => p.id === item.productId);
        if (!product) {
          return { success: false, error: `لا يمكن حذف فاتورة الشراء: الصنف المرتبط بها غير موجود (معرّف: ${item.productId}).` };
        }
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 ||
            !['CARTON', 'PIECE', 'PALLET'].includes(item.unit)) {
          return { success: false, error: `بيانات كمية أو وحدة غير صالحة للصنف "${product.name}".` };
        }
        const piecesPerUnit = item.unit === 'CARTON' ? Number(product.piecesPerWholesaleUnit)
          : item.unit === 'PALLET' ? Number(product.piecesPerWholesaleUnit) * 20 : 1;
        if (!Number.isFinite(piecesPerUnit) || piecesPerUnit <= 0) {
          return { success: false, error: `معامل تحويل الوحدة غير صالح للصنف "${product.name}".` };
        }
        const pieces = quantity * piecesPerUnit;
        removalByProduct.set(item.productId, (removalByProduct.get(item.productId) || 0) + pieces);
      }
      if (purchase.bonusType === 'GOODS') {
        const bonusQuantity = Number(purchase.bonusGoodsQuantity);
        if (!Number.isFinite(bonusQuantity) || bonusQuantity < 0) {
          return { success: false, error: 'كمية بونص البضاعة غير صالحة.' };
        }
        if (bonusQuantity > 0) {
          const firstItem = purchase.items[0];
          const firstProduct = products.find(p => p.id === firstItem.productId);
          if (!firstProduct) return { success: false, error: 'صنف بونص البضاعة غير موجود.' };
          // Match postPurchaseInvoice: bonusGoodsQuantity is stored in wholesale units
          // and is always converted using the product's piecesPerWholesaleUnit.
          const factor = Number(firstProduct.piecesPerWholesaleUnit);
          if (!Number.isFinite(factor) || factor <= 0) {
            return { success: false, error: 'معامل تحويل بونص البضاعة غير صالح.' };
          }
          removalByProduct.set(firstProduct.id, (removalByProduct.get(firstProduct.id) || 0) + bonusQuantity * factor);
        }
      }
      for (const [productId, requested] of removalByProduct) {
        const product = nextProducts.find(p => p.id === productId)!;
        const available = Number(product.stockPieces);
        if (!Number.isFinite(available) || available < requested) {
          return { success: false, error: `لا يمكن حذف فاتورة الشراء: رصيد الصنف "${product.name}" غير كافٍ أو غير صالح. المطلوب خصمه ${requested} قطعة.` };
        }
        product.stockPieces = available - requested;
      }
    }

    const nextSuppliers = suppliers.map(supplier => ({ ...supplier }));
    if (remainingAmount > 0) {
      const supplier = nextSuppliers.find(s => s.id === purchase.supplierId);
      if (!supplier) {
        return { success: false, error: 'لا يمكن حذف فاتورة الشراء: المورد المرتبط بها غير موجود، ولا يمكن تسوية مديونيته بأمان.' };
      }
      const balance = Number(supplier.currentBalance);
      if (!Number.isFinite(balance) || balance < 0) {
        return { success: false, error: 'رصيد المورد غير صالح؛ تم إيقاف الحذف لحماية الحسابات.' };
      }
      supplier.currentBalance = Math.max(0, Math.round((balance - remainingAmount) * 100) / 100);
    }

    // All linked records are validated before the first persistent mutation.
    if (purchase.isStockInserted) this.setItem(STORAGE_KEYS.PRODUCTS, nextProducts);
    if (remainingAmount > 0) this.setItem(STORAGE_KEYS.SUPPLIERS, nextSuppliers);

    if (paidAmount > 0) {
      this.addCashMovement(
        {
          id: `cm-${Date.now()}`,
          date: getCairoDateString(),
          time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
          type: 'IN',
          category: 'DRAWER_ADJUSTMENT',
          categoryLabelArabic: 'إلغاء فاتورة شراء',
          amount: paidAmount,
          referenceId: purchase.invoiceNumber,
          description: `رد نقدية لحذف فاتورة الشراء رقم ${purchase.invoiceNumber} من ${purchase.supplierName}`,
          performedBy: this.getActiveUser()?.fullName || 'النظام',
          affectsDrawer: purchase.affectsDrawer !== false,
          fundingDetails: purchase.fundingDetails,
        },
        { skipCashOutCheck: true, bypassLicenseCheck: true }
      );
    }

    this.setItem(STORAGE_KEYS.PURCHASES, purchases.filter(p => p.id !== purchase.id));
    this.addAuditLog(
      'PURCHASE_DELETE',
      'حذف فاتورة شراء',
      'فواتير الشراء',
      purchase.invoiceNumber,
      `تم حذف فاتورة الشراء ${purchase.invoiceNumber} بعد التحقق من المخزون وحساب المورد`
    );
    return { success: true };
  }

  // إدراج فاتورة شراء في المخزن إذا لم تكن مدرجة
  public insertPurchaseIntoStock(invoiceId: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('PURCHASES', `إدراج فاتورة شراء بالمخزن ${invoiceId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const purchases = this.getPurchases();
    const purchase = purchases.find(p => p.id === invoiceId);
    if (!purchase) return { success: false, error: 'فاتورة الشراء غير موجودة' };
    if (purchase.isStockInserted) return { success: false, error: 'الفاتورة مدرجة بالمخزن بالفعل' };

    const products = this.getProducts();
    // Validate every line and the bonus before applying any stock increase.
    for (const item of purchase.items || []) {
      const prod = products.find(p => p.id === item.productId);
      const quantity = Number(item.quantity);
      if (!prod) return { success: false, error: `الصنف غير موجود في المخزون: ${item.productName || item.productId}.` };
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `كمية الإدراج غير صالحة للصنف "${prod.name}".` };
      }
      if (!['CARTON', 'PIECE', 'PALLET'].includes(item.unit)) {
        return { success: false, error: `وحدة الإدراج غير صالحة للصنف "${prod.name}".` };
      }
    }
    if (!purchase.items || purchase.items.length === 0) {
      return { success: false, error: 'لا توجد أصناف لإدراجها بالمخزن.' };
    }
    if (purchase.bonusType === 'GOODS' &&
        (!Number.isFinite(Number(purchase.bonusGoodsQuantity)) || Number(purchase.bonusGoodsQuantity) < 0)) {
      return { success: false, error: 'كمية بونص البضاعة غير صالحة.' };
    }
    for (const item of purchase.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        const piecesPerUnit = item.unit === 'CARTON' 
          ? prod.piecesPerWholesaleUnit 
          : item.unit === 'PALLET' 
          ? (prod.piecesPerWholesaleUnit * 20) 
          : 1;

        prod.stockPieces += (item.quantity * piecesPerUnit);
      }
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    purchase.isStockInserted = true;
    this.setItem(STORAGE_KEYS.PURCHASES, purchases);

    this.addAuditLog(
      'PURCHASE_STOCK',
      'إدراج بضاعة شراء بالمخزن',
      'المخزن',
      purchase.invoiceNumber,
      `تم إدراج بضاعة فاتورة الشراء ${purchase.invoiceNumber} في المخزن الموحد بنجاح`
    );

    return { success: true };
  }

  // --- STOCK ADJUSTMENTS (نظام تسوية المخزون: جرد / عجز / زيادة / تلف) ---
  public getStockAdjustments(): StockAdjustment[] {
    return this.getItem<StockAdjustment[]>(STORAGE_KEYS.STOCK_ADJUSTMENTS, []);
  }

  public recordStockAdjustment(params: {
    productId: string;
    differencePieces: number; // + or -
    reason: 'AUDIT' | 'DAMAGE' | 'EXPIRY' | 'BONUS' | 'CORRECTION' | 'OTHER';
    reasonArabic: string;
    notes?: string;
    performedBy: string;
  }): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', `تسوية مخزون الصنف ${params.productId}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const products = this.getProducts();
    const prod = products.find(p => p.id === params.productId);
    if (!prod) return { success: false, error: 'الصنف غير موجود' };

    const prevPieces = Number(prod.stockPieces) || 0;
    const differencePieces = Number(params.differencePieces);
    if (!Number.isFinite(differencePieces)) {
      return { success: false, error: 'كمية التسوية غير صالحة.' };
    }
    const newPieces = prevPieces + differencePieces;
    if (newPieces < 0) {
      return {
        success: false,
        error: `لا يمكن تنفيذ التسوية؛ رصيد الصنف "${prod.name}" هو ${prevPieces} قطعة، والتسوية ستجعله بالسالب.`,
      };
    }
    prod.stockPieces = newPieces;
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    const now = new Date();
    const dateStr = getCairoDateString(now);
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    const adjustment: StockAdjustment = {
      id: `adj-${Date.now()}`,
      date: dateStr,
      time: timeStr,
      productId: prod.id,
      productName: prod.name,
      productCode: prod.code,
      previousPieces: prevPieces,
      differencePieces: params.differencePieces,
      newPieces: newPieces,
      reason: params.reason,
      reasonArabic: params.reasonArabic,
      notes: params.notes,
      performedBy: params.performedBy,
    };

    const adjustments = this.getStockAdjustments();
    adjustments.unshift(adjustment);
    this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, adjustments);

    const diffType = params.differencePieces >= 0 ? 'زيادة' : 'عجز/خصم';
    this.addAuditLog(
      'STOCK_ADJUST',
      'تسوية مخزون',
      'المخزن الموحد',
      prod.code,
      `تسوية رصيد الصنف (${prod.name}): ${diffType} ${Math.abs(params.differencePieces)} قطعة [السبب: ${params.reasonArabic}] • الرصيد السابق: ${prevPieces} ق، الرصيد الجديد: ${newPieces} ق`
    );

    return { success: true };
  }

  // --- AUDIT LOGS ---
  public getAuditLogs(): AuditLog[] {
    return this.getItem<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
  }

  public addAuditLog(entity: string, actionArabic: string, entityArabic: string, entityId: string, details: string): void {
    const activeUser = this.getActiveUser();
    const logs = this.getAuditLogs();
    const newLog: AuditLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      timestamp: new Date().toLocaleString('ar-EG'),
      userId: activeUser ? activeUser.id : 'unauthenticated',
      username: activeUser ? activeUser.fullName : 'غير مسجّل (النظام)',
      action: entity,
      actionArabic,
      entity: entityArabic,
      entityId,
      details,
    };
    logs.unshift(newLog);
    if (logs.length > 500) logs.pop();
    this.setItem(STORAGE_KEYS.AUDIT_LOGS, logs);
  }

  // --- PARKED CARTS (تعليق الفواتير للكاشير) ---
  public getParkedCarts(): ParkedCart[] {
    return this.getItem<ParkedCart[]>(STORAGE_KEYS.PARKED_CARTS, []);
  }

  public saveParkedCart(cart: ParkedCart): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SALES', `تعليق فاتورة: ${cart.customerName}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const carts = this.getParkedCarts();
    carts.unshift(cart);
    this.setItem(STORAGE_KEYS.PARKED_CARTS, carts);
    this.addAuditLog('SALES', 'تعليق فاتورة', 'نقطة البيع', cart.id, `تم تعليق فاتورة باسم: ${cart.customerName} (${cart.items.length} أصناف)`);
    return { success: true };
  }

  public removeParkedCart(id: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('SALES', `حذف فاتورة معلقة ${id}`);
    if (!gate.allowed) return { success: false, error: gate.error };

    const carts = this.getParkedCarts();
    const filtered = carts.filter(c => c.id !== id);
    this.setItem(STORAGE_KEYS.PARKED_CARTS, filtered);
    return { success: true };
  }

  // --- BACKUP & RESTORE ---
  public exportFullBackupJson(): string {
    const backupData = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      app: 'WholesaleFoodSystem_Egypt',
      data: {
        products: this.getProducts(),
        customers: this.getCustomers(),
        suppliers: this.getSuppliers(),
        invoices: this.getSalesInvoices(),
        purchases: this.getPurchases(),
        cashMovements: this.getCashMovements(),
        expenses: this.getExpenses(),
        auditLogs: this.getAuditLogs(),
        stockAdjustments: this.getStockAdjustments(),
        currentShift: this.getCurrentShift(),
        users: this.getUsers(),
        storeProfile: this.getStoreProfile(),
        accountingMode: this.getAccountingMode(),
        monthlyPoolIncludesCapitalInjection: this.getMonthlyPoolIncludesCapitalInjection(),
        fundingSources: this.getFundingSources(),
        salesReturns: this.getSalesReturns(),
      }
    };
    return JSON.stringify(backupData, null, 2);
  }

  public restoreBackupJson(jsonString: string): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'استعادة نسخة احتياطية من ملف');
    if (!gate.allowed) return { success: false, error: gate.error };

    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed.data || !parsed.data.products || !parsed.data.customers) {
        return { success: false, error: 'الملف غير صالح أو لا يحتوي على بنية البيانات المطلوبة' };
      }

      this.setItem(STORAGE_KEYS.PRODUCTS, parsed.data.products);
      this.setItem(STORAGE_KEYS.CUSTOMERS, parsed.data.customers);
      this.setItem(STORAGE_KEYS.SUPPLIERS, parsed.data.suppliers || []);
      this.setItem(STORAGE_KEYS.INVOICES, parsed.data.invoices || []);
      this.setItem(STORAGE_KEYS.PURCHASES, parsed.data.purchases || []);
      this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, parsed.data.cashMovements || []);
      this.setItem(STORAGE_KEYS.EXPENSES, parsed.data.expenses || []);
      this.setItem(STORAGE_KEYS.AUDIT_LOGS, parsed.data.auditLogs || []);
      this.setItem(STORAGE_KEYS.SALES_RETURNS, Array.isArray(parsed.data.salesReturns) ? parsed.data.salesReturns : []);
      if (parsed.data.stockAdjustments) this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, parsed.data.stockAdjustments);
      if (parsed.data.users) this.setItem(STORAGE_KEYS.USERS, parsed.data.users);

      const mode = parsed.data.accountingMode;
      this.setItem(
        STORAGE_KEYS.ACCOUNTING_MODE,
        mode === 'DAILY_DRAWER' || mode === 'MONTHLY_POOL' || mode === 'CAPITAL' ? mode : 'DAILY_DRAWER'
      );
      this.setItem(
        STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ,
        Boolean(parsed.data.monthlyPoolIncludesCapitalInjection)
      );
      this.setItem(
        STORAGE_KEYS.FUNDING_SOURCES,
        Array.isArray(parsed.data.fundingSources) && parsed.data.fundingSources.length > 0
          ? parsed.data.fundingSources
          : JSON.parse(JSON.stringify(DEFAULT_FUNDING_SOURCES))
      );

      this.addAuditLog('RESTORE', 'استعادة نسخة احتياطية', 'النظام', 'restore', 'تمت استعادة قاعدة البيانات بنجاح من ملف خارجي');

      // Asynchronously flush writes to IndexedDB
      this.flush().catch(err => {
        console.error('Error flushing restored backup to IDB:', err);
      });

      this.migrationRecoveryRequired = false;
      this.isReady = true;

      return { success: true };
    } catch {
      return { success: false, error: 'فشل في قراءة ملف النسخة الاحتياطية' };
    }
  }

  /**
   * Updates memory cache with transactional restored payload without re-queueing IDB writes
   */
  public applyRestoredMemoryPayload(rawInput: Record<string, any>): void {
    const data = (rawInput && typeof rawInput === 'object' && rawInput.data && typeof rawInput.data === 'object' && !Array.isArray(rawInput.data))
      ? rawInput.data
      : rawInput;
    if (data.products !== undefined) this.cache.set(STORAGE_KEYS.PRODUCTS, data.products);
    if (data.customers !== undefined) this.cache.set(STORAGE_KEYS.CUSTOMERS, data.customers);
    if (data.suppliers !== undefined) this.cache.set(STORAGE_KEYS.SUPPLIERS, data.suppliers);
    if (data.invoices !== undefined) this.cache.set(STORAGE_KEYS.INVOICES, data.invoices);
    if (data.purchases !== undefined) this.cache.set(STORAGE_KEYS.PURCHASES, data.purchases);
    if (data.cashMovements !== undefined) this.cache.set(STORAGE_KEYS.CASH_MOVEMENTS, data.cashMovements);
    if (data.expenses !== undefined) this.cache.set(STORAGE_KEYS.EXPENSES, data.expenses);
    if (data.auditLogs !== undefined) this.cache.set(STORAGE_KEYS.AUDIT_LOGS, data.auditLogs);
    if (data.stockAdjustments !== undefined) this.cache.set(STORAGE_KEYS.STOCK_ADJUSTMENTS, data.stockAdjustments);
    if (data.users !== undefined) this.cache.set(STORAGE_KEYS.USERS, data.users);
    if (data.currentShift !== undefined) this.cache.set(STORAGE_KEYS.SHIFT, data.currentShift);
    if (data.parkedCarts !== undefined) this.cache.set(STORAGE_KEYS.PARKED_CARTS, data.parkedCarts);
    this.cache.set(STORAGE_KEYS.SALES_RETURNS, Array.isArray(data.salesReturns) ? data.salesReturns : []);

    if (data.storeProfile !== undefined) {
      this.cache.set(STORAGE_KEYS.STORE_PROFILE, data.storeProfile);
      this.cache.set(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
    } else {
      // Legacy backup without StoreProfile: determine appropriate profile
      const hasProducts = Array.isArray(data.products) && data.products.length > 0;
      const fallbackProfile = hasProducts ? JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE)) : JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE));
      this.cache.set(STORAGE_KEYS.STORE_PROFILE, fallbackProfile);
      this.cache.set(STORAGE_KEYS.STORE_PROFILE_REVIEWED, false);
    }

    // Optional AccountingMode & FundingSources (legacy backups without them receive safe defaults)
    const restoredMode = data.accountingMode;
    this.cache.set(
      STORAGE_KEYS.ACCOUNTING_MODE,
      restoredMode === 'DAILY_DRAWER' || restoredMode === 'MONTHLY_POOL' || restoredMode === 'CAPITAL'
        ? restoredMode
        : 'DAILY_DRAWER'
    );
    this.cache.set(
      STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ,
      Boolean(data.monthlyPoolIncludesCapitalInjection)
    );
    this.cache.set(
      STORAGE_KEYS.FUNDING_SOURCES,
      Array.isArray(data.fundingSources) && data.fundingSources.length > 0
        ? data.fundingSources
        : JSON.parse(JSON.stringify(DEFAULT_FUNDING_SOURCES))
    );

    this.pendingWrites.clear();
    this.migrationRecoveryRequired = false;
    this.isReady = true;
  }

  public resetToFactoryDefault(): { success: boolean; error?: string } {
    const gate = this.assertWriteAllowed('ADMIN_DATA', 'إعادة ضبط المصنع');
    if (!gate.allowed) return { success: false, error: gate.error };

    this.cache.clear();
    this.pendingWrites.clear();
    this.initPromise = null;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    idb.kv.clear().catch(e => console.error('Failed to clear IDB:', e));
    if (typeof localStorage !== 'undefined') {
      for (const k of BUSINESS_KEYS) {
        try { localStorage.removeItem(k); } catch {}
      }
      try { localStorage.removeItem('idb_migrated_at'); } catch {}
    }
    this.initDatabase();
    this.flush().catch(err => console.error('Error flushing default seeds to IDB:', err));
    return { success: true };
  }
}

export const storage = new StorageService();

// Requirement 3: Automatically flush pending writes on visibilitychange (hidden) and pagehide
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      storage.flush().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    storage.flush().catch(() => {});
  });
}
