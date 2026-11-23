import { idb, SnapshotRecord, SnapshotMetadata, SnapshotStatus, KVRecord } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { validateFifoLedger, validateFifoAllocations } from './inventoryFifoService';
import { DEFAULT_STORE_PROFILE, LEGACY_STORE_PROFILE, DEFAULT_FUNDING_SOURCES } from '../types';

export const CURRENT_SCHEMA_VERSION = 2;
export const APP_VERSION = '1.0.0';

export const REQUIRED_COLLECTIONS: { key: string; label: string; isArray: boolean }[] = [
  { key: 'products', label: 'المنتجات', isArray: true },
  { key: 'customers', label: 'العملاء', isArray: true },
  { key: 'suppliers', label: 'الموردين', isArray: true },
  { key: 'invoices', label: 'الفواتير', isArray: true },
  { key: 'purchases', label: 'المشتريات', isArray: true },
  { key: 'cashMovements', label: 'حركات الخزينة', isArray: true },
  { key: 'expenses', label: 'المصروفات', isArray: true },
  { key: 'auditLogs', label: 'سجل العمليات', isArray: true },
  { key: 'stockAdjustments', label: 'تسويات المخزون', isArray: true },
  { key: 'users', label: 'المستخدمين', isArray: true },
  { key: 'parkedCarts', label: 'السلات المعلقة', isArray: true },
  { key: 'currentShift', label: 'الوردية الحالية', isArray: false },
];

export interface ExportBackupPackage {
  schemaVersion: number;
  appVersion: string;
  timestamp: string;
  recordCounts: {
    products: number;
    invoices: number;
    customers: number;
    suppliers: number;
    purchases: number;
    cashMovements: number;
    expenses: number;
    auditLogs: number;
    stockAdjustments: number;
    users: number;
    parkedCarts: number;
    [key: string]: number;
  };
  checksum: string;
  data: Record<string, any>;
}

export interface BackupPreview {
  timestamp: string;
  dateFormatted: string;
  schemaVersion: number;
  appVersion?: string;
  hasChecksum: boolean;
  checksumStatus?: 'verified' | 'legacy-verified' | 'transport-verified' | 'mismatch' | 'missing';
  isLegacy: boolean;
  warning?: string;
  counts: {
    products: number;
    invoices: number;
    customers: number;
    suppliers: number;
    purchases: number;
    cashMovements: number;
    expenses: number;
    auditLogs: number;
    stockAdjustments: number;
    users: number;
    parkedCarts: number;
  };
}

export interface SnapshotPreconditionResult {
  allowed: boolean;
  reason?: 'empty_data' | 'suspicious_drop';
  dropPercentage?: number;
  droppedField?: string;
  message?: string;
}

/**
 * Deterministic JSON serialization for checksums.
 * Mirrors JSON.stringify semantics: omit undefined/function/symbol object values,
 * serialize those values as null inside arrays, and normalize non-finite numbers to null.
 * Object keys are sorted so the result is stable across platforms.
 */
export function canonicalStringify(value: any): string {
  const ancestors = new Set<object>();

  const normalize = (input: any, inArray = false): any => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'undefined' || typeof input === 'function' || typeof input === 'symbol') {
      return inArray ? null : undefined;
    }
    if (typeof input === 'bigint') {
      throw new TypeError('BigInt cannot be serialized to JSON');
    }

    let current = input;
    if (current && typeof current.toJSON === 'function') {
      current = current.toJSON();
      if (current === null || typeof current !== 'object') return normalize(current, inArray);
    }

    if (ancestors.has(current)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map(item => normalize(item, true));
      }
      const result: Record<string, any> = {};
      for (const key of Object.keys(current).sort()) {
        const normalized = normalize(current[key], false);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  };

  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) {
    throw new TypeError('Backup data cannot be serialized to JSON');
  }
  return serialized;
}

/** Computes a real SHA-256 digest. Never substitutes a non-cryptographic hash. */
export async function computeDataChecksum(data: any): Promise<string> {
  const canonical = canonicalStringify(data);
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
    throw new Error('SHA-256 غير متاح في بيئة التشغيل؛ لم يتم إنشاء بصمة بديلة غير آمنة.');
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Previous releases hashed a non-JSON canonical representation where undefined
 * object properties became the literal text "undefined". Keep this verifier
 * only to read existing trusted backups/snapshots; all new exports use the
 * JSON-compatible canonical representation above.
 */
function legacyCanonicalStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(legacyCanonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + legacyCanonicalStringify(value[key])).join(',') + '}';
}

async function matchesLegacyDataChecksum(data: any, expected: string): Promise<boolean> {
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') return false;
  const legacy = legacyCanonicalStringify(data);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy));
  const actual = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return actual === expected;
}

class SnapshotService {
  private isProcessingSnapshot: boolean = false;
  private dropAlert: string | null = null;
  private quotaWarning: string | null = null;
  private dropAlertListeners: ((alert: string | null) => void)[] = [];
  private testEstimateOverride: { usage?: number; quota?: number } | null = null;

  public getDropAlert(): string | null {
    return this.dropAlert;
  }

  public clearDropAlert(): void {
    this.dropAlert = null;
    this.notifyDropAlertListeners();
  }

  public setDropAlert(alert: string | null): void {
    this.dropAlert = alert;
    this.notifyDropAlertListeners();
  }

  public onDropAlertChange(cb: (alert: string | null) => void): () => void {
    this.dropAlertListeners.push(cb);
    return () => {
      this.dropAlertListeners = this.dropAlertListeners.filter(l => l !== cb);
    };
  }

  private notifyDropAlertListeners(): void {
    this.dropAlertListeners.forEach(cb => {
      try { cb(this.dropAlert); } catch {}
    });
  }

  public getQuotaWarning(): string | null {
    return this.quotaWarning;
  }

  public setQuotaEstimateForTesting(estimate: { usage?: number; quota?: number } | null): void {
    this.testEstimateOverride = estimate;
  }

  /**
   * Pulls current business data from storage cache
   */
  public getCurrentBusinessData(): Record<string, any> {
    return {
      products: storage.getProducts(),
      customers: storage.getCustomers(),
      suppliers: storage.getSuppliers(),
      invoices: storage.getSalesInvoices(),
      purchases: storage.getPurchases(),
      cashMovements: storage.getCashMovements(),
      expenses: storage.getExpenses(),
      auditLogs: storage.getAuditLogs(),
      stockAdjustments: storage.getStockAdjustments(),
      currentShift: storage.getCurrentShift(),
      users: storage.getUsers(),
      parkedCarts: storage.getParkedCarts(),
      storeProfile: storage.getStoreProfile(),
      accountingMode: storage.getAccountingMode(),
      monthlyPoolIncludesCapitalInjection: storage.getMonthlyPoolIncludesCapitalInjection(),
      fundingSources: storage.getFundingSources(),
      salesReturns: storage.getSalesReturns(),
      inventoryLots: storage.getInventoryLots(),
      fifoAllocations: storage.getFifoAllocations(),
      fifoInitialized: storage.isFifoInitialized(),
    };
  }

  /**
   * Precondition checks (Requirement 1):
   * 1. Data not empty
   * 2. No >30% drop in products, invoices, or customers compared to the last healthy snapshot
   */
  public async checkSnapshotPreconditions(data: Record<string, any>): Promise<SnapshotPreconditionResult> {
    const productsCount = data.products?.length || 0;
    const invoicesCount = data.invoices?.length || 0;
    const customersCount = data.customers?.length || 0;

    // Condition 1: Data is completely empty
    if (productsCount === 0 && invoicesCount === 0 && customersCount === 0) {
      return {
        allowed: false,
        reason: 'empty_data',
        message: 'بيانات العمل فارغة، تم إيقاف إنشاء اللقطة التلقائية لحماية سجل النسخ الاحتياطية.',
      };
    }

    if (typeof indexedDB === 'undefined') return { allowed: true };

    try {
      const all = await this.getAllSnapshots();
      // Find the newest healthy snapshot (strictly excluding pre_restore and pre_import)
      const lastHealthy = all.find(
        s => s.status === 'healthy' && s.type !== 'pre_restore' && s.type !== 'pre_import'
      );

      if (lastHealthy && lastHealthy.metadata?.recordCounts) {
        const oldProd = lastHealthy.metadata.recordCounts.products || 0;
        const oldInv = lastHealthy.metadata.recordCounts.invoices || 0;
        const oldCust = lastHealthy.metadata.recordCounts.customers || 0;

        const checkFieldDrop = (oldVal: number, newVal: number, fieldName: string) => {
          if (oldVal > 0 && newVal < oldVal) {
            const drop = (oldVal - newVal) / oldVal;
            if (drop > 0.30) {
              return { dropped: true, pct: Math.round(drop * 100), fieldName };
            }
          }
          return { dropped: false, pct: 0, fieldName: '' };
        };

        const prodDrop = checkFieldDrop(oldProd, productsCount, 'المنتجات');
        const invDrop = checkFieldDrop(oldInv, invoicesCount, 'الفواتير');
        const custDrop = checkFieldDrop(oldCust, customersCount, 'العملاء');

        const activeDrop = [prodDrop, invDrop, custDrop].find(d => d.dropped);
        if (activeDrop) {
          return {
            allowed: false,
            reason: 'suspicious_drop',
            dropPercentage: activeDrop.pct,
            droppedField: activeDrop.fieldName,
            message: 'الأعداد انخفضت مقارنة بآخر لقطة، لم تُنشأ لقطة جديدة',
          };
        }
      }
    } catch (err) {
      console.warn('Error reading snapshots for drop check:', err);
    }

    return { allowed: true };
  }

  /**
   * Storage Quota Check (Requirement 3):
   * Inspects navigator.storage.estimate(). If total snapshots size or quota usage
   * exceeds 40% of available quota, reduces retention to 3 snapshots and sets quota warning.
   */
  public async evaluateStorageQuota(): Promise<{ isOverLimit: boolean; targetKeepCount: number; warning?: string }> {
    let quota = 0;
    let usage = 0;

    if (this.testEstimateOverride) {
      quota = this.testEstimateOverride.quota || 0;
      usage = this.testEstimateOverride.usage || 0;
    } else if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        quota = est.quota || 0;
        usage = est.usage || 0;
      } catch {
        // ignore
      }
    }

    let totalSnapshotsBytes = 0;
    try {
      const all = await this.getAllSnapshots();
      totalSnapshotsBytes = all.reduce((sum, s) => sum + (s.metadata?.approxSizeBytes || 0), 0);
    } catch {}

    if (quota > 0 && (totalSnapshotsBytes > 0.40 * quota || usage > 0.40 * quota)) {
      this.quotaWarning = 'تحذير مساحة التخزين: استهلاك اللقطات تجاوز 40% من الحصة المتاحة للمتصفح. تم تقليص السجل للاحتفاظ بـ 3 لقطات فقط لحماية النظام.';
      return { isOverLimit: true, targetKeepCount: 3, warning: this.quotaWarning };
    }

    this.quotaWarning = null;
    return { isOverLimit: false, targetKeepCount: 7 };
  }

  /**
   * Checks if daily snapshot for today already exists; if not, creates one in background.
   */
  public async checkAndCreateDailySnapshot(): Promise<SnapshotRecord | null> {
    if (!storage.isStorageReady()) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const dailyId = `snapshot_daily_${todayStr}`;

    try {
      if (typeof indexedDB === 'undefined') return null;
      const existing = await idb.snapshots.get(dailyId);
      if (existing) {
        return existing;
      }
      return await this.createSnapshot('daily', dailyId, todayStr);
    } catch (err) {
      console.warn('Failed to check or create daily snapshot:', err);
      return null;
    }
  }

  /**
   * Creates an internal snapshot:
   * - Enforces precondition checks for automatic types (daily / shift_close) unless forced
   * - Sets status: 'healthy' or 'suspicious'
   * - Prunes old snapshots while NEVER deleting the last 2 healthy snapshots (Requirement 2)
   * - Trims to 3 if storage quota exceeds 40% (Requirement 3)
   */
  public async createSnapshot(
    type: 'daily' | 'shift_close' | 'pre_restore' | 'pre_import' | 'manual',
    customId?: string,
    customDateStr?: string,
    options?: { force?: boolean; status?: SnapshotStatus }
  ): Promise<SnapshotRecord | null> {
    if (this.isProcessingSnapshot) return null;
    this.isProcessingSnapshot = true;

    try {
      if (typeof indexedDB === 'undefined') return null;

      const data = this.getCurrentBusinessData();

      // Check preconditions for automatic snapshots
      if (!options?.force && (type === 'daily' || type === 'shift_close')) {
        const precondition = await this.checkSnapshotPreconditions(data);
        if (!precondition.allowed) {
          if (precondition.reason === 'suspicious_drop') {
            this.setDropAlert(precondition.message || 'الأعداد انخفضت مقارنة بآخر لقطة، لم تُنشأ لقطة جديدة');
          }
          return null;
        }
      }

      // If created successfully or forced, clear drop alert
      this.clearDropAlert();

      const timestamp = Date.now();
      const dateStr = customDateStr || new Date(timestamp).toISOString().slice(0, 10);
      const id = customId || `snapshot_${type}_${timestamp}`;

      // Check duplicate for daily
      if (type === 'daily') {
        const existing = await idb.snapshots.get(id);
        if (existing) {
          return existing;
        }
      }

      const checksum = await computeDataChecksum(data);
      const approxSizeBytes = new TextEncoder().encode(JSON.stringify(data)).length;

      // Pre_restore & pre_import snapshots are NEVER healthy and do not enter healthy protection.
      const status: SnapshotStatus =
        type === 'pre_restore' || type === 'pre_import' ? 'suspicious' : (options?.status || 'healthy');

      const metadata: SnapshotMetadata = {
        approxSizeBytes,
        recordCounts: {
          products: data.products?.length || 0,
          invoices: data.invoices?.length || 0,
          customers: data.customers?.length || 0,
          suppliers: data.suppliers?.length || 0,
          purchases: data.purchases?.length || 0,
          cashMovements: data.cashMovements?.length || 0,
          expenses: data.expenses?.length || 0,
          auditLogs: data.auditLogs?.length || 0,
          stockAdjustments: data.stockAdjustments?.length || 0,
          users: data.users?.length || 0,
          parkedCarts: data.parkedCarts?.length || 0,
          salesReturns: data.salesReturns?.length || 0,
          inventoryLots: data.inventoryLots?.length || 0,
          fifoAllocations: data.fifoAllocations?.length || 0,
        },
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        checksum,
      };

      const record: SnapshotRecord = {
        id,
        dateStr,
        type,
        status,
        timestamp,
        data,
        metadata,
      };

      await idb.snapshots.put(record);

      // Quota check & prune
      const quotaEvaluation = await this.evaluateStorageQuota();
      await this.pruneOldSnapshots(quotaEvaluation.targetKeepCount);

      storage.addAuditLog(
        'BACKUP',
        'لقطة نظام داخلية',
        'النسخ الاحتياطي',
        'system',
        `تم إنشاء لقطة بيانات داخلية (${type === 'daily' ? 'يومية' : type === 'shift_close' ? 'إغلاق وردية' : type === 'pre_restore' ? 'قبل الاستعادة' : type === 'pre_import' ? 'قبل استيراد الأصناف' : 'يدوية'}) بحالة [${status === 'healthy' ? 'سليمة' : 'مشبوهة'}] بحجم ${(approxSizeBytes / 1024).toFixed(1)} ك.ب`
      );

      return record;
    } catch (err) {
      console.error('Failed to create snapshot:', err);
      return null;
    } finally {
      this.isProcessingSnapshot = false;
    }
  }

  /**
   * Prune snapshots (Requirement 2 & 3):
   * - pre_restore has its own separate quota: keep newest 3 only (never evicts healthy, never protected as healthy).
   * - standard snapshots keep target count (7 normal, 3 on quota alert).
   * RULE: NEVER delete the newest 2 'healthy' standard snapshots, even if count exceeds the limit.
   */
  public async pruneOldSnapshots(targetKeepCount: number = 7): Promise<number> {
    try {
      if (typeof indexedDB === 'undefined') return 0;
      const all = await idb.snapshots.orderBy('timestamp').toArray();
      let totalDeleted = 0;

      // 1a. Separate independent quota for pre_restore snapshots: keep newest 3 only (Requirement 3)
      const preRestoreSnapshots = all.filter(s => s.type === 'pre_restore');
      if (preRestoreSnapshots.length > 3) {
        const excessCount = preRestoreSnapshots.length - 3;
        const toDeletePreRestore = preRestoreSnapshots
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, excessCount)
          .map(s => s.id);
        if (toDeletePreRestore.length > 0) {
          await idb.snapshots.bulkDelete(toDeletePreRestore);
          totalDeleted += toDeletePreRestore.length;
        }
      }

      // 1b. Separate independent quota for pre_import snapshots: keep newest 3 only
      const preImportSnapshots = all.filter(s => s.type === 'pre_import');
      if (preImportSnapshots.length > 3) {
        const excessCount = preImportSnapshots.length - 3;
        const toDeletePreImport = preImportSnapshots
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, excessCount)
          .map(s => s.id);
        if (toDeletePreImport.length > 0) {
          await idb.snapshots.bulkDelete(toDeletePreImport);
          totalDeleted += toDeletePreImport.length;
        }
      }

      // 2. Standard snapshots (strictly excluding pre_restore & pre_import from the 7 target count)
      const standardSnapshots = all.filter(s => s.type !== 'pre_restore' && s.type !== 'pre_import');
      if (standardSnapshots.length > targetKeepCount) {
        // Identify the 2 newest healthy snapshots to protect (strictly excluding pre_restore & pre_import)
        const healthySnapshots = standardSnapshots
          .filter(s => s.status === 'healthy' && s.type !== 'pre_restore' && s.type !== 'pre_import')
          .sort((a, b) => a.timestamp - b.timestamp);

        const lastTwoHealthy = healthySnapshots.slice(-2);
        const protectedIds = new Set(lastTwoHealthy.map(s => s.id));

        // Candidates to delete: sort from oldest to newest
        const candidates = [...standardSnapshots].sort((a, b) => a.timestamp - b.timestamp);
        const toDeleteStandard: string[] = [];

        let remainingCount = standardSnapshots.length;
        for (const snap of candidates) {
          if (remainingCount <= targetKeepCount) break;
          // NEVER delete protected healthy snapshots
          if (!protectedIds.has(snap.id)) {
            toDeleteStandard.push(snap.id);
            remainingCount--;
          }
        }

        if (toDeleteStandard.length > 0) {
          await idb.snapshots.bulkDelete(toDeleteStandard);
          totalDeleted += toDeleteStandard.length;
        }
      }

      return totalDeleted;
    } catch (err) {
      console.warn('Failed to prune snapshots:', err);
      return 0;
    }
  }

  /**
   * Retrieves all snapshots sorted newest first
   */
  public async getAllSnapshots(): Promise<SnapshotRecord[]> {
    try {
      if (typeof indexedDB === 'undefined') return [];
      return await idb.snapshots.orderBy('timestamp').reverse().toArray();
    } catch (err) {
      console.warn('Failed to fetch snapshots:', err);
      return [];
    }
  }

  /**
   * Delete a snapshot by ID
   */
  public async deleteSnapshot(id: string): Promise<boolean> {
    try {
      if (typeof indexedDB === 'undefined') return false;
      await idb.snapshots.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generates a fully packaged export with metadata and SHA-256 checksum
   */
  public async generateExportPackage(): Promise<ExportBackupPackage> {
    const data = this.getCurrentBusinessData();
    const checksum = await computeDataChecksum(data);

    this.recordManualExport();

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      timestamp: new Date().toISOString(),
      recordCounts: {
        products: data.products?.length || 0,
        invoices: data.invoices?.length || 0,
        customers: data.customers?.length || 0,
        suppliers: data.suppliers?.length || 0,
        purchases: data.purchases?.length || 0,
        cashMovements: data.cashMovements?.length || 0,
        expenses: data.expenses?.length || 0,
        auditLogs: data.auditLogs?.length || 0,
        stockAdjustments: data.stockAdjustments?.length || 0,
        users: data.users?.length || 0,
        parkedCarts: data.parkedCarts?.length || 0,
        salesReturns: data.salesReturns?.length || 0,
        inventoryLots: data.inventoryLots?.length || 0,
        fifoAllocations: data.fifoAllocations?.length || 0,
      },
      checksum,
      data,
    };
  }

  /**
   * Validates a backup file/object (checksum, schema version, 12 collections, record counts) and returns a preview
   */
  public async validateBackup(
    content: string | Record<string, any>,
    options?: {
      allowChecksumMismatchAfterVerifiedTransport?: boolean;
      allowChecksumMismatchAfterExplicitRecovery?: boolean;
    }
  ): Promise<{
    valid: boolean;
    error?: string;
    warning?: string;
    preview?: BackupPreview;
    validatedData?: Record<string, any>;
  }> {
    let parsed: any;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return { valid: false, error: 'الملف غير صالح أو ليس بتنسيق JSON صحيح' };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, error: 'هيكل ملف النسخة الاحتياطية فارغ أو تالف' };
    }

    const data = parsed.data || parsed;
    // Preserve the exact pre-normalization payload for checksum verification of legacy backups.
    const checksumData = JSON.parse(JSON.stringify(data));
    // FIFO collections were introduced after legacy backup schemas; old files remain restorable.
    if (!Array.isArray(data.inventoryLots)) data.inventoryLots = [];
    if (!Array.isArray(data.fifoAllocations)) data.fifoAllocations = [];
    if (typeof data.fifoInitialized !== 'boolean') data.fifoInitialized = false;
    if (data.fifoInitialized) {
      const fifoErrors = [
        ...validateFifoLedger(Array.isArray(data.products) ? data.products : [], data.inventoryLots),
        ...validateFifoAllocations(data.inventoryLots, data.fifoAllocations),
      ];
      if (fifoErrors.length) return { valid: false, error: `سجل FIFO في النسخة الاحتياطية غير متسق: ${fifoErrors[0]}` };
    }
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'هيكل بيانات النسخة الاحتياطية فارغ أو تالف' };
    }

    // 1. Mandatory check for all 12 collections (Requirement 1)
    for (const col of REQUIRED_COLLECTIONS) {
      if (!(col.key in data)) {
        return {
          valid: false,
          error: `ملف النسخة الاحتياطية ناقص: مجموعة [${col.label}] (${col.key}) مفقودة من الملف. لا يمكن الاستعادة من ملف غير مكتمل.`,
        };
      }

      if (col.isArray) {
        if (!Array.isArray(data[col.key])) {
          return {
            valid: false,
            error: `ملف النسخة الاحتياطية غير صالح: مجموعة [${col.label}] (${col.key}) ليست مصفوفة.`,
          };
        }
      } else {
        const shiftVal = data[col.key];
        if (shiftVal !== null && (typeof shiftVal !== 'object' || Array.isArray(shiftVal))) {
          return {
            valid: false,
            error: `ملف النسخة الاحتياطية غير صالح: حقل [${col.label}] (${col.key}) يجب أن يكون كائناً أو فارغاً (null).`,
          };
        }
      }
    }

    // 2. Schema version check
    if (parsed.schemaVersion && parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return {
        valid: false,
        error: `إصدار مخطط النسخة (${parsed.schemaVersion}) أحدث من الإصدار المدعوم في البرنامج (${CURRENT_SCHEMA_VERSION}). يُرجى تحديث البرنامج أولاً.`,
      };
    }

    // 3. Checksum verification (SHA-256)
    let isLegacy = false;
    let warning: string | undefined;
    let checksumStatus: BackupPreview['checksumStatus'] = 'missing';

    if (parsed.checksum) {
      const calculatedChecksum = await computeDataChecksum(checksumData);
      const legacyMatch = calculatedChecksum !== parsed.checksum
        ? await matchesLegacyDataChecksum(checksumData, parsed.checksum)
        : false;
      const checksumMismatch = calculatedChecksum !== parsed.checksum && !legacyMatch;

      if (checksumMismatch &&
        !options?.allowChecksumMismatchAfterVerifiedTransport &&
        !options?.allowChecksumMismatchAfterExplicitRecovery) {
        return {
          valid: false,
          error: 'فشل التحقق من التوقيع الرقمي (SHA-256). ملف النسخة الاحتياطية تالف أو تم التعديل عليه يدوياً.',
        };
      }

      if (checksumMismatch && options?.allowChecksumMismatchAfterVerifiedTransport) {
        checksumStatus = 'transport-verified';
        warning = 'بصمة البيانات الداخلية لا تطابق، لكن الملف السحابي نفسه اجتاز تحقق SHA-256 المستقل أثناء التنزيل. يُنصح بإنشاء نسخة جديدة بعد الاستعادة.';
      } else if (checksumMismatch && options?.allowChecksumMismatchAfterExplicitRecovery) {
        checksumStatus = 'mismatch';
        warning = 'تحذير أمني: بصمة SHA-256 المسجلة لا تطابق محتوى البيانات. اجتازت النسخة فحوص البنية وأعداد السجلات فقط، لكن لا يمكن إثبات أنها لم تُعدّل. لا تتابع إلا إذا كنت تثق بمصدر الملف وتقبل هذه المخاطرة. سيتم إنشاء لقطة أمان قبل الاستعادة.';
      } else if (legacyMatch) {
        checksumStatus = 'legacy-verified';
        warning = 'تم التحقق من النسخة باستخدام طريقة التوقيع المتوافقة مع إصدار أقدم. يُنصح بإنشاء نسخة احتياطية جديدة بعد الاستعادة.';
      } else {
        checksumStatus = 'verified';
      }
    } else {
      isLegacy = true;
      checksumStatus = 'missing';
      warning = 'تنبيه: ملف نسخة احتياطية قديم بدون توقيع رقمي، تم التحقق من سلامة البنية الداخلية واكتمال كافة المجموعات الاثنتي عشرة.';
    }

    // 4. Record count verification if provided (Requirement 1)
    if (parsed.recordCounts && typeof parsed.recordCounts === 'object') {
      for (const col of REQUIRED_COLLECTIONS) {
        if (col.isArray && typeof parsed.recordCounts[col.key] === 'number') {
          const expected = parsed.recordCounts[col.key];
          const actual = data[col.key].length;
          if (actual !== expected) {
            return {
              valid: false,
              error: `عدد سجلات ${col.label} في الملف (${actual}) لا يطابق الفهرس المسجل (${expected})، الملف غير مكتمل أو تالف.`,
            };
          }
        }
      }
      for (const key of ['inventoryLots', 'fifoAllocations']) {
        if (typeof parsed.recordCounts[key] === 'number' && Array.isArray(data[key]) && data[key].length !== parsed.recordCounts[key]) {
          return { valid: false, error: `عدد سجلات ${key} في الملف لا يطابق الفهرس المسجل.` };
        }
      }
      if (
        typeof parsed.recordCounts.salesReturns === 'number' &&
        Array.isArray(data.salesReturns) &&
        data.salesReturns.length !== parsed.recordCounts.salesReturns
      ) {
        return {
          valid: false,
          error: `عدد سجلات مرتجعات المبيعات في الملف (${data.salesReturns.length}) لا يطابق الفهرس المسجل (${parsed.recordCounts.salesReturns})، الملف غير مكتمل أو تالف.`,
        };
      }
    }

    const timestamp = parsed.timestamp || new Date().toISOString();
    const dateFormatted = new Date(timestamp).toLocaleString('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const preview: BackupPreview = {
      timestamp,
      dateFormatted,
      schemaVersion: parsed.schemaVersion || 1,
      appVersion: parsed.appVersion || parsed.version || '1.0',
      hasChecksum: Boolean(parsed.checksum),
      checksumStatus,
      isLegacy,
      warning,
      counts: {
        products: data.products.length,
        invoices: data.invoices.length,
        customers: data.customers.length,
        suppliers: data.suppliers.length,
        purchases: data.purchases.length,
        cashMovements: data.cashMovements.length,
        expenses: data.expenses.length,
        auditLogs: data.auditLogs.length,
        stockAdjustments: data.stockAdjustments.length,
        users: data.users.length,
        parkedCarts: data.parkedCarts.length,
      },
    };

    return {
      valid: true,
      warning,
      preview,
      validatedData: data,
    };
  }

  /**
   * Transactional Restore (Requirements 1, 2 & 4):
   * 1. Validates all 12 collections exist in data (no || [] fallback)
   * 2. If current data is non-empty, creates a pre_restore snapshot.
   *    If pre_restore snapshot fails (null, error, or ongoing process), restores is ABORTED completely.
   * 3. Writes new data to staging table `restore_staging` first
   * 4. Swaps into `kv` table in a single atomic Dexie transaction
   * 5. ONLY after the transaction succeeds, updates in-memory cache
   * If any step fails, current data remains 100% intact!
   */
  public async restoreData(
    data: Record<string, any>,
    sourceLabel: string = 'ملف خارجي',
    options?: {
      simulateFailureInTransaction?: boolean;
      simulatePreRestoreFailure?: boolean;
      allowInExpiredRestore?: boolean;
    }
  ): Promise<{ success: boolean; error?: string }> {
    if (!options?.allowInExpiredRestore) {
      const writeGate = storage.assertWriteAllowed('ADMIN_DATA', `استعادة بيانات (${sourceLabel})`);
      if (!writeGate.allowed) {
        return { success: false, error: writeGate.error };
      }
    }

    try {
      // Step 0: Support both enveloped { data: { ... } } and raw payload { products: ... }
      const payload = (data && typeof data === 'object' && data.data && typeof data.data === 'object' && !Array.isArray(data.data))
        ? data.data
        : data;

      // Validate that payload contains all 12 collections before touching anything!
      for (const col of REQUIRED_COLLECTIONS) {
        if (!(col.key in payload)) {
          return {
            success: false,
            error: `بيانات الاستعادة ناقصة: مجموعة [${col.label}] (${col.key}) مفقودة من البيانات. تم إيقاف الاستعادة.`,
          };
        }
        if (col.isArray) {
          if (!Array.isArray(payload[col.key])) {
            return {
              success: false,
              error: `بيانات الاستعادة غير صالحة: مجموعة [${col.label}] (${col.key}) ليست مصفوفة.`,
            };
          }
        } else {
          const shiftVal = payload[col.key];
          if (shiftVal !== null && (typeof shiftVal !== 'object' || Array.isArray(shiftVal))) {
            return {
              success: false,
              error: `بيانات الاستعادة غير صالحة: حقل [${col.label}] (${col.key}) غير صالح.`,
            };
          }
        }
      }

      if (payload.fifoInitialized) {
        const fifoErrors = [
          ...validateFifoLedger(payload.products, Array.isArray(payload.inventoryLots) ? payload.inventoryLots : []),
          ...validateFifoAllocations(Array.isArray(payload.inventoryLots) ? payload.inventoryLots : [], Array.isArray(payload.fifoAllocations) ? payload.fifoAllocations : []),
        ];
        if (fifoErrors.length) return { success: false, error: `سجل FIFO في بيانات الاستعادة غير متسق: ${fifoErrors[0]}` };
      }

      // Step 1: Pre-restore snapshot check (Requirement 2)
      // If current business data is NOT empty, a pre_restore snapshot MUST be taken.
      // If pre_restore snapshot fails (null, error, or isProcessingSnapshot), abort restore completely.
      const currentData = this.getCurrentBusinessData();
      const isCurrentDataEmpty =
        (!currentData.products || currentData.products.length === 0) &&
        (!currentData.invoices || currentData.invoices.length === 0) &&
        (!currentData.customers || currentData.customers.length === 0) &&
        (!currentData.suppliers || currentData.suppliers.length === 0) &&
        (!currentData.purchases || currentData.purchases.length === 0) &&
        (!currentData.cashMovements || currentData.cashMovements.length === 0) &&
        (!currentData.expenses || currentData.expenses.length === 0);

      if (!isCurrentDataEmpty) {
        if (this.isProcessingSnapshot || options?.simulatePreRestoreFailure) {
          return {
            success: false,
            error: 'تعذر إنشاء لقطة الأمان التلقائية (قبل الاستعادة) نظراً لوجود عملية جارية أو فشل في حفظ اللقطة. تم إيقاف الاستعادة بالكامل لحماية بياناتك الحالية.',
          };
        }

        let preRestoreSnap: SnapshotRecord | null = null;
        try {
          preRestoreSnap = await this.createSnapshot('pre_restore');
        } catch (err: any) {
          return {
            success: false,
            error: 'فشل إنشاء لقطة الأمان التلقائية (قبل الاستعادة): ' + (err?.message || 'خطأ غير معروف') + '. تم إيقاف الاستعادة بالكامل لحماية بياناتك الحالية.',
          };
        }

        if (!preRestoreSnap) {
          return {
            success: false,
            error: 'تعذر إنشاء لقطة الأمان التلقائية (قبل الاستعادة). تم إيقاف الاستعادة بالكامل ولا يمكن الكتابة فوق بياناتك الحالية.',
          };
        }
      }

      // Step 2: Build staging records directly from payload without '|| []' (Requirement 1)
      const stageRecords: KVRecord[] = [
        { key: STORAGE_KEYS.PRODUCTS, value: payload.products, updatedAt: Date.now() },
        { key: STORAGE_KEYS.CUSTOMERS, value: payload.customers, updatedAt: Date.now() },
        { key: STORAGE_KEYS.SUPPLIERS, value: payload.suppliers, updatedAt: Date.now() },
        { key: STORAGE_KEYS.INVOICES, value: payload.invoices, updatedAt: Date.now() },
        { key: STORAGE_KEYS.PURCHASES, value: payload.purchases, updatedAt: Date.now() },
        { key: STORAGE_KEYS.CASH_MOVEMENTS, value: payload.cashMovements, updatedAt: Date.now() },
        { key: STORAGE_KEYS.EXPENSES, value: payload.expenses, updatedAt: Date.now() },
        { key: STORAGE_KEYS.AUDIT_LOGS, value: payload.auditLogs, updatedAt: Date.now() },
        { key: STORAGE_KEYS.STOCK_ADJUSTMENTS, value: payload.stockAdjustments, updatedAt: Date.now() },
        { key: STORAGE_KEYS.USERS, value: payload.users, updatedAt: Date.now() },
        { key: STORAGE_KEYS.SHIFT, value: payload.currentShift, updatedAt: Date.now() },
        { key: STORAGE_KEYS.PARKED_CARTS, value: payload.parkedCarts, updatedAt: Date.now() },
        {
          key: STORAGE_KEYS.STORE_PROFILE,
          value: payload.storeProfile || (Array.isArray(payload.products) && payload.products.length > 0 ? LEGACY_STORE_PROFILE : DEFAULT_STORE_PROFILE),
          updatedAt: Date.now()
        },
        {
          key: STORAGE_KEYS.ACCOUNTING_MODE,
          value:
            payload.accountingMode === 'DAILY_DRAWER' ||
            payload.accountingMode === 'MONTHLY_POOL' ||
            payload.accountingMode === 'CAPITAL'
              ? payload.accountingMode
              : 'DAILY_DRAWER',
          updatedAt: Date.now(),
        },
        {
          key: STORAGE_KEYS.MONTHLY_POOL_INCLUDES_CAP_INJ,
          value: Boolean(payload.monthlyPoolIncludesCapitalInjection),
          updatedAt: Date.now(),
        },
        {
          key: STORAGE_KEYS.FUNDING_SOURCES,
          value:
            Array.isArray(payload.fundingSources) && payload.fundingSources.length > 0
              ? payload.fundingSources
              : JSON.parse(JSON.stringify(DEFAULT_FUNDING_SOURCES)),
          updatedAt: Date.now(),
        },
        {
          key: STORAGE_KEYS.SALES_RETURNS,
          value: Array.isArray(payload.salesReturns) ? payload.salesReturns : [],
          updatedAt: Date.now(),
        },
        { key: STORAGE_KEYS.INVENTORY_LOTS, value: Array.isArray(payload.inventoryLots) ? payload.inventoryLots : [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.FIFO_ALLOCATIONS, value: Array.isArray(payload.fifoAllocations) ? payload.fifoAllocations : [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.FIFO_INITIALIZED, value: Boolean(payload.fifoInitialized), updatedAt: Date.now() },
      ];

      if (typeof indexedDB !== 'undefined' && idb.restore_staging) {
        // Step 3: Write to staging table first
        await idb.restore_staging.clear();
        await idb.restore_staging.bulkPut(stageRecords);

        // Step 4: Verify staging count
        const stagedCount = await idb.restore_staging.count();
        if (stagedCount < stageRecords.length) {
          throw new Error('فشل التحقق من اكتمال مرحلة التجهيز المؤقتة للاستعادة');
        }

        // Step 5: Atomic swap within a single Dexie transaction
        await idb.transaction('rw', [idb.kv, idb.restore_staging], async () => {
          if (options?.simulateFailureInTransaction) {
            throw new Error('فشل محاكى في منتصف المعاملة: تم إلغاء الاستعادة والتراجع عن كل التغييرات');
          }
          const staged = await idb.restore_staging.toArray();
          await idb.kv.bulkPut(staged);
          await idb.restore_staging.clear();
        });
      }

      // Step 6: ONLY AFTER the transaction completes, update in-memory cache!
      storage.applyRestoredMemoryPayload(payload);

      storage.addAuditLog(
        'RESTORE',
        'استعادة قاعدة البيانات',
        'النسخ الاحتياطي',
        'admin',
        `تمت استعادة البيانات بنجاح وبشكل معاملاتي آمن من ${sourceLabel}` +
        (!isCurrentDataEmpty ? '، وتم حفظ لقطة أمان تلقائية قبل الاستعادة' : ' (بيانات حالية فارغة)')
      );

      return { success: true };
    } catch (err: any) {
      console.error('Error during transactional data restore:', err);
      // Clean up staging on failure
      try {
        if (typeof indexedDB !== 'undefined' && idb.restore_staging) {
          await idb.restore_staging.clear();
        }
      } catch {}
      return { success: false, error: err?.message || 'حدث خطأ أثناء تطبيق البيانات' };
    }
  }

  /**
   * Restores a snapshot by ID
   */
  public async restoreFromSnapshot(snapshotId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (typeof indexedDB === 'undefined') {
        return { success: false, error: 'IndexedDB غير متوفر في هذا المتصفح' };
      }

      const snapshot = await idb.snapshots.get(snapshotId);
      if (!snapshot) {
        return { success: false, error: 'تعذر العثور على اللقطة المطلوبة' };
      }

      // Check integrity if checksum present
      if (snapshot.metadata?.checksum) {
        const computed = await computeDataChecksum(snapshot.data);
        const legacyMatch = computed !== snapshot.metadata.checksum
          ? await matchesLegacyDataChecksum(snapshot.data, snapshot.metadata.checksum)
          : false;
        if (computed !== snapshot.metadata.checksum && !legacyMatch) {
          return { success: false, error: 'اللقطة الداخلية تالفة ولا تطابق التوقيع الرقمي' };
        }
      }

      return await this.restoreData(
        snapshot.data,
        `اللقطة الداخلية (${snapshot.dateStr} - ${snapshot.type})`
      );
    } catch (err: any) {
      return { success: false, error: err?.message || 'فشلت استعادة اللقطة' };
    }
  }

  // --- MANUAL BACKUP REMINDER (7 DAYS) ---
  public recordManualExport(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('last_manual_backup_export_at', String(Date.now()));
      } catch {}
    }
  }

  public snoozeReminderOneDay(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        const until = Date.now() + 24 * 60 * 60 * 1000;
        localStorage.setItem('backup_reminder_snoozed_until', String(until));
      } catch {}
    }
  }

  public getReminderStatus(): { needsReminder: boolean; daysSinceLastBackup: number } {
    if (typeof localStorage === 'undefined') {
      return { needsReminder: false, daysSinceLastBackup: 0 };
    }

    try {
      const snoozedUntil = Number(localStorage.getItem('backup_reminder_snoozed_until') || 0);
      if (Date.now() < snoozedUntil) {
        return { needsReminder: false, daysSinceLastBackup: 0 };
      }

      const rawLastExport = localStorage.getItem('last_manual_backup_export_at');
      const lastExport = rawLastExport ? Number(rawLastExport) : 0;

      let referenceTime = lastExport;
      if (!referenceTime) {
        const migratedAt = Number(localStorage.getItem('idb_migrated_at') || 0);
        referenceTime = migratedAt || (Date.now() - 8 * 24 * 60 * 60 * 1000);
      }

      const elapsedMs = Date.now() - referenceTime;
      const daysSince = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

      return {
        needsReminder: daysSince >= 7,
        daysSinceLastBackup: daysSince,
      };
    } catch {
      return { needsReminder: false, daysSinceLastBackup: 0 };
    }
  }
}

export const snapshotService = new SnapshotService();
