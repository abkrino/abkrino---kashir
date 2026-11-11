import { idb, SnapshotRecord, SnapshotMetadata, SnapshotStatus, KVRecord } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';

export const CURRENT_SCHEMA_VERSION = 1;
export const APP_VERSION = '1.0.0';

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
    users: number;
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
    users: number;
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
 * Deterministic JSON stringify to ensure consistent SHA-256 hashing across platforms
 */
export function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Computes SHA-256 hash using Web Crypto API
 */
export async function computeDataChecksum(data: any): Promise<string> {
  const canonical = canonicalStringify(data);
  const encoder = new TextEncoder();
  const buffer = encoder.encode(canonical);

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback hash for environments without Web Crypto subtle
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(64, '0');
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
      // Find the newest healthy snapshot
      const lastHealthy = all.find(s => s.status === 'healthy');

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
    type: 'daily' | 'shift_close' | 'pre_restore' | 'manual',
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

      // Status assignment: healthy by default, suspicious if specified or created under drop warning
      const status: SnapshotStatus = options?.status || 'healthy';

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
          users: data.users?.length || 0,
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
        `تم إنشاء لقطة بيانات داخلية (${type === 'daily' ? 'يومية' : type === 'shift_close' ? 'إغلاق وردية' : type === 'pre_restore' ? 'قبل الاستعادة' : 'يدوية'}) بحالة [${status === 'healthy' ? 'سليمة' : 'مشبوهة'}] بحجم ${(approxSizeBytes / 1024).toFixed(1)} ك.ب`
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
   * Keeps target count (7 normal, 3 on quota alert).
   * RULE: NEVER delete the newest 2 'healthy' snapshots, even if count exceeds the limit.
   */
  public async pruneOldSnapshots(targetKeepCount: number = 7): Promise<number> {
    try {
      if (typeof indexedDB === 'undefined') return 0;
      const all = await idb.snapshots.orderBy('timestamp').toArray();
      if (all.length <= targetKeepCount) return 0;

      // Identify the 2 newest healthy snapshots to protect
      const healthySnapshots = all
        .filter(s => s.status === 'healthy')
        .sort((a, b) => a.timestamp - b.timestamp);

      const lastTwoHealthy = healthySnapshots.slice(-2);
      const protectedIds = new Set(lastTwoHealthy.map(s => s.id));

      // Candidates to delete: sort from oldest to newest
      const candidates = [...all].sort((a, b) => a.timestamp - b.timestamp);
      const toDelete: string[] = [];

      let remainingCount = all.length;
      for (const snap of candidates) {
        if (remainingCount <= targetKeepCount) break;
        // NEVER delete protected healthy snapshots
        if (!protectedIds.has(snap.id)) {
          toDelete.push(snap.id);
          remainingCount--;
        }
      }

      if (toDelete.length > 0) {
        await idb.snapshots.bulkDelete(toDelete);
        return toDelete.length;
      }
      return 0;
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
        users: data.users?.length || 0,
      },
      checksum,
      data,
    };
  }

  /**
   * Validates a backup file/object (checksum, schema version, record counts) and returns a preview
   */
  public async validateBackup(content: string | Record<string, any>): Promise<{
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
    if (!data || typeof data !== 'object' || !Array.isArray(data.products) || !Array.isArray(data.customers)) {
      return { valid: false, error: 'الملف لا يحتوي على جداول البيانات الأساسية (المنتجات والعملاء)' };
    }

    // 1. Schema version check
    if (parsed.schemaVersion && parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
      return {
        valid: false,
        error: `إصدار مخطط النسخة (${parsed.schemaVersion}) أحدث من الإصدار المدعوم في البرنامج (${CURRENT_SCHEMA_VERSION}). يُرجى تحديث البرنامج أولاً.`,
      };
    }

    // 2. Checksum verification
    let isLegacy = false;
    let warning: string | undefined;

    if (parsed.checksum) {
      const calculatedChecksum = await computeDataChecksum(data);
      if (calculatedChecksum !== parsed.checksum) {
        return {
          valid: false,
          error: 'فشل التحقق من التوقيع الرقمي (SHA-256). ملف النسخة الاحتياطية تالف أو تم التعديل عليه يدوياً.',
        };
      }
    } else {
      isLegacy = true;
      warning = 'تنبيه: ملف نسخة احتياطية قديم بدون توقيع رقمي، تم التحقق من سلامة البنية الداخلية.';
    }

    // 3. Record count verification if provided
    if (parsed.recordCounts && typeof parsed.recordCounts === 'object') {
      const expectedProducts = parsed.recordCounts.products;
      const expectedInvoices = parsed.recordCounts.invoices;
      if (typeof expectedProducts === 'number' && data.products.length !== expectedProducts) {
        return {
          valid: false,
          error: `عدد المنتجات في الملف (${data.products.length}) لا يطابق الفهرس المسجل (${expectedProducts})، الملف غير مكتمل.`,
        };
      }
      if (typeof expectedInvoices === 'number' && data.invoices.length !== expectedInvoices) {
        return {
          valid: false,
          error: `عدد الفواتير في الملف (${data.invoices.length}) لا يطابق الفهرس المسجل (${expectedInvoices})، الملف غير مكتمل.`,
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
      isLegacy,
      warning,
      counts: {
        products: data.products?.length || 0,
        invoices: data.invoices?.length || 0,
        customers: data.customers?.length || 0,
        suppliers: data.suppliers?.length || 0,
        purchases: data.purchases?.length || 0,
        cashMovements: data.cashMovements?.length || 0,
        expenses: data.expenses?.length || 0,
        users: data.users?.length || 0,
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
   * Transactional Restore (Requirement 4):
   * 1. Takes an automatic "pre_restore" snapshot of current state
   * 2. Writes new data to staging table `restore_staging` first
   * 3. Verifies staging completeness
   * 4. Swaps into `kv` table in a single atomic Dexie transaction
   * 5. ONLY after the transaction succeeds, updates in-memory cache
   * If any step fails, current data remains 100% intact!
   */
  public async restoreData(
    data: Record<string, any>,
    sourceLabel: string = 'ملف خارجي',
    options?: { simulateFailureInTransaction?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Step 1: Automatic pre-restore snapshot
      await this.createSnapshot('pre_restore');

      const stageRecords: KVRecord[] = [
        { key: STORAGE_KEYS.PRODUCTS, value: data.products || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.CUSTOMERS, value: data.customers || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.SUPPLIERS, value: data.suppliers || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.INVOICES, value: data.invoices || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.PURCHASES, value: data.purchases || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.CASH_MOVEMENTS, value: data.cashMovements || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.EXPENSES, value: data.expenses || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.AUDIT_LOGS, value: data.auditLogs || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.STOCK_ADJUSTMENTS, value: data.stockAdjustments || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.USERS, value: data.users || [], updatedAt: Date.now() },
        { key: STORAGE_KEYS.SHIFT, value: data.currentShift || null, updatedAt: Date.now() },
        { key: STORAGE_KEYS.PARKED_CARTS, value: data.parkedCarts || [], updatedAt: Date.now() },
      ];

      if (typeof indexedDB !== 'undefined' && idb.restore_staging) {
        // Step 2: Write to staging table first
        await idb.restore_staging.clear();
        await idb.restore_staging.bulkPut(stageRecords);

        // Step 3: Verify staging count
        const stagedCount = await idb.restore_staging.count();
        if (stagedCount < stageRecords.length) {
          throw new Error('فشل التحقق من اكتمال مرحلة التجهيز المؤقتة للاستعادة');
        }

        // Step 4: Atomic swap within a single Dexie transaction
        await idb.transaction('rw', [idb.kv, idb.restore_staging], async () => {
          if (options?.simulateFailureInTransaction) {
            throw new Error('فشل محاكى في منتصف المعاملة: تم إلغاء الاستعادة والتراجع عن كل التغييرات');
          }
          const staged = await idb.restore_staging.toArray();
          await idb.kv.bulkPut(staged);
          await idb.restore_staging.clear();
        });
      }

      // Step 5: ONLY AFTER the transaction completes, update in-memory cache!
      storage.applyRestoredMemoryPayload(data);

      storage.addAuditLog(
        'RESTORE',
        'استعادة قاعدة البيانات',
        'النسخ الاحتياطي',
        'admin',
        `تمت استعادة البيانات بنجاح وبشكل معاملاتي آمن من ${sourceLabel}، وتم حفظ لقطة أمان تلقائية قبل الاستعادة`
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
        if (computed !== snapshot.metadata.checksum) {
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
