import { describe, expect, it } from 'vitest';
import type { Product } from '../types';
import {
  allocateFifo,
  releaseInvoiceAllocations,
  returnToOriginalLots,
  seedOpeningLots,
  validateFifoLedger,
  type InventoryLot,
} from './inventoryFifoService';

const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'p-1', code: 'P1', barcode: '', name: 'Test product', category: 'food',
  brand: '', baseUnit: 'قطعة', wholesaleUnit: 'كرتونة', piecesPerWholesaleUnit: 10,
  costPricePerBase: 7, costPricePerCarton: 70, retailPricePerBase: 12,
  wholesalePricePerCarton: 100, halfWholesalePricePerCarton: 90,
  stockPieces: 5, reorderLevelPieces: 0, isActive: true, ...overrides,
});

const lot = (id: string, qty: number, cost: number, sequence: number, date: string): InventoryLot => ({
  id, productId: 'p-1', source: 'PURCHASE', receivedAt: date, sequence,
  originalQty: qty, remainingQty: qty, unitCost: cost, createdAt: date,
});

describe('FIFO inventory ledger', () => {
  it('creates an opening lot once and preserves stock and current cost', () => {
    const p = product({ stockPieces: 25, costPricePerBase: 4.25 });
    const seeded = seedOpeningLots([p], [], '2026-11-23T00:00:00.000Z');
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ source: 'OPENING', originalQty: 25, remainingQty: 25, unitCost: 4.25 });
    expect(seedOpeningLots([p], seeded, '2026-11-24T00:00:00.000Z')).toEqual(seeded);
    expect(validateFifoLedger([p], seeded)).toEqual([]);
  });

  it('allocates oldest lots first and calculates exact COGS', () => {
    const lots = [
      lot('old', 100, 10, 1, '2026-01-01'),
      lot('new', 100, 12, 2, '2026-02-01'),
    ];
    const result = allocateFifo(lots, [], 'sale-1', 'line-1', 'p-1', 150, '2026-03-01');
    expect(result.error).toBeUndefined();
    expect(result.costTotal).toBe(1600);
    expect(result.lots.map(x => x.remainingQty)).toEqual([0, 50]);
    expect(result.allocations.map(x => [x.lotId, x.quantity, x.unitCost])).toEqual([
      ['old', 100, 10], ['new', 50, 12],
    ]);
  });

  it('rejects a sale when lot quantity is insufficient without mutating inputs', () => {
    const lots = [lot('only', 4, 3, 1, '2026-01-01')];
    const result = allocateFifo(lots, [], 'sale', 'line', 'p-1', 5);
    expect(result.error).toContain('غير كافية');
    expect(lots[0].remainingQty).toBe(4);
    expect(result.allocations).toHaveLength(0);
  });

  it('returns goods to the exact lots used by the original sale', () => {
    const lots = [lot('old', 100, 10, 1, '2026-01-01'), lot('new', 100, 12, 2, '2026-02-01')];
    const sale = allocateFifo(lots, [], 'sale', 'line', 'p-1', 150, '2026-03-01');
    const returned = returnToOriginalLots(sale.lots, sale.allocations, 'sale', 'line', 60);
    expect(returned.error).toBeUndefined();
    expect(returned.lots.map(x => x.remainingQty)).toEqual([60, 50]);
    expect(returned.allocations.map(x => x.returnedQty)).toEqual([60, 0]);
  });

  it('releases unreturned allocations back to their original lots', () => {
    const lots = [lot('old', 100, 10, 1, '2026-01-01')];
    const sale = allocateFifo(lots, [], 'sale', 'line', 'p-1', 40);
    const released = releaseInvoiceAllocations(sale.lots, sale.allocations, 'sale');
    expect(released.error).toBeUndefined();
    expect(released.lots[0].remainingQty).toBe(100);
    expect(released.allocations[0].returnedQty).toBe(40);
  });
});
