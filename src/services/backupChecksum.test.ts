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
    expect(canonicalStringify(oldBackupData)).toBe(JSON.stringify(oldBackupData, Object.keys(oldBackupData).sort()));
    expect(canonicalStringify(oldBackupData)).toContain('"products"');
  });
});
