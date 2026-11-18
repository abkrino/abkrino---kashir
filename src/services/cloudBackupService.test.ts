import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { authSecurityService, userHasCredentials } from './authSecurityService';

// Ensure localStorage and navigator.onLine work cleanly in Vitest Node environment
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
// In-Memory Firestore Mock State (hoisted cleanly for vi.mock factories)
// ---------------------------------------------------------------------------
const firestoreMockState = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const operationLog: { op: string; path: string }[] = [];
  const batchCommitSizes: number[] = [];
  let transientSetDocFailures = 0;
  let forcePermissionDeniedOnSetDoc = false;
  let nowTimestampMs = 1_760_000_000_000;

  const deepClone = <T>(val: T): T => {
    if (val === undefined) return undefined as T;
    return JSON.parse(JSON.stringify(val));
  };

  const resolveSentinels = (val: any): any => {
    if (val && typeof val === 'object') {
      if (val.__sentinel === 'serverTimestamp') {
        const ms = nowTimestampMs++;
        return { __timestampMs: ms };
      }
      if (Array.isArray(val)) {
        return val.map(resolveSentinels);
      }
      const out: Record<string, any> = {};
      for (const k of Object.keys(val)) {
        out[k] = resolveSentinels(val[k]);
      }
      return out;
    }
    return val;
  };

  const wrapTimestamp = (val: any): any => {
    if (val && typeof val === 'object') {
      if (typeof val.__timestampMs === 'number') {
        const ms = val.__timestampMs;
        return {
          toMillis: () => ms,
          toDate: () => new Date(ms),
          seconds: Math.floor(ms / 1000),
        };
      }
      if (Array.isArray(val)) return val.map(wrapTimestamp);
      const out: Record<string, any> = {};
      for (const k of Object.keys(val)) {
        out[k] = wrapTimestamp(val[k]);
      }
      return out;
    }
    return val;
  };

  const setNestedField = (obj: Record<string, any>, dottedKey: string, value: any) => {
    const parts = dottedKey.split('.');
    let cursor: Record<string, any> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!cursor[part] || typeof cursor[part] !== 'object') {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  };

  return {
    docs,
    operationLog,
    batchCommitSizes,
    get transientSetDocFailures() {
      return transientSetDocFailures;
    },
    set transientSetDocFailures(v: number) {
      transientSetDocFailures = v;
    },
    get forcePermissionDeniedOnSetDoc() {
      return forcePermissionDeniedOnSetDoc;
    },
    set forcePermissionDeniedOnSetDoc(v: boolean) {
      forcePermissionDeniedOnSetDoc = v;
    },
    reset: () => {
      docs.clear();
      operationLog.length = 0;
      batchCommitSizes.length = 0;
      transientSetDocFailures = 0;
      forcePermissionDeniedOnSetDoc = false;
      nowTimestampMs = 1_760_000_000_000;
    },
    deepClone,
    resolveSentinels,
    wrapTimestamp,
    setNestedField,
  };
});

vi.mock('firebase/firestore', () => {
  return {
    doc: (_db: any, ...segments: string[]) => ({
      path: segments.join('/'),
      id: segments[segments.length - 1],
    }),
    collection: (_db: any, ...segments: string[]) => ({
      path: segments.join('/'),
    }),
    serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
    setDoc: vi.fn(async (ref: { path: string }, data: any) => {
      firestoreMockState.operationLog.push({ op: 'setDoc', path: ref.path });
      if (firestoreMockState.forcePermissionDeniedOnSetDoc) {
        const err = new Error('Missing or insufficient permissions.') as Error & { code: string };
        err.code = 'permission-denied';
        throw err;
      }
      if (firestoreMockState.transientSetDocFailures > 0) {
        firestoreMockState.transientSetDocFailures--;
        const err = new Error('The service is currently unavailable.') as Error & { code: string };
        err.code = 'unavailable';
        throw err;
      }
      const stored = firestoreMockState.resolveSentinels(firestoreMockState.deepClone(data));
      firestoreMockState.docs.set(ref.path, stored);
    }),
    updateDoc: vi.fn(async (ref: { path: string }, updates: Record<string, any>) => {
      firestoreMockState.operationLog.push({ op: 'updateDoc', path: ref.path });
      const existing = firestoreMockState.docs.get(ref.path);
      if (!existing) {
        const err = new Error('No document to update') as Error & { code: string };
        err.code = 'not-found';
        throw err;
      }
      const next = firestoreMockState.deepClone(existing);
      for (const key of Object.keys(updates)) {
        firestoreMockState.setNestedField(next, key, firestoreMockState.resolveSentinels(updates[key]));
      }
      firestoreMockState.docs.set(ref.path, next);
    }),
    getDoc: vi.fn(async (ref: { path: string; id: string }) => {
      firestoreMockState.operationLog.push({ op: 'getDoc', path: ref.path });
      const raw = firestoreMockState.docs.get(ref.path);
      return {
        id: ref.id,
        ref,
        exists: () => raw !== undefined,
        data: () => (raw !== undefined ? firestoreMockState.wrapTimestamp(firestoreMockState.deepClone(raw)) : undefined),
      };
    }),
    getDocs: vi.fn(async (colRef: { path: string }) => {
      firestoreMockState.operationLog.push({ op: 'getDocs', path: colRef.path });
      const prefix = colRef.path + '/';
      const docs: any[] = [];
      for (const [docPath, raw] of firestoreMockState.docs.entries()) {
        if (!docPath.startsWith(prefix)) continue;
        const remainder = docPath.slice(prefix.length);
        if (remainder.includes('/')) continue; // Direct children only
        const ref = { path: docPath, id: remainder };
        docs.push({
          id: remainder,
          ref,
          data: () => firestoreMockState.wrapTimestamp(firestoreMockState.deepClone(raw)),
        });
      }
      return { docs };
    }),
    deleteDoc: vi.fn(async (ref: { path: string }) => {
      firestoreMockState.operationLog.push({ op: 'deleteDoc', path: ref.path });
      firestoreMockState.docs.delete(ref.path);
    }),
    writeBatch: vi.fn(() => {
      const ops: Array<
        | { type: 'set'; ref: { path: string }; data: any }
        | { type: 'delete'; ref: { path: string } }
      > = [];
      return {
        set: (ref: { path: string }, data: any) => {
          ops.push({ type: 'set', ref, data });
        },
        delete: (ref: { path: string }) => {
          ops.push({ type: 'delete', ref });
        },
        commit: async () => {
          let totalBytes = 0;
          for (const op of ops) {
            if (op.type === 'set') {
              const payload = op.data?.data;
              if (typeof payload === 'string') {
                totalBytes += payload.length + 256;
              } else {
                totalBytes += JSON.stringify(op.data).length;
              }
              firestoreMockState.operationLog.push({ op: 'batchSet', path: op.ref.path });
              firestoreMockState.docs.set(
                op.ref.path,
                firestoreMockState.resolveSentinels(firestoreMockState.deepClone(op.data))
              );
            } else {
              firestoreMockState.operationLog.push({ op: 'batchDelete', path: op.ref.path });
              firestoreMockState.docs.delete(op.ref.path);
            }
          }
          firestoreMockState.batchCommitSizes.push(totalBytes);
        },
      };
    }),
  };
});

vi.mock('./cloudService', () => ({
  db: { __mockFirestore: true },
  auth: { currentUser: { uid: 'org_test_1', email: 'owner@store.test' } },
  isCloudConfigured: true,
}));

const orgSyncMockState = vi.hoisted(() => ({
  context: { orgId: 'org_test_1', branchId: 'main', mode: 'offline' as const } as {
    orgId: string;
    branchId: string;
    mode: 'offline' | 'online';
  } | null,
  signInStatus: 'ok' as 'ok' | 'not-signed-in' | 'wrong-account',
}));

vi.mock('./orgSyncService', () => ({
  orgSyncService: {
    getContext: vi.fn(() => orgSyncMockState.context),
    ensureSignedIn: vi.fn(() => orgSyncMockState.signInStatus),
  },
}));

import {
  cloudBackupService,
  stripUserCredentialsFromData,
  compressStringToBase64,
  decompressBase64ToString,
  splitIntoChunks,
  selectBackupsToKeepAndDelete,
  CHUNK_MAX_CHARS,
  MAX_BATCH_BYTES,
  PERIODIC_BACKUP_INTERVAL_MS,
  STALE_INCOMPLETE_BACKUP_MS,
} from './cloudBackupService';
import { snapshotService } from './snapshotService';

describe('Cloud Backup Service — Chunked Gzip Backup, Retention, Integrity & Credential-Free Restore', () => {
  beforeEach(async () => {
    localStorage.clear();
    firestoreMockState.reset();
    orgSyncMockState.context = { orgId: 'org_test_1', branchId: 'main', mode: 'offline' };
    orgSyncMockState.signInStatus = 'ok';
    cloudBackupService.resetInternalStateForTesting();
    cloudBackupService.setRetryDelayMsForTesting(0);

    if (typeof globalThis.navigator !== 'undefined') {
      vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
    }

    await idb.kv.clear();
    await idb.snapshots.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
    await storage.init();
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // 1. Credential stripping without mutating local storage
  it('(1) يستبعد كافة بيانات الدخول (pinHash, pinSalt, pinCode, mustChangePin) من المستخدمين دون المساس ببيانات التخزين المحلي', async () => {
    storage.loadDemoData();

    const adminUser = await authSecurityService.setupInitialAdmin({
      fullName: 'مدير المتجر',
      username: 'storeadmin',
      password: 'StrongPassword#2026',
    });

    const cashierRes = await authSecurityService.saveCashier(adminUser, {
      fullName: 'كاشير أول',
      username: 'cashier1',
      role: 'SALES',
      pin: '4829',
      isActive: true,
      permissions: {
        canEditPrice: false,
        canGiveDiscount: false,
        canSellNegativeStock: false,
        canDeleteInvoice: false,
        canEditInvoice: false,
        canViewProfits: false,
        canManageProducts: false,
        canManagePurchases: false,
        canManageCash: false,
        canWithdrawNegativeCash: false,
        canProcessReturns: false,
      },
    });
    expect(cashierRes.success).toBe(true);

    // Also test direct pure helper with legacy pinCode + passwordHash fields
    const rawBusiness = snapshotService.getCurrentBusinessData();
    rawBusiness.users = [
      ...rawBusiness.users,
      {
        id: 'legacy-u',
        fullName: 'مستخدم قديم',
        username: 'legacy',
        role: 'SALES',
        isActive: true,
        pinCode: '9182',
        pinHash: 'abcd',
        pinSalt: 'ef01',
        mustChangePin: true,
        passwordHash: 'secret-hash',
      },
    ];
    const stripped = stripUserCredentialsFromData(rawBusiness);

    for (const u of stripped.users as Record<string, any>[]) {
      expect(u.pinHash).toBeUndefined();
      expect(u.pinSalt).toBeUndefined();
      expect(u.pinCode).toBeUndefined();
      expect(u.mustChangePin).toBeUndefined();
      expect(u.passwordHash).toBeUndefined();
    }

    // Now upload a real backup and inspect what landed in Firestore chunks
    const uploadRes = await cloudBackupService.createAndUploadBackup('manual', 'اختبار تجريد كلمات المرور');
    expect(uploadRes.success).toBe(true);
    expect(uploadRes.backup).toBeDefined();

    const backupId = uploadRes.backup!.id;
    const chunkZeroPath = `orgs/org_test_1/branches/main/backups/${backupId}/chunks/0`;
    const chunkZeroDoc = firestoreMockState.docs.get(chunkZeroPath);
    expect(chunkZeroDoc).toBeDefined();

    const decodedJson = await decompressBase64ToString(
      chunkZeroDoc.data,
      Boolean(uploadRes.backup!.compressed)
    );
    const parsedPkg = JSON.parse(decodedJson);
    expect(Array.isArray(parsedPkg.data.users)).toBe(true);
    expect(parsedPkg.data.users.length).toBeGreaterThanOrEqual(2);
    for (const cloudUser of parsedPkg.data.users as Record<string, any>[]) {
      expect(cloudUser.pinHash).toBeUndefined();
      expect(cloudUser.pinSalt).toBeUndefined();
      expect(cloudUser.pinCode).toBeUndefined();
      expect(cloudUser.mustChangePin).toBeUndefined();
    }

    // Ensure local storage users were NOT mutated!
    const localAdmin = storage.getUsers().find(u => u.id === adminUser.id);
    expect(localAdmin?.pinHash).toBeTruthy();
    expect(localAdmin?.pinSalt).toBeTruthy();
  });

  // 2. Gzip Compression + Base64 + Splitting (<= 700,000 chars per chunk) + Multi-batch <= 3 MB
  it('(2) ضغط gzip بـ CompressionStream + تقطيع <= 700,000 حرف لكل قطعة + دعم تقسيم الدفعات <= 3 ميجابايت وفك الضغط الصحيح', async () => {
    const arabicSample = JSON.stringify({
      store: 'سوبر ماركت البركة — فرع المعادي',
      items: Array.from({ length: 500 }, (_, i) => ({
        id: `p_${i}`,
        name: `صنف عربي تجريبي رقم ${i} — زيت طعام ممتاز 1 لتر`,
        price: 75.5 + i,
      })),
    });

    // Test gzip path
    const gzipped = await compressStringToBase64(arabicSample);
    expect(gzipped.compressed).toBe(true);
    expect(gzipped.encoded.length).toBeLessThan(arabicSample.length);
    const roundtripGzip = await decompressBase64ToString(gzipped.encoded, gzipped.compressed);
    expect(roundtripGzip).toBe(arabicSample);

    // Test uncompressed fallback path (for older browsers without CompressionStream)
    const fallback = await compressStringToBase64(arabicSample, { forceDisableCompression: true });
    expect(fallback.compressed).toBe(false);
    const roundtripFallback = await decompressBase64ToString(fallback.encoded, fallback.compressed);
    expect(roundtripFallback).toBe(arabicSample);

    // Test chunk splitting <= 700,000 chars
    const bigString = 'A'.repeat(1_550_000);
    const parts = splitIntoChunks(bigString, CHUNK_MAX_CHARS);
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBe(700_000);
    expect(parts[1].length).toBe(700_000);
    expect(parts[2].length).toBe(150_000);
    expect(parts.join('')).toBe(bigString);

    // Test end-to-end upload with uncompressed > 3.2 MB payload to trigger multi-chunk + multi-batch commits
    storage.loadDemoData();
    const existingProducts = storage.getProducts();
    const baseProduct = existingProducts[0];
    // Generate ~3.5 MB of UTF-8 JSON (high-entropy numeric/latin payload when uncompressed)
    const bigProducts = Array.from({ length: 1800 }, (_, idx) => ({
      ...baseProduct,
      id: `bulk_prod_${idx}`,
      name: `منتج ضخْم لاختبار التقطيع والدفعات ${idx}`,
      barcode: `622000${String(idx).padStart(7, '0')}`,
      description: `REF-${idx}-` + 'X9K2M7P4Q8'.repeat(150),
    }));
    storage.setItem(STORAGE_KEYS.PRODUCTS, bigProducts);

    const res = await cloudBackupService.createAndUploadBackup(
      'manual',
      'نسخة كبيرة مقسمة',
      { forceDisableCompression: true, forceIgnoreDrop: true }
    );
    expect(res.success).toBe(true);
    expect(res.backup!.totalChunks).toBeGreaterThanOrEqual(5);

    // Verify every chunk is strictly <= 700,000 chars
    for (let i = 0; i < res.backup!.totalChunks; i++) {
      const cPath = `orgs/org_test_1/branches/main/backups/${res.backup!.id}/chunks/${i}`;
      const cDoc = firestoreMockState.docs.get(cPath);
      expect(cDoc).toBeDefined();
      expect(cDoc.data.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }

    // Verify multiple batches committed and each batch <= MAX_BATCH_BYTES (3 MB)
    expect(firestoreMockState.batchCommitSizes.length).toBeGreaterThanOrEqual(2);
    for (const batchBytes of firestoreMockState.batchCommitSizes) {
      expect(batchBytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  // 3. Incomplete backups exclusion, download rejection, and >24h cleanup
  it('(3) استثناء النسخ غير المكتملة (uploading) من القائمة ورفض استعادتها وتنظيف غير المكتملة الأقدم من 24 ساعة', async () => {
    const now = Date.now();
    const basePrefix = 'orgs/org_test_1/branches/main/backups';

    // Complete backup
    firestoreMockState.docs.set(`${basePrefix}/backup_complete_1`, {
      id: 'backup_complete_1',
      metadata: {
        status: 'complete',
        createdAt: { __timestampMs: now - 3_600_000 },
        sizeBytes: 1200,
        appVersion: '2.0.0',
        totalChunks: 1,
        totalProducts: 10,
        totalInvoices: 5,
        totalCustomers: 3,
        checksum: 'abc',
        compressed: true,
        schemaVersion: 2,
      },
    });

    // Recent incomplete backup (2 hours old -> must NOT be deleted as stale, must NOT appear in list)
    firestoreMockState.docs.set(`${basePrefix}/backup_uploading_recent`, {
      id: 'backup_uploading_recent',
      metadata: {
        status: 'uploading',
        createdAt: { __timestampMs: now - 2 * 3_600_000 },
        sizeBytes: 1200,
        appVersion: '2.0.0',
        totalChunks: 1,
        totalProducts: 10,
        totalInvoices: 5,
        totalCustomers: 3,
        checksum: 'abc',
        compressed: true,
        schemaVersion: 2,
      },
    });

    // Stale incomplete backup (> 24h old -> must be cleaned up along with chunks)
    firestoreMockState.docs.set(`${basePrefix}/backup_uploading_stale`, {
      id: 'backup_uploading_stale',
      metadata: {
        status: 'uploading',
        createdAt: { __timestampMs: now - (STALE_INCOMPLETE_BACKUP_MS + 3_600_000) },
        sizeBytes: 1200,
        appVersion: '2.0.0',
        totalChunks: 1,
        totalProducts: 10,
        totalInvoices: 5,
        totalCustomers: 3,
        checksum: 'abc',
        compressed: true,
        schemaVersion: 2,
      },
    });
    firestoreMockState.docs.set(`${basePrefix}/backup_uploading_stale/chunks/0`, {
      chunkIndex: 0,
      data: 'stale-chunk',
    });

    const listRes = await cloudBackupService.listCompleteBackups();
    expect(listRes.success).toBe(true);
    expect(listRes.backups.map(b => b.id)).toEqual(['backup_complete_1']);

    // Wait tick for best-effort async cleanup inside listCompleteBackups
    await new Promise(r => setTimeout(r, 20));
    expect(firestoreMockState.docs.has(`${basePrefix}/backup_uploading_stale`)).toBe(false);
    expect(firestoreMockState.docs.has(`${basePrefix}/backup_uploading_stale/chunks/0`)).toBe(false);
    expect(firestoreMockState.docs.has(`${basePrefix}/backup_uploading_recent`)).toBe(true);

    // Downloading incomplete backup must be refused cleanly
    const dlIncomplete = await cloudBackupService.downloadAndValidateBackup('backup_uploading_recent');
    expect(dlIncomplete.success).toBe(false);
    expect(dlIncomplete.error).toContain('غير مكتملة');
  });

  // 4. New retention policy: latest of each day for last 7 days + latest 6 inside today, delete chunks before doc, never delete newest
  it('(4) سياسة الاحتفاظ الجديدة: آخر نسخة من كل يوم لآخر 7 أيام + آخر 6 نسخ لليوم الحالي وحذف الأقدم دون حذف أحدث نسخة أبداً', async () => {
    const basePrefix = 'orgs/org_test_1/branches/main/backups';
    // Pin a fixed Cairo midday anchor: 2026-11-15T10:00:00Z (12:00 PM Cairo)
    const todayNoonMs = Date.parse('2026-11-15T10:00:00Z');
    const todayCairo = '2026-11-15';
    const dayMs = 24 * 60 * 60 * 1000;

    const addMockBackup = (id: string, createdAtMs: number) => {
      firestoreMockState.docs.set(`${basePrefix}/${id}`, {
        id,
        metadata: {
          status: 'complete',
          createdAt: { __timestampMs: createdAtMs },
          sizeBytes: 500,
          appVersion: '2.0.0',
          totalChunks: 2,
          totalProducts: 10,
          totalInvoices: 5,
          totalCustomers: 3,
          checksum: 'sum',
          compressed: true,
          schemaVersion: 2,
        },
      });
      firestoreMockState.docs.set(`${basePrefix}/${id}/chunks/0`, { chunkIndex: 0, data: 'c0' });
      firestoreMockState.docs.set(`${basePrefix}/${id}/chunks/1`, { chunkIndex: 1, data: 'c1' });
    };

    // Today: 8 backups (oldest 2: today_1, today_2 should be deleted; newest 6: today_3..today_8 kept)
    for (let i = 1; i <= 8; i++) {
      addMockBackup(`backup_today_${i}`, todayNoonMs - (9 - i) * 60_000);
    }

    // Yesterday (day -1): 3 backups -> only newest (day1_3) kept; day1_1 & day1_2 deleted
    addMockBackup('backup_day1_1', todayNoonMs - 1 * dayMs - 120_000);
    addMockBackup('backup_day1_2', todayNoonMs - 1 * dayMs - 60_000);
    addMockBackup('backup_day1_3', todayNoonMs - 1 * dayMs);

    // Days -2 .. -6 (within last 7 days window): 1 per day -> all kept
    for (let d = 2; d <= 6; d++) {
      addMockBackup(`backup_day${d}`, todayNoonMs - d * dayMs);
    }

    // Days -7, -8, -9 (older than 7 days): all deleted
    addMockBackup('backup_old_7', todayNoonMs - 7 * dayMs);
    addMockBackup('backup_old_8', todayNoonMs - 8 * dayMs);
    addMockBackup('backup_old_9', todayNoonMs - 9 * dayMs);

    const cleanupRes = await cloudBackupService.enforceRetentionAndCleanup(
      'org_test_1',
      'main',
      7,
      'backup_today_8',
      todayCairo
    );
    // Deleted: 2 from today + 2 from day-1 + 3 older (>7d) = 7
    expect(cleanupRes.deletedCompleteCount).toBe(7);

    // Verify kept: 6 from today + 1 from day-1 + 5 from days -2..-6 = 12
    for (let i = 3; i <= 8; i++) {
      expect(firestoreMockState.docs.has(`${basePrefix}/backup_today_${i}`)).toBe(true);
    }
    expect(firestoreMockState.docs.has(`${basePrefix}/backup_day1_3`)).toBe(true);
    for (let d = 2; d <= 6; d++) {
      expect(firestoreMockState.docs.has(`${basePrefix}/backup_day${d}`)).toBe(true);
    }

    // Verify deleted + chunks deleted BEFORE metadata doc
    const expectedDeleted = [
      'backup_today_1',
      'backup_today_2',
      'backup_day1_1',
      'backup_day1_2',
      'backup_old_7',
      'backup_old_8',
      'backup_old_9',
    ];
    for (const oldId of expectedDeleted) {
      expect(firestoreMockState.docs.has(`${basePrefix}/${oldId}`)).toBe(false);
      expect(firestoreMockState.docs.has(`${basePrefix}/${oldId}/chunks/0`)).toBe(false);
      expect(firestoreMockState.docs.has(`${basePrefix}/${oldId}/chunks/1`)).toBe(false);

      const batchDelIdx = firestoreMockState.operationLog.findIndex(
        e => e.op === 'batchDelete' && e.path.startsWith(`${basePrefix}/${oldId}/chunks/`)
      );
      const docDelIdx = firestoreMockState.operationLog.findIndex(
        e => e.op === 'deleteDoc' && e.path === `${basePrefix}/${oldId}`
      );
      expect(batchDelIdx).toBeGreaterThanOrEqual(0);
      expect(docDelIdx).toBeGreaterThan(batchDelIdx);
    }

    // Edge case: even if ALL backups are older than 7 days, newest complete backup MUST NEVER be deleted
    const oldOnlySelection = selectBackupsToKeepAndDelete(
      [
        { id: 'very_old_newest', createdAtMs: todayNoonMs - 14 * dayMs },
        { id: 'very_old_older', createdAtMs: todayNoonMs - 15 * dayMs },
      ],
      todayCairo
    );
    expect(oldOnlySelection.keepIds).toContain('very_old_newest');
    expect(oldOnlySelection.deleteIds).toContain('very_old_older');

    // deleteCloudBackup refuses deleting newest complete backup
    const deleteLatestAttempt = await cloudBackupService.deleteCloudBackup('backup_today_8');
    expect(deleteLatestAttempt.success).toBe(false);
    expect(deleteLatestAttempt.error).toContain('أحدث نسخة');
    expect(firestoreMockState.docs.has(`${basePrefix}/backup_today_8`)).toBe(true);
  });

  // 5. Pre-upload safety guards (empty DB, unchanged checksum, >30% drop protection)
  it('(5) منع رفع البيانات الفارغة وتخطي النسخة غير المتغيرة وحظر الرفع عند انخفاض >30% في الأصناف/الفواتير/العملاء', async () => {
    // 5a. Empty store -> rejected
    const emptyRes = await cloudBackupService.createAndUploadBackup('manual');
    expect(emptyRes.success).toBe(false);
    expect(emptyRes.reason).toBe('empty_data');
    expect(firestoreMockState.docs.size).toBe(0);

    // 5b. Load demo data & upload first backup -> succeeds
    storage.loadDemoData();
    const firstUpload = await cloudBackupService.createAndUploadBackup('manual');
    expect(firstUpload.success).toBe(true);

    // 5c. Repeat immediately with identical data -> skipped with no_changes
    const secondUpload = await cloudBackupService.createAndUploadBackup('manual');
    expect(secondUpload.success).toBe(true);
    expect(secondUpload.skipped).toBe(true);
    expect(secondUpload.reason).toBe('no_changes');

    // 5d. Drop products by > 30% -> refused with suspicious_drop + alert message
    const allProducts = storage.getProducts();
    expect(allProducts.length).toBeGreaterThanOrEqual(5);
    const reducedProducts = allProducts.slice(0, 1); // >70% drop
    storage.setItem(STORAGE_KEYS.PRODUCTS, reducedProducts);

    const dropRes = await cloudBackupService.createAndUploadBackup('manual');
    expect(dropRes.success).toBe(false);
    expect(dropRes.reason).toBe('suspicious_drop');
    expect(cloudBackupService.getDropAlert()).toContain('تحذير');
    expect(dropRes.error).toContain('تحذير');
  });

  // 6. Error handling: transient retry & permission-denied pause
  it('(6) إعادة المحاولة عند أخطاء الشبكة العابرة (unavailable) والتوقف الهادئ عند permission-denied', async () => {
    storage.loadDemoData();

    // 6a. Transient network failure once -> retries and succeeds
    firestoreMockState.transientSetDocFailures = 1;
    const retryRes = await cloudBackupService.createAndUploadBackup('manual');
    expect(retryRes.success).toBe(true);
    const setDocCalls = firestoreMockState.operationLog.filter(o => o.op === 'setDoc');
    expect(setDocCalls.length).toBe(2);

    // 6b. Mutate data + simulate permission-denied -> pauses silently
    const products = storage.getProducts();
    storage.setItem(STORAGE_KEYS.PRODUCTS, [
      ...products,
      { ...products[0], id: 'p_perm_test', name: 'صنف اختبار صلاحيات', barcode: '9999888877771' },
    ]);

    firestoreMockState.forcePermissionDeniedOnSetDoc = true;
    const permRes = await cloudBackupService.createAndUploadBackup('manual');
    expect(permRes.success).toBe(false);
    expect(permRes.reason).toBe('permission_paused');
    expect(cloudBackupService.isPermissionPaused()).toBe(true);

    // Automatic background trigger ('shift_close') skips silently without hitting Firestore while paused
    const callsBeforePausedTrigger = firestoreMockState.operationLog.length;
    const skippedAuto = await cloudBackupService.onShiftClosed();
    expect(skippedAuto.skipped).toBe(true);
    expect(skippedAuto.reason).toBe('permission_paused');
    expect(firestoreMockState.operationLog.length).toBe(callsBeforePausedTrigger);
  });

  // 7. Full E2E cloud restore on a new device + tamper detection + mandatory post-restore admin setup
  it('(7) استعادة كاملة على جهاز جديد + فحص SHA-256 ضد التلف + فرض تعيين كلمة مرور المدير ومنع التجاوز', async () => {
    // Device 1: Populate store & create users with credentials
    storage.loadDemoData();
    const origAdmin = await authSecurityService.setupInitialAdmin({
      fullName: 'صاحب المحل',
      username: 'owner1',
      password: 'OldDevice1Password',
    });
    const cashierCreated = await authSecurityService.saveCashier(origAdmin, {
      fullName: 'كاشير الفترة الصباحية',
      username: 'cashier_am',
      role: 'SALES',
      pin: '5739',
      isActive: true,
      permissions: {
        canEditPrice: false,
        canGiveDiscount: false,
        canSellNegativeStock: false,
        canDeleteInvoice: false,
        canEditInvoice: false,
        canViewProfits: false,
        canManageProducts: false,
        canManagePurchases: false,
        canManageCash: false,
        canWithdrawNegativeCash: false,
        canProcessReturns: false,
      },
    });
    expect(cashierCreated.success).toBe(true);
    const cashierId = cashierCreated.user!.id;

    const expectedProductCount = storage.getProducts().length;
    const expectedCustomerCount = storage.getCustomers().length;

    const uploadRes = await cloudBackupService.createAndUploadBackup('manual', 'نسخة الانتقال لجهاز جديد');
    expect(uploadRes.success).toBe(true);
    const backupId = uploadRes.backup!.id;

    // Simulate clean wipe on Device 2 (clear localStorage & IDB, keeping only cloud docs)
    localStorage.clear();
    await idb.kv.clear();
    await idb.snapshots.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    await storage.init();
    cloudBackupService.resetInternalStateForTesting();

    expect(storage.getProducts().length).toBe(0);
    expect(storage.getUsers().length).toBe(0);

    // Anti-bypass check: completePostRestoreAdminSetup must fail before a restore sets the flag
    expect(authSecurityService.isCredentialsResetRequired()).toBe(false);
    const preRestoreBypass = await authSecurityService.completePostRestoreAdminSetup(
      origAdmin.id,
      'BypassAttempt99'
    );
    expect(preRestoreBypass.success).toBe(false);

    // Tamper check: corrupt chunk 0 temporarily and ensure SHA-256 rejects it
    const chunk0Path = `orgs/org_test_1/branches/main/backups/${backupId}/chunks/0`;
    const originalChunk0 = firestoreMockState.docs.get(chunk0Path);
    firestoreMockState.docs.set(chunk0Path, {
      ...originalChunk0,
      data: 'CORRUPTED_' + originalChunk0.data.slice(10),
    });
    const tamperedDownload = await cloudBackupService.downloadAndValidateBackup(backupId);
    expect(tamperedDownload.success).toBe(false);
    expect(tamperedDownload.error).toContain('SHA-256');

    // Restore valid chunk 0 and run full download + validation with progress callback
    firestoreMockState.docs.set(chunk0Path, originalChunk0);
    const progressEvents: number[] = [];
    const dlRes = await cloudBackupService.downloadAndValidateBackup(backupId, p => {
      progressEvents.push(p.percent);
    });
    expect(dlRes.success).toBe(true);
    expect(dlRes.validatedData).toBeDefined();
    expect(progressEvents[progressEvents.length - 1]).toBe(100);

    // Execute cloud restore
    const restoreRes = await cloudBackupService.executeCloudRestore(
      dlRes.validatedData!,
      'نسخة سحابية تجريبية'
    );
    expect(restoreRes.success).toBe(true);

    // Verify all business data restored and user credentials stripped
    expect(storage.getProducts().length).toBe(expectedProductCount);
    expect(storage.getCustomers().length).toBe(expectedCustomerCount);
    expect(storage.getActiveUser()).toBeNull();
    expect(authSecurityService.isCredentialsResetRequired()).toBe(true);

    const restoredAdmin = storage.getUsers().find(u => u.id === origAdmin.id);
    const restoredCashier = storage.getUsers().find(u => u.id === cashierId);
    expect(restoredAdmin).toBeDefined();
    expect(restoredCashier).toBeDefined();
    expect(userHasCredentials(restoredAdmin)).toBe(false);
    expect(userHasCredentials(restoredCashier)).toBe(false);

    // Cashier login must fail with clear Arabic message asking Admin to assign PIN
    const cashierLogin = await authSecurityService.authenticate(cashierId, '5739');
    expect(cashierLogin.success).toBe(false);
    expect(cashierLogin.error).toContain('إدارة المستخدمين');

    // Default or weak admin password must be rejected
    const weakSetup = await authSecurityService.completePostRestoreAdminSetup(origAdmin.id, '123456');
    expect(weakSetup.success).toBe(false);
    const shortSetup = await authSecurityService.completePostRestoreAdminSetup(origAdmin.id, 'abc12');
    expect(shortSetup.success).toBe(false);

    // Strong new admin password succeeds, clears reset flag, and logs Admin in
    const adminSetupRes = await authSecurityService.completePostRestoreAdminSetup(
      origAdmin.id,
      'NewDevice2StrongPass!'
    );
    expect(adminSetupRes.success).toBe(true);
    expect(adminSetupRes.user?.role).toBe('ADMIN');
    expect(userHasCredentials(adminSetupRes.user)).toBe(true);
    expect(authSecurityService.isCredentialsResetRequired()).toBe(false);
    expect(storage.getActiveUser()?.id).toBe(origAdmin.id);

    // Anti-bypass after setup: calling completePostRestoreAdminSetup again must fail
    const postSetupReplay = await authSecurityService.completePostRestoreAdminSetup(
      origAdmin.id,
      'AnotherPass999'
    );
    expect(postSetupReplay.success).toBe(false);

    // Authenticating with the newly set password works normally
    const loginCheck = await authSecurityService.authenticate(origAdmin.id, 'NewDevice2StrongPass!');
    expect(loginCheck.success).toBe(true);
  });

  // 8. Periodic 30-minute auto backup: uploads only when data changed + preconditions met
  it('(8) النسخة السحابية الدورية كل 30 دقيقة لا ترفع عند عدم تغير البيانات وترفع عند وجود تغييرات وتوفر الشروط', async () => {
    storage.loadDemoData();

    // First periodic run -> uploads complete backup with trigger='periodic'
    const firstPeriodic = await cloudBackupService.runPeriodicBackupCheck();
    expect(firstPeriodic.success).toBe(true);
    expect(firstPeriodic.backup?.trigger).toBe('periodic');

    const docsAfterFirst = firestoreMockState.operationLog.filter(o => o.op === 'setDoc').length;
    expect(docsAfterFirst).toBe(1);

    // Second periodic run with NO changes -> skipped with no_changes and zero Firestore writes
    const unchangedPeriodic = await cloudBackupService.runPeriodicBackupCheck();
    expect(unchangedPeriodic.success).toBe(true);
    expect(unchangedPeriodic.skipped).toBe(true);
    expect(unchangedPeriodic.reason).toBe('no_changes');
    expect(firestoreMockState.operationLog.filter(o => o.op === 'setDoc').length).toBe(docsAfterFirst);

    // Mutate data + verify precondition guards (no license / not signed in / offline) skip cleanly
    const products = storage.getProducts();
    storage.setItem(STORAGE_KEYS.PRODUCTS, [
      ...products,
      { ...products[0], id: 'p_periodic_1', name: 'صنف دوري جديد', barcode: '6220009998881' },
    ]);

    orgSyncMockState.context = null;
    const noLicRes = await cloudBackupService.runPeriodicBackupCheck();
    expect(noLicRes.skipped).toBe(true);
    expect(noLicRes.reason).toBe('no_license');

    orgSyncMockState.context = { orgId: 'org_test_1', branchId: 'main', mode: 'offline' };
    orgSyncMockState.signInStatus = 'needs-login' as any;
    const notSignedRes = await cloudBackupService.runPeriodicBackupCheck();
    expect(notSignedRes.skipped).toBe(true);
    expect(notSignedRes.reason).toBe('needs_login');

    // Restore preconditions and verify 30-minute interval timer invokes periodic backup upload
    orgSyncMockState.signInStatus = 'ok';
    const periodicSpy = vi.spyOn(cloudBackupService, 'runPeriodicBackupCheck');
    vi.useFakeTimers();
    try {
      cloudBackupService.startPeriodicBackup(PERIODIC_BACKUP_INTERVAL_MS);
      expect(cloudBackupService.isPeriodicBackupRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(PERIODIC_BACKUP_INTERVAL_MS);
      expect(periodicSpy).toHaveBeenCalledTimes(1);
    } finally {
      cloudBackupService.stopPeriodicBackup();
      vi.useRealTimers();
    }

    const timerResult = await periodicSpy.mock.results[0].value;
    expect(timerResult.success).toBe(true);
    expect(timerResult.backup?.trigger).toBe('periodic');
    const docsAfterTimer = firestoreMockState.operationLog.filter(o => o.op === 'setDoc').length;
    expect(docsAfterTimer).toBe(2);
    periodicSpy.mockRestore();
  });
});
