import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';

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

const mockLicCtrl = vi.hoisted(() => ({
  payload: null as any,
}));

vi.mock('./licenseService', () => ({
  licenseService: {
    getLicenseState: () => ({
      status: mockLicCtrl.payload ? 'valid' : 'unlicensed',
      daysRemaining: 30,
      payload: mockLicCtrl.payload,
      message: '',
      canOperate: true,
    }),
  },
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db: any, ...segs: string[]) => ({ path: segs.join('/') }),
  setDoc: vi.fn(async () => {}),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
  getDocs: vi.fn(async () => ({ docs: [] })),
}));

import {
  cloudBudgetService,
  CLOUD_BUDGET_STORAGE_KEY,
  BUDGET_EXCEEDED_MESSAGE_AR,
  BUDGET_WARNING_MESSAGE_AR,
  CloudBudgetExceededError,
  getBudgetCairoDateString,
  getMsUntilNextCairoMidnight,
  computeBackoffDelayMs,
  isSixHourPauseError,
} from './cloudBudgetService';
import { DEFAULT_CLOUD_BUDGET } from '../config/appConfig';

describe('cloudBudgetService — Persistent Circuit Breaker & Backoff Helpers', () => {
  beforeEach(async () => {
    localStorage.clear();
    mockLicCtrl.payload = null;
    await idb.kv.clear();
    await cloudBudgetService.resetForTesting();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await idb.kv.clear();
  });

  it('1) يطبّق الحدود الافتراضية ويسمح بتجاوزها من features.cloudBudget في الترخيص', () => {
    expect(cloudBudgetService.getActiveLimits()).toEqual(DEFAULT_CLOUD_BUDGET);

    mockLicCtrl.payload = {
      orgId: 'org-1',
      branchId: 'main',
      features: {
        cloudBudget: { writes: 2500, reads: 7000 },
      },
    };

    expect(cloudBudgetService.getActiveLimits()).toEqual({
      writes: 2500,
      reads: 7000,
      deletes: DEFAULT_CLOUD_BUDGET.deletes,
    });
  });

  it('2) يحفظ العداد في IndexedDB ويسترجعه لنفس اليوم بتوقيت القاهرة، ويصفّره إذا تغيّر اليوم', async () => {
    const todayCairo = getBudgetCairoDateString(new Date());
    cloudBudgetService.recordUsage('write', 120);
    cloudBudgetService.recordUsage('read', 340);
    cloudBudgetService.recordUsage('delete', 15);

    // Give fire-and-forget IDB put a tick to flush
    await new Promise(r => setTimeout(r, 30));
    const saved = await idb.kv.get(CLOUD_BUDGET_STORAGE_KEY);
    expect(saved?.value.dateStr).toBe(todayCairo);
    expect(saved?.value.writes).toBe(120);
    expect(saved?.value.reads).toBe(340);
    expect(saved?.value.deletes).toBe(15);

    // Reset in-memory only, keep IDB record -> init() restores exact counts for today
    cloudBudgetService.setUsageForTesting({
      dateStr: todayCairo,
      writes: 0,
      reads: 0,
      deletes: 0,
    });
    // Re-put yesterday's counts first for today, then re-init
    await idb.kv.put({
      key: CLOUD_BUDGET_STORAGE_KEY,
      value: { dateStr: todayCairo, writes: 120, reads: 340, deletes: 15, lastUpdatedMs: Date.now() },
      updatedAt: Date.now(),
    });
    await cloudBudgetService.init();
    expect(cloudBudgetService.getUsage().writes).toBe(120);
    expect(cloudBudgetService.getUsage().reads).toBe(340);
    expect(cloudBudgetService.getUsage().deletes).toBe(15);

    // Stale date in IDB -> init() resets to 0 for today
    await idb.kv.put({
      key: CLOUD_BUDGET_STORAGE_KEY,
      value: { dateStr: '2020-01-01', writes: 999, reads: 999, deletes: 99, lastUpdatedMs: 100 },
      updatedAt: Date.now(),
    });
    await cloudBudgetService.init();
    expect(cloudBudgetService.getUsage().writes).toBe(0);
    expect(cloudBudgetService.getUsage().reads).toBe(0);
    expect(cloudBudgetService.getUsage().deletes).toBe(0);
  });

  it('3) يُظهر تحذيراً أصفر عند بلوغ 90% من أي حد دون إيقاف المزامنة', () => {
    // 90% of 1500 writes = 1350
    cloudBudgetService.setUsageForTesting({ writes: 1349, reads: 0, deletes: 0 });
    expect(cloudBudgetService.isWarning90()).toBe(false);
    expect(cloudBudgetService.isExceeded()).toBe(false);

    cloudBudgetService.recordUsage('write', 1); // reaches 1350 (90%)
    const status = cloudBudgetService.getStatus();
    expect(status.isWarning90).toBe(true);
    expect(status.isExceeded).toBe(false);
    expect(status.warningMessage).toBe(BUDGET_WARNING_MESSAGE_AR);
    expect(status.counterLabel).toBe('عمليات اليوم: كتابات 1350/1500، قراءات 0/4000');
    expect(cloudBudgetService.canExecute('write', 1)).toBe(true);
  });

  it('4) يوقف العمليات التلقائية عند بلوغ 100% برسالة عربية مع استمرار bypassBudget لاستعادة النسخة السحابية', async () => {
    cloudBudgetService.setUsageForTesting({
      writes: DEFAULT_CLOUD_BUDGET.writes,
      reads: 50,
      deletes: 0,
    });

    const status = cloudBudgetService.getStatus();
    expect(status.isExceeded).toBe(true);
    expect(status.isWarning90).toBe(false);
    expect(status.pausedMessage).toBe(BUDGET_EXCEEDED_MESSAGE_AR);

    expect(cloudBudgetService.canExecute('write', 1)).toBe(false);
    expect(cloudBudgetService.canExecute('read', 1)).toBe(false);
    await expect(
      cloudBudgetService.budgetedSetDoc({ path: 'orgs/o/branches/b/dailySummaries/d' } as any, { a: 1 })
    ).rejects.toThrow(CloudBudgetExceededError);

    // Manual restore / explicit bypass still works cleanly
    expect(cloudBudgetService.canExecute('read', 1, { bypassBudget: true })).toBe(true);
    const snap = await cloudBudgetService.budgetedGetDoc(
      { path: 'orgs/o/branches/b/backups/b1' } as any,
      { bypassBudget: true }
    );
    expect(snap.exists()).toBe(false);
  });

  it('5) يُعاد تصفير العداد تلقائياً عند منتصف الليل بتوقيت القاهرة (Africa/Cairo)', () => {
    vi.useFakeTimers();
    // 2026-11-18T21:59:00Z == 2026-11-18 23:59:00 Africa/Cairo (UTC+2 in November)
    vi.setSystemTime(new Date('2026-11-18T21:59:00Z'));

    cloudBudgetService.setUsageForTesting({
      dateStr: getBudgetCairoDateString(new Date()),
      writes: DEFAULT_CLOUD_BUDGET.writes,
      reads: 100,
      deletes: 0,
    });
    expect(cloudBudgetService.getUsage().dateStr).toBe('2026-11-18');
    expect(cloudBudgetService.isExceeded()).toBe(true);

    const msUntilMidnight = getMsUntilNextCairoMidnight(new Date());
    expect(msUntilMidnight).toBeGreaterThanOrEqual(60_000);
    expect(msUntilMidnight).toBeLessThanOrEqual(70_000);

    // Advance 2 minutes across Cairo midnight -> 2026-11-19 00:01:00 Africa/Cairo
    vi.advanceTimersByTime(120_000);

    const rolled = cloudBudgetService.getUsage();
    expect(rolled.dateStr).toBe('2026-11-19');
    expect(rolled.writes).toBe(0);
    expect(rolled.reads).toBe(0);
    expect(cloudBudgetService.isExceeded()).toBe(false);
  });

  it('6) دوال تصنيف الأخطاء والـ exponential backoff (30s..30m ±15% jitter)', () => {
    expect(isSixHourPauseError({ code: 'permission-denied' })).toBe(true);
    expect(isSixHourPauseError({ code: 'firestore/resource-exhausted' })).toBe(true);
    expect(isSixHourPauseError({ code: 'unavailable' })).toBe(false);

    // With midpoint random=0.5, multiplier = 1.0 -> exact step sequence: 30s, 1m, 2m, 5m, 15m, 30m
    expect(computeBackoffDelayMs(0, 0.5)).toBe(30_000);
    expect(computeBackoffDelayMs(1, 0.5)).toBe(60_000);
    expect(computeBackoffDelayMs(2, 0.5)).toBe(120_000);
    expect(computeBackoffDelayMs(3, 0.5)).toBe(300_000);
    expect(computeBackoffDelayMs(4, 0.5)).toBe(900_000);
    expect(computeBackoffDelayMs(5, 0.5)).toBe(1_800_000);
    expect(computeBackoffDelayMs(10, 0.5)).toBe(1_800_000); // capped at 30m

    // ±15% jitter bounds for step 0 (30,000ms -> [25500, 34500])
    expect(computeBackoffDelayMs(0, 0)).toBe(25_500);
    expect(computeBackoffDelayMs(0, 1)).toBe(34_500);
  });
});
