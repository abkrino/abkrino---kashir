import { describe, expect, it } from 'vitest';
import { canonicalStringify, computeDataChecksum } from './snapshotService';

describe('Backup checksum JSON compatibility', () => {
  it('omits undefined object properties exactly like JSON serialization', () => {
    const value = { keep: 1, omitted: undefined, nested: { skip: undefined, keep: 'ok' } };
    expect(canonicalStringify(value)).toBe('{"keep":1,"nested":{"keep":"ok"}}');
  });

  it('serializes undefined array entries as null and sorts object keys', () => {
    const value = { z: [undefined, { b: 2, a: 1 }], a: true };
    expect(canonicalStringify(value)).toBe('{"a":true,"z":[null,{"a":1,"b":2}]}');
  });

  it('normalizes non-finite numbers to null, matching JSON.stringify', () => {
    expect(canonicalStringify({ a: Number.NaN, b: Infinity, c: -Infinity })).toBe('{"a":null,"b":null,"c":null}');
  });

  it('produces a 64-character SHA-256 digest for JSON-safe data', async () => {
    const checksum = await computeDataChecksum({ b: 2, a: 1 });
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });


  it('keeps export checksums stable after JSON serialization removes undefined properties', async () => {
    const exportData = {
      products: [{ id: 'p1', optionalNote: undefined, name: 'صنف' }],
      currentShift: null,
      users: [{ id: 'u1', optionalPin: undefined }],
    };
    const checksumBeforeExport = await computeDataChecksum(exportData);
    const serializedPackage = JSON.stringify({ checksum: checksumBeforeExport, data: exportData });
    const importedPackage = JSON.parse(serializedPackage);
    const checksumAfterImport = await computeDataChecksum(importedPackage.data);
    expect(checksumAfterImport).toBe(checksumBeforeExport);
  });

  it('retains the established checksum serialization for previously exported JSON data', () => {
    const oldBackupData = {
      products: [{ id: 'p1', name: 'صنف', stockPieces: 5 }],
      customers: [],
      suppliers: [],
      invoices: [],
      purchases: [],
      cashMovements: [],
      expenses: [],
      auditLogs: [],
      stockAdjustments: [],
      users: [],
      parkedCarts: [],
      currentShift: null,
    };
    expect(canonicalStringify(oldBackupData)).toBe(
      '{"auditLogs":[],"cashMovements":[],"customers":[],"currentShift":null,"expenses":[],"invoices":[],"parkedCarts":[],"products":[{"id":"p1","name":"صنف","stockPieces":5}],"purchases":[],"stockAdjustments":[],"suppliers":[],"users":[]}'
    );
  });
});
