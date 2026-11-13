import Dexie, { type Table } from 'dexie';

export interface KVRecord {
  key: string;
  value: any;
  updatedAt: number;
}

export interface SnapshotMetadata {
  approxSizeBytes: number;
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
  schemaVersion: number;
  appVersion: string;
  checksum: string;
}

export type SnapshotStatus = 'healthy' | 'suspicious';

export interface SnapshotRecord {
  id: string;
  dateStr: string;
  type: 'daily' | 'shift_close' | 'pre_restore' | 'pre_import' | 'manual';
  status: SnapshotStatus;
  timestamp: number;
  data: Record<string, any>;
  metadata: SnapshotMetadata;
}

export class KashirDatabase extends Dexie {
  kv!: Table<KVRecord, string>;
  snapshots!: Table<SnapshotRecord, string>;
  restore_staging!: Table<KVRecord, string>;

  constructor() {
    super('kashir');
    this.version(1).stores({
      kv: '&key, updatedAt',
    });
    this.version(2).stores({
      kv: '&key, updatedAt',
      snapshots: '&id, dateStr, timestamp, type',
    });
    this.version(3).stores({
      kv: '&key, updatedAt',
      snapshots: '&id, dateStr, timestamp, type, status',
      restore_staging: '&key, updatedAt',
    });
  }
}

export const idb = new KashirDatabase();
