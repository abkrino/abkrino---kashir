import {
  doc as _unusedDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  DocumentReference,
  DocumentData,
  Query,
  CollectionReference,
  DocumentSnapshot,
  QuerySnapshot,
  WriteBatch,
} from 'firebase/firestore';
import { DEFAULT_CLOUD_BUDGET, CloudBudgetLimits } from '../config/appConfig';
import { licenseService } from './licenseService';
import { idb } from './idbStore';

export const CLOUD_BUDGET_STORAGE_KEY = 'sm_cloud_budget_usage_v1';

export const BUDGET_EXCEEDED_MESSAGE_AR =
  'تم إيقاف المزامنة السحابية اليوم لتجاوز الحد اليومي، ستُستأنف غداً';

export const BUDGET_WARNING_MESSAGE_AR =
  'تحذير: اقتربت عمليات المزامنة السحابية اليوم من الحد اليومي المسموح (90% فأكثر).';

export const SIX_HOUR_PAUSE_MS = 6 * 60 * 60 * 1000;

export const ERROR_BACKOFF_STEPS_MS = [
  30 * 1000,       // 30s
  60 * 1000,       // 1m
  2 * 60 * 1000,   // 2m
  5 * 60 * 1000,   // 5m
  15 * 60 * 1000,  // 15m
  30 * 60 * 1000,  // 30m (max)
] as const;

export function computeBackoffDelayMs(stepIndex: number, randomValue: number = Math.random()): number {
  const idx = Math.max(0, Math.min(stepIndex, ERROR_BACKOFF_STEPS_MS.length - 1));
  const baseMs = ERROR_BACKOFF_STEPS_MS[idx];
  const clampedRandom = Math.max(0, Math.min(1, randomValue));
  // ±15% jitter
  const multiplier = 0.85 + clampedRandom * 0.30;
  return Math.round(baseMs * multiplier);
}

export function isSixHourPauseError(err: unknown): boolean {
  const obj = (err && typeof err === 'object' ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof obj.code === 'string' ? obj.code.toLowerCase() : '';
  const msg = typeof obj.message === 'string' ? obj.message.toLowerCase() : String(err ?? '').toLowerCase();
  return (
    code.includes('permission-denied') ||
    code.includes('resource-exhausted') ||
    msg.includes('permission-denied') ||
    msg.includes('missing or insufficient permissions') ||
    msg.includes('resource-exhausted') ||
    msg.includes('quota exceeded')
  );
}

export class CloudBudgetExceededError extends Error {
  public readonly code = 'budget-exceeded';
  constructor(message: string = BUDGET_EXCEEDED_MESSAGE_AR) {
    super(message);
    this.name = 'CloudBudgetExceededError';
  }
}

export function isBudgetExceededError(err: unknown): boolean {
  if (err instanceof CloudBudgetExceededError) return true;
  const obj = (err && typeof err === 'object' ? err : {}) as { code?: unknown; message?: unknown };
  const code = typeof obj.code === 'string' ? obj.code.toLowerCase() : '';
  return code === 'budget-exceeded';
}

const CAIRO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const CAIRO_TIME_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Cairo',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function getBudgetCairoDateString(date: Date = new Date()): string {
  return CAIRO_DATE_FORMATTER.format(date);
}

/**
 * Calculates milliseconds remaining until the next Cairo midnight (00:00:00 Africa/Cairo) + 1.5s buffer.
 */
export function getMsUntilNextCairoMidnight(now: Date = new Date()): number {
  const parts = CAIRO_TIME_PARTS_FORMATTER.formatToParts(now);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = Number(p.value);
    }
  }
  const hour = (map.hour || 0) % 24;
  const minute = map.minute || 0;
  const second = map.second || 0;
  const elapsedSeconds = hour * 3600 + minute * 60 + second;
  const remainingMs = Math.max(1000, (86400 - elapsedSeconds) * 1000 - now.getMilliseconds());
  return remainingMs + 1500;
}

export interface CloudBudgetUsageRecord {
  dateStr: string;
  writes: number;
  reads: number;
  deletes: number;
  lastUpdatedMs: number;
}

export interface CloudBudgetStatus {
  dateStr: string;
  writes: number;
  reads: number;
  deletes: number;
  limits: CloudBudgetLimits;
  isWarning90: boolean;
  isExceeded: boolean;
  warningMessage: string | null;
  pausedMessage: string | null;
  counterLabel: string;
}

export type BudgetOperationKind = 'write' | 'read' | 'delete';

export interface BudgetCallOptions {
  bypassBudget?: boolean;
}

function positiveLimitOrDefault(val: unknown, fallback: number): number {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

class CloudBudgetService {
  private usage: CloudBudgetUsageRecord = {
    dateStr: getBudgetCairoDateString(new Date()),
    writes: 0,
    reads: 0,
    deletes: 0,
    lastUpdatedMs: Date.now(),
  };
  private isLoaded: boolean = false;
  private listeners: (() => void)[] = [];

  public async init(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      this.isLoaded = true;
      return;
    }
    try {
      const stored = await idb.kv.get(CLOUD_BUDGET_STORAGE_KEY);
      const todayCairo = getBudgetCairoDateString(new Date());
      if (stored && stored.value && typeof stored.value === 'object') {
        const rec = stored.value as Partial<CloudBudgetUsageRecord>;
        if (rec.dateStr === todayCairo) {
          this.usage = {
            dateStr: todayCairo,
            writes: Math.max(this.usage.writes, Number(rec.writes) || 0),
            reads: Math.max(this.usage.reads, Number(rec.reads) || 0),
            deletes: Math.max(this.usage.deletes, Number(rec.deletes) || 0),
            lastUpdatedMs: Number(rec.lastUpdatedMs) || Date.now(),
          };
        } else {
          this.usage = {
            dateStr: todayCairo,
            writes: 0,
            reads: 0,
            deletes: 0,
            lastUpdatedMs: Date.now(),
          };
          this.persistAsync();
        }
      }
    } catch {
      // ignore IDB read failure
    } finally {
      this.isLoaded = true;
      this.notifyListeners();
    }
  }

  private persistAsync(): void {
    if (typeof indexedDB === 'undefined') return;
    idb.kv
      .put({
        key: CLOUD_BUDGET_STORAGE_KEY,
        value: { ...this.usage },
        updatedAt: Date.now(),
      })
      .catch(() => {});
  }

  private rolloverIfNewCairoDay(): boolean {
    const todayCairo = getBudgetCairoDateString(new Date());
    if (this.usage.dateStr !== todayCairo) {
      this.usage = {
        dateStr: todayCairo,
        writes: 0,
        reads: 0,
        deletes: 0,
        lastUpdatedMs: Date.now(),
      };
      this.persistAsync();
      this.notifyListeners();
      return true;
    }
    return false;
  }

  public getActiveLimits(): CloudBudgetLimits {
    const licState = licenseService.getLicenseState();
    const override = licState?.payload?.features?.cloudBudget;
    return {
      writes: positiveLimitOrDefault(override?.writes, DEFAULT_CLOUD_BUDGET.writes),
      reads: positiveLimitOrDefault(override?.reads, DEFAULT_CLOUD_BUDGET.reads),
      deletes: positiveLimitOrDefault(override?.deletes, DEFAULT_CLOUD_BUDGET.deletes),
    };
  }

  public getUsage(): CloudBudgetUsageRecord {
    this.rolloverIfNewCairoDay();
    return { ...this.usage };
  }

  public isWarning90(): boolean {
    const usage = this.getUsage();
    const limits = this.getActiveLimits();
    if (this.isExceeded()) return false;
    return (
      usage.writes >= limits.writes * 0.9 ||
      usage.reads >= limits.reads * 0.9 ||
      usage.deletes >= limits.deletes * 0.9
    );
  }

  public isExceeded(): boolean {
    const usage = this.getUsage();
    const limits = this.getActiveLimits();
    return (
      usage.writes >= limits.writes ||
      usage.reads >= limits.reads ||
      usage.deletes >= limits.deletes
    );
  }

  public getStatus(): CloudBudgetStatus {
    const usage = this.getUsage();
    const limits = this.getActiveLimits();
    const exceeded =
      usage.writes >= limits.writes ||
      usage.reads >= limits.reads ||
      usage.deletes >= limits.deletes;
    const warning90 =
      !exceeded &&
      (usage.writes >= limits.writes * 0.9 ||
        usage.reads >= limits.reads * 0.9 ||
        usage.deletes >= limits.deletes * 0.9);

    return {
      dateStr: usage.dateStr,
      writes: usage.writes,
      reads: usage.reads,
      deletes: usage.deletes,
      limits,
      isWarning90: warning90,
      isExceeded: exceeded,
      warningMessage: warning90 ? BUDGET_WARNING_MESSAGE_AR : null,
      pausedMessage: exceeded ? BUDGET_EXCEEDED_MESSAGE_AR : null,
      counterLabel: `عمليات اليوم: كتابات ${usage.writes}/${limits.writes}، قراءات ${usage.reads}/${limits.reads}`,
    };
  }

  public canExecute(kind: BudgetOperationKind, count: number = 1, options?: BudgetCallOptions): boolean {
    this.rolloverIfNewCairoDay();
    if (options?.bypassBudget) return true;
    const limits = this.getActiveLimits();
    if (
      this.usage.writes >= limits.writes ||
      this.usage.reads >= limits.reads ||
      this.usage.deletes >= limits.deletes
    ) {
      return false;
    }
    if (kind === 'write') return this.usage.writes + count <= limits.writes;
    if (kind === 'read') return this.usage.reads + count <= limits.reads;
    return this.usage.deletes + count <= limits.deletes;
  }

  public assertCanExecute(kind: BudgetOperationKind, count: number = 1, options?: BudgetCallOptions): void {
    if (!this.canExecute(kind, count, options)) {
      throw new CloudBudgetExceededError(BUDGET_EXCEEDED_MESSAGE_AR);
    }
  }

  public recordUsage(kind: BudgetOperationKind, count: number = 1): void {
    if (count <= 0) return;
    this.rolloverIfNewCairoDay();
    if (kind === 'write') this.usage.writes += count;
    else if (kind === 'read') this.usage.reads += count;
    else if (kind === 'delete') this.usage.deletes += count;
    this.usage.lastUpdatedMs = Date.now();
    this.persistAsync();
    this.notifyListeners();
  }

  // -------------------------------------------------------------------------
  // Tracked Firestore SDK Wrappers
  // -------------------------------------------------------------------------
  public async budgetedSetDoc<T extends DocumentData>(
    ref: DocumentReference<T>,
    data: T,
    options?: BudgetCallOptions
  ): Promise<void> {
    this.assertCanExecute('write', 1, options);
    this.recordUsage('write', 1);
    return setDoc(ref, data);
  }

  public async budgetedUpdateDoc<T extends DocumentData>(
    ref: DocumentReference<T>,
    data: DocumentData,
    options?: BudgetCallOptions
  ): Promise<void> {
    this.assertCanExecute('write', 1, options);
    this.recordUsage('write', 1);
    return updateDoc(ref, data);
  }

  public async budgetedDeleteDoc<T extends DocumentData>(
    ref: DocumentReference<T>,
    options?: BudgetCallOptions
  ): Promise<void> {
    this.assertCanExecute('delete', 1, options);
    this.recordUsage('delete', 1);
    return deleteDoc(ref);
  }

  public async budgetedGetDoc<T extends DocumentData>(
    ref: DocumentReference<T>,
    options?: BudgetCallOptions
  ): Promise<DocumentSnapshot<T>> {
    this.assertCanExecute('read', 1, options);
    this.recordUsage('read', 1);
    return getDoc(ref);
  }

  public async budgetedGetDocs<T extends DocumentData>(
    colOrQuery: CollectionReference<T> | Query<T>,
    options?: BudgetCallOptions
  ): Promise<QuerySnapshot<T>> {
    this.assertCanExecute('read', 1, options);
    const snap = await getDocs(colOrQuery);
    this.recordUsage('read', Math.max(1, snap.docs.length));
    return snap;
  }

  public async budgetedCommitBatch(
    batch: WriteBatch,
    counts: { writes?: number; deletes?: number },
    options?: BudgetCallOptions
  ): Promise<void> {
    const writes = counts.writes || 0;
    const deletes = counts.deletes || 0;
    if (writes > 0) this.assertCanExecute('write', writes, options);
    if (deletes > 0) this.assertCanExecute('delete', deletes, options);
    if (writes > 0) this.recordUsage('write', writes);
    if (deletes > 0) this.recordUsage('delete', deletes);
    return batch.commit();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  public isStoreLoaded(): boolean {
    return this.isLoaded;
  }

  public setUsageForTesting(usage: Partial<CloudBudgetUsageRecord>): void {
    this.usage = {
      dateStr: usage.dateStr ?? getBudgetCairoDateString(new Date()),
      writes: usage.writes ?? 0,
      reads: usage.reads ?? 0,
      deletes: usage.deletes ?? 0,
      lastUpdatedMs: usage.lastUpdatedMs ?? Date.now(),
    };
    this.persistAsync();
    this.notifyListeners();
  }

  public async resetForTesting(usage?: Partial<CloudBudgetUsageRecord>): Promise<void> {
    this.usage = {
      dateStr: usage?.dateStr ?? getBudgetCairoDateString(new Date()),
      writes: usage?.writes ?? 0,
      reads: usage?.reads ?? 0,
      deletes: usage?.deletes ?? 0,
      lastUpdatedMs: usage?.lastUpdatedMs ?? Date.now(),
    };
    this.isLoaded = true;
    if (typeof indexedDB !== 'undefined') {
      try {
        await idb.kv.delete(CLOUD_BUDGET_STORAGE_KEY);
      } catch {}
    }
    this.notifyListeners();
  }
}

export const cloudBudgetService = new CloudBudgetService();
