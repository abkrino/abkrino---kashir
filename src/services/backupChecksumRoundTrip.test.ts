import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { snapshotService } from './snapshotService';

describe('Backup checksum JSON round-trip regression', () => {
  beforeEach(async () => {
    localStorage.clear();
    await idb.kv.clear();
    await idb.snapshots.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
    vi.spyOn(storage, 'assertWriteAllowed').mockReturnValue({ allowed: true });
    await storage.init();
    storage.loadDemoData();
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
    vi.restoreAllMocks();
  });

  it('keeps a freshly exported backup valid after the exact JSON stringify/parse file round-trip', async () => {
    const products = storage.getProducts();
    const base = products[0];
    storage.setItem(STORAGE_KEYS.PRODUCTS, [
      ...products,
      {
        ...base,
        id: 'checksum_roundtrip_edge_case',
        optionalUndefined: undefined,
        nested: {
          omitted: undefined,
          list: [undefined, Number.NaN, Number.POSITIVE_INFINITY],
        },
      },
    ]);
    await storage.flush();

    const exported = await snapshotService.generateExportPackage();
    const fileBytes = JSON.stringify(exported);
    const validation = await snapshotService.validateBackup(fileBytes);

    expect(validation.valid).toBe(true);
    expect(validation.preview?.checksumStatus).toBe('verified');
    expect(validation.validatedData?.products).toHaveLength(products.length + 1);
  });

  it('rejects a one-byte-equivalent payload mutation after serialization', async () => {
    const exported = await snapshotService.generateExportPackage();
    const parsed = JSON.parse(JSON.stringify(exported));
    parsed.data.products[0].name = String(parsed.data.products[0].name) + ' altered';

    const validation = await snapshotService.validateBackup(JSON.stringify(parsed));

    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('SHA-256');
  });
});
