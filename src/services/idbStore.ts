import Dexie, { type Table } from 'dexie';

export interface KVRecord {
  key: string;
  value: any;
  updatedAt: number;
}

export class KashirDatabase extends Dexie {
  kv!: Table<KVRecord, string>;

  constructor() {
    super('kashir');
    this.version(1).stores({
      kv: '&key, updatedAt',
    });
  }
}

export const idb = new KashirDatabase();
