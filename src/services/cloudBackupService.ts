import {
  doc,
  collection,
  writeBatch,
  serverTimestamp,
  Firestore,
} from 'firebase/firestore';
import { db, auth, isCloudConfigured } from './cloudService';
import { orgSyncService } from './orgSyncService';
import { translateFirebaseError } from './firebaseErrorTranslator';
import {
  snapshotService,
  computeDataChecksum,
  CURRENT_SCHEMA_VERSION,
  ExportBackupPackage,
  BackupPreview,
} from './snapshotService';
import { storage, getCairoDateString } from './storageService';
import { APP_VERSION } from '../config/appConfig';
import { BackupMetadata, CloudBackupTrigger } from '../types/cloud';
import { User } from '../types';
import {
  cloudBudgetService,
  BUDGET_EXCEEDED_MESSAGE_AR,
  SIX_HOUR_PAUSE_MS,
  ERROR_BACKOFF_STEPS_MS,
  computeBackoffDelayMs,
  isSixHourPauseError,
  isBudgetExceededError,
} from './cloudBudgetService';

export const CHUNK_MAX_CHARS = 700_000;
export const MAX_BATCH_BYTES = 3 * 1024 * 1024; // 3 MB safe limit per writeBatch
export const CLOUD_BACKUP_KEEP_COUNT = 7;
export const CLOUD_BACKUP_DAILY_DAYS_KEEP = 7;
export const CLOUD_BACKUP_TODAY_KEEP = 6;
export const PERIODIC_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const STALE_INCOMPLETE_BACKUP_MS = 24 * 60 * 60 * 1000; // 24 hours

const LOCAL_KEYS = {
  LAST_DAILY_CAIRO_DATE: 'sm_cloud_backup_last_date_v1',
  LAST_DATA_CHECKSUM: 'sm_cloud_backup_last_data_checksum_v1',
  LAST_BACKUP_META: 'sm_cloud_backup_last_meta_v1',
};

export interface CloudBackupSummary {
  id: string;
  createdAtIso: string;
  createdAtMs: number;
  sizeBytes: number;
  appVersion: string;
  totalChunks: number;
  totalProducts: number;
  totalInvoices: number;
  totalCustomers: number;
  checksum: string;
  dataChecksum?: string;
  compressed: boolean;
  schemaVersion: number;
  trigger?: CloudBackupTrigger;
  note?: string;
  status: 'complete';
}

export interface CloudBackupOperationResult {
  success: boolean;
  skipped?: boolean;
  reason?:
    | 'unconfigured'
    | 'offline'
    | 'no_license'
    | 'needs_login'
    | 'wrong_account'
    | 'permission_paused'
    | 'budget_paused'
    | 'backoff_paused'
    | 'in_progress'
    | 'no_changes'
    | 'empty_data'
    | 'suspicious_drop'
    | 'error';
  message?: string;
  error?: string;
  backup?: CloudBackupSummary;
}

export interface CloudRestoreDownloadProgress {
  loadedChunks: number;
  totalChunks: number;
  percent: number;
}

export interface CloudDownloadValidationResult {
  success: boolean;
  error?: string;
  warning?: string;
  backup?: CloudBackupSummary;
  preview?: BackupPreview;
  validatedData?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Pure Helpers (Exported for Unit Tests)
// ---------------------------------------------------------------------------

/**
 * Removes all login credentials (pinHash, pinSalt, pinCode, mustChangePin, and any password/hash fields)
 * from every user object in the backup payload without mutating original storage arrays.
 */
export function stripUserCredentialsFromData(data: Record<string, any>): Record<string, any> {
  const clonedData: Record<string, any> = { ...data };
  if (Array.isArray(data.users)) {
    clonedData.users = data.users.map((u: User & Record<string, any>) => {
      const cleanUser: Record<string, any> = {};
      for (const key of Object.keys(u)) {
        const lower = key.toLowerCase();
        if (
          key === 'pinHash' ||
          key === 'pinSalt' ||
          key === 'pinCode' ||
          key === 'mustChangePin' ||
          lower.includes('password') ||
          lower.includes('hash') ||
          lower.includes('salt')
        ) {
          continue;
        }
        cleanUser[key] = u[key];
      }
      return cleanUser;
    });
  }
  return clonedData;
}

/**
 * Chunked Uint8Array -> Base64 converter safe for large payloads (no spread call-stack overflow).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const sliceSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const sub = bytes.subarray(i, Math.min(i + sliceSize, bytes.length));
    let part = '';
    for (let j = 0; j < sub.length; j++) {
      part += String.fromCharCode(sub[j]);
    }
    binary += part;
  }
  return btoa(binary);
}

/**
 * Base64 -> Uint8Array converter.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compresses UTF-8 string using native gzip CompressionStream (Chrome 108 / Firefox 115+)
 * with automatic uncompressed Base64 fallback if CompressionStream is unavailable.
 */
export async function compressStringToBase64(
  text: string,
  options?: { forceDisableCompression?: boolean }
): Promise<{ encoded: string; compressed: boolean }> {
  const rawBytes = new TextEncoder().encode(text);

  if (
    !options?.forceDisableCompression &&
    typeof CompressionStream !== 'undefined' &&
    typeof ReadableStream !== 'undefined' &&
    typeof Response !== 'undefined'
  ) {
    try {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      });
      const gzipStream = source.pipeThrough(
        new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
      );
      const compressedBuf = await new Response(gzipStream).arrayBuffer();
      return {
        encoded: uint8ArrayToBase64(new Uint8Array(compressedBuf)),
        compressed: true,
      };
    } catch {
      // Fall back gracefully without compression
    }
  }

  return {
    encoded: uint8ArrayToBase64(rawBytes),
    compressed: false,
  };
}

/**
 * Reverses compressStringToBase64.
 */
export async function decompressBase64ToString(
  encoded: string,
  compressed: boolean
): Promise<string> {
  const bytes = base64ToUint8Array(encoded);
  if (compressed) {
    if (
      typeof DecompressionStream === 'undefined' ||
      typeof ReadableStream === 'undefined' ||
      typeof Response === 'undefined'
    ) {
      throw new Error('المتصفح الحالي لا يدعم فك ضغط gzip للنسخة الاحتياطية.');
    }
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const gunzipStream = source.pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
    );
    const outBuf = await new Response(gunzipStream).arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(outBuf));
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Splits serialized string into chunks of at most maxChars characters (default 700,000).
 */
export function splitIntoChunks(
  encoded: string,
  maxChars: number = CHUNK_MAX_CHARS
): string[] {
  if (!encoded) return [''];
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += maxChars) {
    chunks.push(encoded.slice(i, i + maxChars));
  }
  return chunks;
}

/**
 * Computes SHA-256 hex digest of a string (for payload checksum after compression).
 */
export async function computeTextSha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = ((h << 5) - h + bytes[i]) | 0;
  }
  return Math.abs(h).toString(16).padStart(64, '0');
}

export function extractTimestampMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof ts === 'object') {
    const obj = ts as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj.toDate === 'function') return obj.toDate().getTime();
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return 0;
}

function parseCairoDateUtcMs(dateStr: string): number {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export interface RetentionBackupCandidate {
  id: string;
  createdAtMs: number;
  cairoDate?: string;
}

/**
 * Pure retention selector:
 * - Always keeps the absolute newest complete backup (and protectedLatestId if provided).
 * - Keeps up to the newest 6 backups created on today's Cairo date.
 * - Keeps the latest backup of each day for the last 7 days (diffDays 0..6 relative to todayCairoDate).
 * - Schedules all older/excess backups for deletion.
 */
export function selectBackupsToKeepAndDelete(
  backups: RetentionBackupCandidate[],
  todayCairoDate: string = getCairoDateString(new Date()),
  protectedLatestId?: string,
  options?: { dailyDaysKeep?: number; todayKeep?: number }
): { keepIds: string[]; deleteIds: string[] } {
  if (!backups || backups.length === 0) {
    return { keepIds: [], deleteIds: [] };
  }

  const dailyDaysKeep = Math.max(1, options?.dailyDaysKeep ?? CLOUD_BACKUP_DAILY_DAYS_KEEP);
  const todayKeep = Math.max(1, options?.todayKeep ?? CLOUD_BACKUP_TODAY_KEEP);

  const sorted = [...backups].sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return b.id.localeCompare(a.id);
  });

  const keepSet = new Set<string>();

  // Absolute newest complete backup & protected ID are ALWAYS kept
  keepSet.add(sorted[0].id);
  if (protectedLatestId && sorted.some(b => b.id === protectedLatestId)) {
    keepSet.add(protectedLatestId);
  }

  const todayUtcMs = parseCairoDateUtcMs(todayCairoDate);
  const seenDailyDates = new Set<string>();
  let todayKeptCount = 0;

  for (const item of sorted) {
    const itemDate =
      item.cairoDate ||
      (item.createdAtMs > 0 ? getCairoDateString(new Date(item.createdAtMs)) : todayCairoDate);
    const itemUtcMs = parseCairoDateUtcMs(itemDate);
    const diffDays =
      !Number.isNaN(todayUtcMs) && !Number.isNaN(itemUtcMs)
        ? Math.round((todayUtcMs - itemUtcMs) / 86_400_000)
        : 0;

    // 1. Inside today: keep up to newest 6 backups
    if (itemDate === todayCairoDate || diffDays === 0) {
      if (todayKeptCount < todayKeep) {
        keepSet.add(item.id);
        todayKeptCount++;
      }
      seenDailyDates.add(itemDate);
      continue;
    }

    // 2. Last 7 days (days 1..6 prior to today -> total 7 calendar days with today): keep latest backup of each day
    if (diffDays > 0 && diffDays < dailyDaysKeep) {
      if (!seenDailyDates.has(itemDate)) {
        seenDailyDates.add(itemDate);
        keepSet.add(item.id);
      }
    }
  }

  const keepIds: string[] = [];
  const deleteIds: string[] = [];
  for (const item of sorted) {
    if (keepSet.has(item.id)) {
      keepIds.push(item.id);
    } else {
      deleteIds.push(item.id);
    }
  }

  return { keepIds, deleteIds };
}

function isTransientNetworkError(err: unknown): boolean {
  const obj = (err && typeof err === 'object' ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof obj.code === 'string' ? obj.code.toLowerCase() : '';
  const msg = typeof obj.message === 'string' ? obj.message.toLowerCase() : String(err ?? '').toLowerCase();
  return (
    code.includes('unavailable') ||
    code.includes('network-request-failed') ||
    code.includes('deadline-exceeded') ||
    code.includes('aborted') ||
    msg.includes('unavailable') ||
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('timeout')
  );
}

// ---------------------------------------------------------------------------
// Cloud Backup Service
// ---------------------------------------------------------------------------

class CloudBackupService {
  private isUploading = false;
  private inFlightDailyPromise: Promise<CloudBackupOperationResult> | null = null;
  private permissionPaused = false;
  private permissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffStep = 0;
  private backoffUntilMs = 0;
  private lastError: string | null = null;
  private dropAlert: string | null = null;
  private listeners: (() => void)[] = [];
  private retryBaseDelayMs = 400;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  public setRetryDelayMsForTesting(delayMs: number): void {
    this.retryBaseDelayMs = delayMs;
  }

  public resetInternalStateForTesting(): void {
    this.stopPeriodicBackup();
    this.isUploading = false;
    this.inFlightDailyPromise = null;
    this.permissionPaused = false;
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
      this.permissionRetryTimer = null;
    }
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
    this.lastError = null;
    this.dropAlert = null;
  }

  public startPeriodicBackup(intervalMs: number = PERIODIC_BACKUP_INTERVAL_MS): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      this.runPeriodicBackupCheck().catch(() => {});
    }, intervalMs);
  }

  public stopPeriodicBackup(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  public isPeriodicBackupRunning(): boolean {
    return this.periodicTimer !== null;
  }

  public async runPeriodicBackupCheck(): Promise<CloudBackupOperationResult> {
    if (!storage.isStorageReady()) {
      return { success: false, skipped: true, reason: 'in_progress' };
    }
    if (this.isUploading) {
      return { success: false, skipped: true, reason: 'in_progress' };
    }
    if (!isCloudConfigured || !db || !auth) {
      return { success: false, skipped: true, reason: 'unconfigured' };
    }
    if (this.permissionPaused) {
      return { success: false, skipped: true, reason: 'permission_paused' };
    }
    if (cloudBudgetService.isExceeded()) {
      return {
        success: false,
        skipped: true,
        reason: 'budget_paused',
        error: BUDGET_EXCEEDED_MESSAGE_AR,
      };
    }
    if (this.backoffUntilMs > Date.now()) {
      return { success: false, skipped: true, reason: 'backoff_paused' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { success: false, skipped: true, reason: 'offline' };
    }
    if (!orgSyncService.getContext()) {
      return { success: false, skipped: true, reason: 'no_license' };
    }
    const authStatus = orgSyncService.ensureSignedIn();
    if (authStatus !== 'ok') {
      return {
        success: false,
        skipped: true,
        reason: authStatus === 'wrong-account' ? 'wrong_account' : 'needs_login',
      };
    }

    return this.createAndUploadBackup('periodic', 'نسخة سحابية دورية تلقائية');
  }

  public subscribe(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb);
    };
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch {}
    }
  }

  public isUploadInProgress(): boolean {
    return this.isUploading;
  }

  public isPermissionPaused(): boolean {
    return this.permissionPaused;
  }

  public resetPermissionPause(): void {
    let changed = false;
    if (this.permissionPaused) {
      this.permissionPaused = false;
      changed = true;
    }
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
      this.permissionRetryTimer = null;
    }
    if (this.backoffStep !== 0 || this.backoffUntilMs !== 0) {
      this.backoffStep = 0;
      this.backoffUntilMs = 0;
      changed = true;
    }
    if (changed) {
      this.notifyListeners();
    }
  }

  public getBackoffStep(): number {
    return this.backoffStep;
  }

  public getBackoffUntilMs(): number {
    return this.backoffUntilMs;
  }

  public getPermissionRetryTimer(): ReturnType<typeof setTimeout> | null {
    return this.permissionRetryTimer;
  }

  private activateSixHourPause(): void {
    this.permissionPaused = true;
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
    if (this.permissionRetryTimer) {
      clearTimeout(this.permissionRetryTimer);
    }
    this.permissionRetryTimer = setTimeout(() => {
      this.permissionRetryTimer = null;
      this.permissionPaused = false;
      this.notifyListeners();
    }, SIX_HOUR_PAUSE_MS);
  }

  private recordFailureBackoff(): void {
    const delayMs = computeBackoffDelayMs(this.backoffStep);
    this.backoffStep = Math.min(this.backoffStep + 1, ERROR_BACKOFF_STEPS_MS.length - 1);
    this.backoffUntilMs = Date.now() + delayMs;
  }

  private resetBackoff(): void {
    this.backoffStep = 0;
    this.backoffUntilMs = 0;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getDropAlert(): string | null {
    return this.dropAlert;
  }

  public clearDropAlert(): void {
    this.dropAlert = null;
    this.notifyListeners();
  }

  public getLastSuccessfulBackup(): CloudBackupSummary | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(LOCAL_KEYS.LAST_BACKUP_META);
      return raw ? (JSON.parse(raw) as CloudBackupSummary) : null;
    } catch {
      return null;
    }
  }

  private saveLastSuccessfulBackup(summary: CloudBackupSummary, dataChecksum: string, cairoDate: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LOCAL_KEYS.LAST_BACKUP_META, JSON.stringify(summary));
      localStorage.setItem(LOCAL_KEYS.LAST_DATA_CHECKSUM, dataChecksum);
      localStorage.setItem(LOCAL_KEYS.LAST_DAILY_CAIRO_DATE, cairoDate);
    } catch {}
  }

  private getLastUploadedDataChecksum(): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(LOCAL_KEYS.LAST_DATA_CHECKSUM);
    } catch {
      return null;
    }
  }

  private async runWithTransientRetry<T>(fn: () => Promise<T>, maxRetries: number = 2): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (
          isSixHourPauseError(err) ||
          isBudgetExceededError(err) ||
          !isTransientNetworkError(err) ||
          attempt >= maxRetries
        ) {
          throw err;
        }
        attempt++;
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  private async deleteBackupAndChunks(
    firestoreDb: Firestore,
    orgId: string,
    branchId: string,
    backupId: string
  ): Promise<void> {
    const chunksCol = collection(
      firestoreDb,
      'orgs',
      orgId,
      'branches',
      branchId,
      'backups',
      backupId,
      'chunks'
    );
    const chunkSnap = await cloudBudgetService.budgetedGetDocs(chunksCol);
    const chunkDocs = chunkSnap.docs || [];

    // Delete chunks in batches <= 400 first
    for (let i = 0; i < chunkDocs.length; i += 400) {
      const batch = writeBatch(firestoreDb);
      const slice = chunkDocs.slice(i, i + 400);
      for (const cDoc of slice) {
        batch.delete(cDoc.ref);
      }
      await cloudBudgetService.budgetedCommitBatch(batch, { deletes: slice.length });
    }

    // Then delete metadata doc
    const backupRef = doc(firestoreDb, 'orgs', orgId, 'branches', branchId, 'backups', backupId);
    await cloudBudgetService.budgetedDeleteDoc(backupRef);
  }

  private toSummary(id: string, meta: BackupMetadata): CloudBackupSummary {
    const ms = extractTimestampMs(meta.createdAt) || Date.now();
    return {
      id,
      createdAtIso: new Date(ms).toISOString(),
      createdAtMs: ms,
      sizeBytes: Number(meta.sizeBytes) || 0,
      appVersion: meta.appVersion || APP_VERSION,
      totalChunks: Number(meta.totalChunks) || 1,
      totalProducts: Number(meta.totalProducts) || 0,
      totalInvoices: Number(meta.totalInvoices) || 0,
      totalCustomers: Number(meta.totalCustomers) || 0,
      checksum: meta.checksum || '',
      dataChecksum: meta.dataChecksum,
      compressed: Boolean(meta.compressed),
      schemaVersion: Number(meta.schemaVersion) || CURRENT_SCHEMA_VERSION,
      trigger: meta.trigger,
      note: meta.note,
      status: 'complete',
    };
  }

  /**
   * Lists complete cloud backups (sorted newest first).
   * Excludes any incomplete backups (`status !== 'complete'`).
   * Cleans up stale incomplete backups older than 24h in background.
   */
  public async listCompleteBackups(options?: {
    bypassBudget?: boolean;
  }): Promise<{
    success: boolean;
    backups: CloudBackupSummary[];
    error?: string;
  }> {
    if (!isCloudConfigured || !db || !auth) {
      return { success: false, backups: [], error: 'السحابة غير مُعدّة بعد.' };
    }
    const context = orgSyncService.getContext();
    if (!context) {
      return { success: false, backups: [], error: 'لا يوجد ترخيص سارٍ لتحديد المنشأة والفرع.' };
    }
    const authStatus = orgSyncService.ensureSignedIn();
    if (authStatus !== 'ok') {
      return {
        success: false,
        backups: [],
        error:
          authStatus === 'wrong-account'
            ? 'الحساب المسجّل لا يطابق ترخيص الجهاز.'
            : 'يجب تسجيل دخول المحل للسحابة أولاً.',
      };
    }

    try {
      const backupsCol = collection(db, 'orgs', context.orgId, 'branches', context.branchId, 'backups');
      const snap = await this.runWithTransientRetry(() =>
        cloudBudgetService.budgetedGetDocs(backupsCol, { bypassBudget: options?.bypassBudget })
      );

      const completeList: CloudBackupSummary[] = [];
      const staleIncompleteIds: string[] = [];
      const nowMs = Date.now();

      for (const docSnap of snap.docs) {
        const raw = docSnap.data() as { metadata?: BackupMetadata };
        const meta = raw?.metadata;
        if (!meta) continue;

        if (meta.status !== 'complete') {
          const createdMs = extractTimestampMs(meta.createdAt);
          if (createdMs > 0 && nowMs - createdMs > STALE_INCOMPLETE_BACKUP_MS) {
            staleIncompleteIds.push(docSnap.id);
          }
          continue;
        }

        completeList.push(this.toSummary(docSnap.id, meta));
      }

      completeList.sort((a, b) => {
        if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
        return b.id.localeCompare(a.id);
      });

      if (completeList.length > 0 && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(LOCAL_KEYS.LAST_BACKUP_META, JSON.stringify(completeList[0]));
        } catch {}
      }

      // Best-effort cleanup of stale incomplete backups (> 24h)
      if (staleIncompleteIds.length > 0 && !this.permissionPaused && !cloudBudgetService.isExceeded()) {
        for (const staleId of staleIncompleteIds) {
          this.deleteBackupAndChunks(db, context.orgId, context.branchId, staleId).catch(() => {});
        }
      }

      return { success: true, backups: completeList };
    } catch (err) {
      if (isBudgetExceededError(err)) {
        this.lastError = BUDGET_EXCEEDED_MESSAGE_AR;
        this.notifyListeners();
        return { success: false, backups: [], error: BUDGET_EXCEEDED_MESSAGE_AR };
      }
      const translated = translateFirebaseError(err);
      if (isSixHourPauseError(err)) {
        this.activateSixHourPause();
      }
      this.lastError = translated;
      this.notifyListeners();
      return { success: false, backups: [], error: translated };
    }
  }

  /**
   * Checks daily backup status and creates today's backup once per Cairo calendar day.
   * Single-flight guarded so concurrent callers never upload duplicates.
   */
  public async checkAndCreateDailyBackup(): Promise<CloudBackupOperationResult> {
    if (this.inFlightDailyPromise) {
      return this.inFlightDailyPromise;
    }
    if (!storage.isStorageReady()) {
      return { success: false, skipped: true, reason: 'in_progress' };
    }
    if (this.isUploading) {
      return { success: false, skipped: true, reason: 'in_progress' };
    }
    if (this.permissionPaused) {
      return { success: false, skipped: true, reason: 'permission_paused' };
    }
    if (cloudBudgetService.isExceeded()) {
      return {
        success: false,
        skipped: true,
        reason: 'budget_paused',
        error: BUDGET_EXCEEDED_MESSAGE_AR,
      };
    }
    if (this.backoffUntilMs > Date.now()) {
      return { success: false, skipped: true, reason: 'backoff_paused' };
    }

    const todayCairo = getCairoDateString(new Date());
    if (typeof localStorage !== 'undefined') {
      try {
        if (localStorage.getItem(LOCAL_KEYS.LAST_DAILY_CAIRO_DATE) === todayCairo) {
          return {
            success: true,
            skipped: true,
            reason: 'no_changes',
            message: 'تم أخذ النسخة السحابية اليومية لهذا اليوم مسبقاً.',
          };
        }
      } catch {}
    }

    const task = this.createAndUploadBackup('daily').finally(() => {
      if (this.inFlightDailyPromise === task) {
        this.inFlightDailyPromise = null;
      }
    });
    this.inFlightDailyPromise = task;
    return task;
  }

  /**
   * Triggered automatically after shift closure.
   */
  public async onShiftClosed(): Promise<CloudBackupOperationResult> {
    return this.createAndUploadBackup('shift_close', 'إغلاق وردية تلقائي');
  }

  /**
   * Creates, strips credentials, gzips, chunks (<= 700k chars), and uploads backup to Firestore.
   */
  public async createAndUploadBackup(
    trigger: CloudBackupTrigger = 'manual',
    note?: string,
    options?: { forceDisableCompression?: boolean; forceIgnoreDrop?: boolean }
  ): Promise<CloudBackupOperationResult> {
    if (this.isUploading) {
      return { success: false, skipped: true, reason: 'in_progress', error: 'عملية رفع نسخة احتياطية جارية بالفعل.' };
    }
    if (!isCloudConfigured || !db || !auth) {
      return { success: false, skipped: true, reason: 'unconfigured', error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.permissionPaused && trigger !== 'manual') {
      return { success: false, skipped: true, reason: 'permission_paused' };
    }
    if (cloudBudgetService.isExceeded()) {
      return {
        success: false,
        skipped: true,
        reason: 'budget_paused',
        error: BUDGET_EXCEEDED_MESSAGE_AR,
      };
    }
    if (trigger !== 'manual' && this.backoffUntilMs > Date.now()) {
      return { success: false, skipped: true, reason: 'backoff_paused' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { success: false, skipped: true, reason: 'offline', error: 'لا يوجد اتصال بالإنترنت حالياً.' };
    }

    const context = orgSyncService.getContext();
    if (!context) {
      return { success: false, skipped: true, reason: 'no_license', error: 'لا يوجد ترخيص سارٍ لتحديد المنشأة والفرع.' };
    }

    const authStatus = orgSyncService.ensureSignedIn();
    if (authStatus !== 'ok') {
      return {
        success: false,
        skipped: true,
        reason: authStatus === 'wrong-account' ? 'wrong_account' : 'needs_login',
        error:
          authStatus === 'wrong-account'
            ? 'الحساب المسجّل لا يطابق ترخيص الجهاز (orgId).'
            : 'يجب تسجيل دخول المحل للسحابة أولاً.',
      };
    }

    const inlineMaxRetries = trigger === 'manual' ? 2 : 0;

    this.isUploading = true;
    this.notifyListeners();

    try {
      const rawData = snapshotService.getCurrentBusinessData();
      const sanitizedData = stripUserCredentialsFromData(rawData);

      const totalProducts = Array.isArray(sanitizedData.products) ? sanitizedData.products.length : 0;
      const totalInvoices = Array.isArray(sanitizedData.invoices) ? sanitizedData.invoices.length : 0;
      const totalCustomers = Array.isArray(sanitizedData.customers) ? sanitizedData.customers.length : 0;

      // 1. Refuse empty data
      if (totalProducts === 0 && totalInvoices === 0 && totalCustomers === 0) {
        return {
          success: false,
          reason: 'empty_data',
          error: 'بيانات المحل فارغة، تم إيقاف الرفع السحابي لحماية النسخ الاحتياطية.',
        };
      }

      // 2. Compare change-detection fingerprint against last successful cloud backup
      // Exclude self-generated cloud-backup audit entries so logging a backup doesn't force an extra upload
      const sanitizedForFingerprint: Record<string, any> = {
        ...sanitizedData,
        auditLogs: Array.isArray(sanitizedData.auditLogs)
          ? sanitizedData.auditLogs.filter((entry: any) => entry?.entity !== 'النسخ السحابي')
          : sanitizedData.auditLogs,
      };
      const changeChecksum = await computeDataChecksum(sanitizedForFingerprint);
      const lastDataChecksum = this.getLastUploadedDataChecksum();
      const todayCairo = getCairoDateString(new Date());

      if (lastDataChecksum && lastDataChecksum === changeChecksum) {
        if (trigger === 'daily' && typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(LOCAL_KEYS.LAST_DAILY_CAIRO_DATE, todayCairo);
          } catch {}
        }
        return {
          success: true,
          skipped: true,
          reason: 'no_changes',
          message: 'لا توجد تغييرات في البيانات منذ آخر نسخة سحابية ناجحة.',
        };
      }

      // 3. Check > 30% drop compared to the newest healthy complete cloud backup
      if (!options?.forceIgnoreDrop) {
        let baseline = this.getLastSuccessfulBackup();
        if (!baseline) {
          const remoteList = await this.listCompleteBackups();
          if (remoteList.success && remoteList.backups.length > 0) {
            baseline = remoteList.backups[0];
          }
        }

        if (baseline) {
          const checks = [
            { oldVal: baseline.totalProducts, newVal: totalProducts, label: 'الأصناف' },
            { oldVal: baseline.totalInvoices, newVal: totalInvoices, label: 'الفواتير' },
            { oldVal: baseline.totalCustomers, newVal: totalCustomers, label: 'العملاء' },
          ];

          for (const c of checks) {
            if (c.oldVal > 0 && c.newVal < c.oldVal) {
              const dropRatio = (c.oldVal - c.newVal) / c.oldVal;
              if (dropRatio > 0.3) {
                const pct = Math.round(dropRatio * 100);
                const msg = `تحذير: انخفض عدد ${c.label} بنسبة ${pct}% مقارنة بآخر نسخة سحابية مكتملة (${c.oldVal} ← ${c.newVal})، تم إيقاف الرفع السحابي لحماية النسخة السليمة.`;
                this.dropAlert = msg;
                this.lastError = msg;
                this.notifyListeners();
                return {
                  success: false,
                  reason: 'suspicious_drop',
                  error: msg,
                };
              }
            }
          }
        }
      }

      this.dropAlert = null;

      // 4. Package JSON with inner SHA-256 checksum (compatible with snapshotService.validateBackup)
      const fullPackageDataChecksum = await computeDataChecksum(sanitizedData);
      const pkg: ExportBackupPackage = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion: APP_VERSION,
        timestamp: new Date().toISOString(),
        recordCounts: {
          products: totalProducts,
          invoices: totalInvoices,
          customers: totalCustomers,
          suppliers: Array.isArray(sanitizedData.suppliers) ? sanitizedData.suppliers.length : 0,
          purchases: Array.isArray(sanitizedData.purchases) ? sanitizedData.purchases.length : 0,
          cashMovements: Array.isArray(sanitizedData.cashMovements) ? sanitizedData.cashMovements.length : 0,
          expenses: Array.isArray(sanitizedData.expenses) ? sanitizedData.expenses.length : 0,
          auditLogs: Array.isArray(sanitizedData.auditLogs) ? sanitizedData.auditLogs.length : 0,
          stockAdjustments: Array.isArray(sanitizedData.stockAdjustments) ? sanitizedData.stockAdjustments.length : 0,
          users: Array.isArray(sanitizedData.users) ? sanitizedData.users.length : 0,
          parkedCarts: Array.isArray(sanitizedData.parkedCarts) ? sanitizedData.parkedCarts.length : 0,
          salesReturns: Array.isArray(sanitizedData.salesReturns) ? sanitizedData.salesReturns.length : 0,
        },
        checksum: fullPackageDataChecksum,
        data: sanitizedData,
      };

      const jsonStr = JSON.stringify(pkg);
      const { encoded, compressed } = await compressStringToBase64(jsonStr, {
        forceDisableCompression: options?.forceDisableCompression,
      });

      const payloadChecksum = await computeTextSha256Hex(encoded);
      const chunks = splitIntoChunks(encoded, CHUNK_MAX_CHARS);
      const sizeBytes = new TextEncoder().encode(encoded).length;

      const backupId = `backup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const backupRef = doc(
        db,
        'orgs',
        context.orgId,
        'branches',
        context.branchId,
        'backups',
        backupId
      );

      // 5a. Write metadata document with status: 'uploading'
      const metadataPayload: Record<string, any> = {
        status: 'uploading',
        createdAt: serverTimestamp(),
        sizeBytes,
        appVersion: APP_VERSION,
        totalChunks: chunks.length,
        totalProducts,
        totalInvoices,
        totalCustomers,
        checksum: payloadChecksum,
        dataChecksum: changeChecksum,
        compressed,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        trigger,
      };
      if (note && note.trim()) {
        metadataPayload.note = note.trim();
      }

      await this.runWithTransientRetry(
        () =>
          cloudBudgetService.budgetedSetDoc(backupRef, {
            id: backupId,
            metadata: metadataPayload,
          }),
        inlineMaxRetries
      );

      // 5b. Upload chunks in writeBatch commits <= 3 MB each
      let batch = writeBatch(db);
      let currentBatchBytes = 0;
      let currentBatchOps = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunkData = chunks[i];
        const estimatedBytes = chunkData.length + 256;

        if (currentBatchOps > 0 && (currentBatchBytes + estimatedBytes > MAX_BATCH_BYTES || currentBatchOps >= 400)) {
          const batchToCommit = batch;
          const opsCount = currentBatchOps;
          await this.runWithTransientRetry(
            () => cloudBudgetService.budgetedCommitBatch(batchToCommit, { writes: opsCount }),
            inlineMaxRetries
          );
          batch = writeBatch(db);
          currentBatchBytes = 0;
          currentBatchOps = 0;
        }

        const chunkRef = doc(
          db,
          'orgs',
          context.orgId,
          'branches',
          context.branchId,
          'backups',
          backupId,
          'chunks',
          String(i)
        );
        batch.set(chunkRef, {
          chunkIndex: i,
          data: chunkData,
        });
        currentBatchBytes += estimatedBytes;
        currentBatchOps++;
      }

      if (currentBatchOps > 0) {
        const finalBatch = batch;
        const opsCount = currentBatchOps;
        await this.runWithTransientRetry(
          () => cloudBudgetService.budgetedCommitBatch(finalBatch, { writes: opsCount }),
          inlineMaxRetries
        );
      }

      // 5c. Mark backup metadata complete
      await this.runWithTransientRetry(
        () =>
          cloudBudgetService.budgetedUpdateDoc(backupRef, {
            'metadata.status': 'complete',
          }),
        inlineMaxRetries
      );

      const summary: CloudBackupSummary = {
        id: backupId,
        createdAtIso: new Date().toISOString(),
        createdAtMs: Date.now(),
        sizeBytes,
        appVersion: APP_VERSION,
        totalChunks: chunks.length,
        totalProducts,
        totalInvoices,
        totalCustomers,
        checksum: payloadChecksum,
        dataChecksum: changeChecksum,
        compressed,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        trigger,
        note: note?.trim() || undefined,
        status: 'complete',
      };

      this.permissionPaused = false;
      if (this.permissionRetryTimer) {
        clearTimeout(this.permissionRetryTimer);
        this.permissionRetryTimer = null;
      }
      this.resetBackoff();
      this.lastError = null;
      this.saveLastSuccessfulBackup(summary, changeChecksum, todayCairo);

      // 6. Enforce retention: keep newest backups and clean up stale incomplete backups (> 24h)
      await this.enforceRetentionAndCleanup(
        context.orgId,
        context.branchId,
        CLOUD_BACKUP_KEEP_COUNT,
        backupId
      );

      storage.addAuditLog(
        'BACKUP',
        'نسخة احتياطية سحابية',
        'النسخ السحابي',
        backupId,
        `تم رفع نسخة احتياطية سحابية مقسمة إلى ${chunks.length} قطعة (${(sizeBytes / 1024).toFixed(1)} ك.ب${compressed ? ' مضغوطة' : ''})`
      );

      this.notifyListeners();
      return {
        success: true,
        backup: summary,
        message: 'تم رفع النسخة الاحتياطية السحابية وتأمينها بنجاح.',
      };
    } catch (err) {
      if (isBudgetExceededError(err)) {
        this.lastError = BUDGET_EXCEEDED_MESSAGE_AR;
        this.notifyListeners();
        return {
          success: false,
          skipped: true,
          reason: 'budget_paused',
          error: BUDGET_EXCEEDED_MESSAGE_AR,
        };
      }
      const translated = translateFirebaseError(err);
      if (isSixHourPauseError(err)) {
        this.activateSixHourPause();
      } else {
        this.recordFailureBackoff();
      }
      this.lastError = translated;
      this.notifyListeners();
      return {
        success: false,
        reason: isSixHourPauseError(err) ? 'permission_paused' : 'error',
        error: translated,
      };
    } finally {
      this.isUploading = false;
      this.notifyListeners();
    }
  }

  /**
   * Retention policy:
   * - Keeps the latest backup of each day for the last 7 days
   * - Keeps up to the latest 6 backups inside today (Cairo calendar date)
   * - NEVER deletes the newest complete backup globally (or protectedLatestId)
   * - Removes stale incomplete backups older than 24 hours
   */
  public async enforceRetentionAndCleanup(
    orgId: string,
    branchId: string,
    _keepCount: number = CLOUD_BACKUP_KEEP_COUNT,
    protectedLatestId?: string,
    todayCairoOverride?: string
  ): Promise<{ deletedCompleteCount: number; deletedStaleCount: number }> {
    if (!db) return { deletedCompleteCount: 0, deletedStaleCount: 0 };

    let deletedCompleteCount = 0;
    let deletedStaleCount = 0;

    try {
      const backupsCol = collection(db, 'orgs', orgId, 'branches', branchId, 'backups');
      const snap = await cloudBudgetService.budgetedGetDocs(backupsCol);

      const completeDocs: RetentionBackupCandidate[] = [];
      const staleIncompleteIds: string[] = [];
      const nowMs = Date.now();

      for (const docSnap of snap.docs) {
        const raw = docSnap.data() as { metadata?: BackupMetadata };
        const meta = raw?.metadata;
        if (!meta) continue;
        let createdAtMs = extractTimestampMs(meta.createdAt);
        if (createdAtMs === 0) {
          const idTsMatch = docSnap.id.match(/^backup_(\d+)_/);
          if (idTsMatch) {
            createdAtMs = Number(idTsMatch[1]) || 0;
          }
        }

        if (meta.status === 'complete') {
          completeDocs.push({
            id: docSnap.id,
            createdAtMs: createdAtMs > 0 ? createdAtMs : docSnap.id === protectedLatestId ? nowMs : 0,
          });
        } else if (createdAtMs > 0 && nowMs - createdAtMs > STALE_INCOMPLETE_BACKUP_MS) {
          staleIncompleteIds.push(docSnap.id);
        }
      }

      const todayCairo = todayCairoOverride || getCairoDateString(new Date());
      const { deleteIds } = selectBackupsToKeepAndDelete(
        completeDocs,
        todayCairo,
        protectedLatestId
      );

      for (const idToDelete of deleteIds) {
        try {
          await this.deleteBackupAndChunks(db, orgId, branchId, idToDelete);
          deletedCompleteCount++;
        } catch (err) {
          if (isBudgetExceededError(err)) break;
          if (isSixHourPauseError(err)) {
            this.activateSixHourPause();
            break;
          }
        }
      }

      for (const staleId of staleIncompleteIds) {
        try {
          await this.deleteBackupAndChunks(db, orgId, branchId, staleId);
          deletedStaleCount++;
        } catch (err) {
          if (isBudgetExceededError(err)) break;
          if (isSixHourPauseError(err)) {
            this.activateSixHourPause();
            break;
          }
        }
      }
    } catch {
      // Best effort cleanup
    }

    return { deletedCompleteCount, deletedStaleCount };
  }

  /**
   * Deletes a specific cloud backup (refuses to delete the latest complete backup).
   */
  public async deleteCloudBackup(backupId: string): Promise<{ success: boolean; error?: string }> {
    if (!isCloudConfigured || !db || !auth) {
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    const context = orgSyncService.getContext();
    if (!context) {
      return { success: false, error: 'لا يوجد ترخيص سارٍ.' };
    }
    if (orgSyncService.ensureSignedIn() !== 'ok') {
      return { success: false, error: 'يجب تسجيل دخول المحل أولاً.' };
    }

    try {
      const listRes = await this.listCompleteBackups();
      if (listRes.success && listRes.backups.length > 0 && listRes.backups[0].id === backupId) {
        return {
          success: false,
          error: 'لا يمكن حذف أحدث نسخة احتياطية مكتملة حمايةً لبيانات المحل.',
        };
      }

      await this.deleteBackupAndChunks(db, context.orgId, context.branchId, backupId);
      return { success: true };
    } catch (err) {
      return { success: false, error: translateFirebaseError(err) };
    }
  }

  /**
   * Downloads backup metadata and all chunks with progress, verifies SHA-256 checksum,
   * decompresses payload, and validates via snapshotService.validateBackup.
   */
  public async downloadAndValidateBackup(
    backupId: string,
    onProgress?: (progress: CloudRestoreDownloadProgress) => void
  ): Promise<CloudDownloadValidationResult> {
    if (!isCloudConfigured || !db || !auth) {
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    const context = orgSyncService.getContext();
    if (!context) {
      return { success: false, error: 'لا يوجد ترخيص سارٍ لتحديد المنشأة والفرع.' };
    }
    const authStatus = orgSyncService.ensureSignedIn();
    if (authStatus !== 'ok') {
      return {
        success: false,
        error:
          authStatus === 'wrong-account'
            ? 'الحساب المسجّل لا يطابق ترخيص الجهاز.'
            : 'يجب تسجيل دخول المحل للسحابة أولاً.',
      };
    }

    try {
      const backupRef = doc(
        db,
        'orgs',
        context.orgId,
        'branches',
        context.branchId,
        'backups',
        backupId
      );
      const backupSnap = await this.runWithTransientRetry(() =>
        cloudBudgetService.budgetedGetDoc(backupRef, { bypassBudget: true })
      );
      if (!backupSnap.exists()) {
        return { success: false, error: 'النسخة السحابية المطلوبة غير موجودة.' };
      }

      const raw = backupSnap.data() as { metadata?: BackupMetadata };
      const meta = raw?.metadata;
      if (!meta || meta.status !== 'complete') {
        return {
          success: false,
          error: 'هذه النسخة غير مكتملة الرفع ولا يمكن استعادتها.',
        };
      }

      const totalChunks = Number(meta.totalChunks) || 0;
      if (totalChunks <= 0) {
        return { success: false, error: 'بيانات عدد القطع في النسخة السحابية غير صالحة.' };
      }

      const chunkStrings: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const chunkRef = doc(
          db,
          'orgs',
          context.orgId,
          'branches',
          context.branchId,
          'backups',
          backupId,
          'chunks',
          String(i)
        );
        const chunkSnap = await this.runWithTransientRetry(() =>
          cloudBudgetService.budgetedGetDoc(chunkRef, { bypassBudget: true })
        );
        if (!chunkSnap.exists()) {
          return {
            success: false,
            error: `القطعة رقم (${i + 1} من ${totalChunks}) مفقودة من السحابة، النسخة غير مكتملة.`,
          };
        }
        const chunkData = (chunkSnap.data() as { data?: unknown })?.data;
        if (typeof chunkData !== 'string') {
          return {
            success: false,
            error: `تنسيق القطعة رقم (${i + 1}) غير صالح.`,
          };
        }
        chunkStrings.push(chunkData);

        if (onProgress) {
          onProgress({
            loadedChunks: i + 1,
            totalChunks,
            percent: Math.round(((i + 1) / totalChunks) * 100),
          });
        }
      }

      const reassembled = chunkStrings.join('');

      if (meta.checksum) {
        const computedPayloadChecksum = await computeTextSha256Hex(reassembled);
        if (computedPayloadChecksum !== meta.checksum) {
          return {
            success: false,
            error: 'فشل التحقق من التوقيع الرقمي (SHA-256) للنسخة السحابية. البيانات تالفة أو ناقصة.',
          };
        }
      }

      const jsonStr = await decompressBase64ToString(reassembled, Boolean(meta.compressed));
      const validation = await snapshotService.validateBackup(jsonStr);
      if (!validation.valid || !validation.validatedData || !validation.preview) {
        return {
          success: false,
          error: validation.error || 'فشل التحقق من بنية النسخة السحابية.',
        };
      }

      return {
        success: true,
        warning: validation.warning,
        backup: this.toSummary(backupSnap.id, meta),
        preview: validation.preview,
        validatedData: validation.validatedData,
      };
    } catch (err) {
      const translated = translateFirebaseError(err);
      return { success: false, error: translated };
    }
  }

  /**
   * Executes transactional restore via snapshotService and triggers post-restore
   * credential setup (`credentialsResetRequired = true`, clears active user).
   */
  public async executeCloudRestore(
    validatedData: Record<string, any>,
    sourceLabel: string = 'النسخة السحابية',
    options?: {
      simulateFailureInTransaction?: boolean;
      simulatePreRestoreFailure?: boolean;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const res = await snapshotService.restoreData(validatedData, sourceLabel, options);
    if (!res.success) {
      return res;
    }

    storage.setCredentialsResetRequired(true);
    storage.clearActiveUser();
    try {
      await storage.flush();
    } catch {}

    this.notifyListeners();
    return { success: true };
  }
}

export const cloudBackupService = new CloudBackupService();
