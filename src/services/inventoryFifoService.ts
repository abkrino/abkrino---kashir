import type { Product } from '../types';

/**
 * FIFO inventory ledger. Quantities are always expressed in the product's
 * base stock unit (pieces/kg), never cartons or selling units.
 */
export type InventoryLotSource = 'OPENING' | 'PURCHASE' | 'BONUS' | 'ADJUSTMENT' | 'RETURN';

export interface InventoryLot {
  id: string;
  productId: string;
  source: InventoryLotSource;
  referenceId?: string;
  referenceNumber?: string;
  receivedAt: string;
  sequence: number;
  originalQty: number;
  remainingQty: number;
  unitCost: number;
  batchNumber?: string;
  expiryDate?: string;
  createdAt: string;
}

export interface FifoAllocation {
  id: string;
  invoiceId: string;
  invoiceItemId: string;
  productId: string;
  lotId: string;
  quantity: number;
  unitCost: number;
  returnedQty: number;
  createdAt: string;
}

export interface FifoResult {
  lots: InventoryLot[];
  allocations: FifoAllocation[];
  costTotal: number;
  error?: string;
}

const roundQty = (n: number) => Math.round(n * 1000) / 1000;
const roundMoney = (n: number) => Math.round(n * 100) / 100;

export function seedOpeningLots(
  products: Product[],
  existingLots: InventoryLot[],
  activatedAt = new Date().toISOString()
): InventoryLot[] {
  const lots = existingLots.slice();
  const productsWithLots = new Set(lots.map(lot => lot.productId));
  let sequence = lots.reduce((max, lot) => Math.max(max, Number(lot.sequence) || 0), 0);
  for (const product of products) {
    if (productsWithLots.has(product.id)) continue;
    const quantity = roundQty(Number(product.stockPieces));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const unitCost = Number(product.costPricePerBase);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(`تكلفة افتتاحية غير صالحة للصنف ${product.name || product.id}`);
    }
    sequence += 1;
    lots.push({
      id: `lot-opening-${product.id}`,
      productId: product.id,
      source: 'OPENING',
      referenceId: 'FIFO-OPENING',
      referenceNumber: 'رصيد افتتاحي عند تفعيل FIFO',
      receivedAt: activatedAt,
      sequence,
      originalQty: quantity,
      remainingQty: quantity,
      unitCost,
      batchNumber: product.batchNumber,
      expiryDate: product.expiryDate,
      createdAt: activatedAt,
    });
  }
  return lots;
}

export function receiveLot(
  lots: InventoryLot[],
  input: Omit<InventoryLot, 'sequence' | 'createdAt'>
): InventoryLot[] {
  if (!input.productId || !Number.isFinite(input.originalQty) || input.originalQty <= 0 ||
      !Number.isFinite(input.unitCost) || input.unitCost < 0) {
    throw new Error('بيانات دفعة المخزون غير صالحة.');
  }
  if (lots.some(lot => lot.id === input.id)) throw new Error('دفعة المخزون مسجلة بالفعل.');
  const sequence = lots.reduce((max, lot) => Math.max(max, Number(lot.sequence) || 0), 0) + 1;
  return [...lots, { ...input, sequence, createdAt: new Date().toISOString() }];
}

/** Allocate oldest available lots first. Returns a new ledger; inputs are not mutated. */
export function allocateFifo(
  lots: InventoryLot[],
  allocations: FifoAllocation[],
  invoiceId: string,
  itemId: string,
  productId: string,
  quantity: number,
  createdAt = new Date().toISOString()
): FifoResult {
  const requested = roundQty(Number(quantity));
  if (!invoiceId || !itemId || !productId || !Number.isFinite(requested) || requested <= 0) {
    return { lots, allocations, costTotal: 0, error: 'بيانات تخصيص FIFO غير صالحة.' };
  }
  const nextLots = lots.map(lot => ({ ...lot }));
  const candidates = nextLots
    .filter(lot => lot.productId === productId && Number(lot.remainingQty) > 0)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  const available = roundQty(candidates.reduce((sum, lot) => sum + Number(lot.remainingQty), 0));
  if (available + 1e-6 < requested) {
    return { lots, allocations, costTotal: 0, error: `دفعات FIFO للصنف ${productId} غير كافية. المتاح بالدفعات ${available} والمطلوب ${requested}.` };
  }
  let remaining = requested;
  let costTotal = 0;
  const nextAllocations = allocations.map(allocation => ({ ...allocation }));
  for (const lot of candidates) {
    if (remaining <= 1e-6) break;
    const take = roundQty(Math.min(remaining, lot.remainingQty));
    if (take <= 0) continue;
    lot.remainingQty = roundQty(lot.remainingQty - take);
    costTotal += take * lot.unitCost;
    nextAllocations.push({
      id: `alloc-${invoiceId}-${itemId}-${nextAllocations.length + 1}`,
      invoiceId, invoiceItemId: itemId, productId, lotId: lot.id,
      quantity: take, unitCost: lot.unitCost, returnedQty: 0, createdAt,
    });
    remaining = roundQty(remaining - take);
  }
  return { lots: nextLots, allocations: nextAllocations, costTotal: roundMoney(costTotal) };
}

/** Release all unreturned allocations of an invoice back to their original lots. */
export function releaseInvoiceAllocations(
  lots: InventoryLot[],
  allocations: FifoAllocation[],
  invoiceId: string
): { lots: InventoryLot[]; allocations: FifoAllocation[]; error?: string } {
  const nextLots = lots.map(lot => ({ ...lot }));
  const nextAllocations = allocations.map(allocation => ({ ...allocation }));
  for (const allocation of nextAllocations.filter(a => a.invoiceId === invoiceId)) {
    const releasable = roundQty(allocation.quantity - allocation.returnedQty);
    if (releasable <= 0) continue;
    const lot = nextLots.find(candidate => candidate.id === allocation.lotId);
    if (!lot) return { lots, allocations, error: `دفعة FIFO المرتبطة بالبيع غير موجودة: ${allocation.lotId}` };
    lot.remainingQty = roundQty(lot.remainingQty + releasable);
    allocation.returnedQty = roundQty(allocation.quantity);
  }
  return { lots: nextLots, allocations: nextAllocations };
}

/** Restock a customer return into the exact lots consumed by the original sale. */
export function returnToOriginalLots(
  lots: InventoryLot[],
  allocations: FifoAllocation[],
  invoiceId: string,
  invoiceItemId: string,
  quantity: number
): { lots: InventoryLot[]; allocations: FifoAllocation[]; error?: string } {
  let remaining = roundQty(Number(quantity));
  if (!Number.isFinite(remaining) || remaining <= 0) return { lots, allocations, error: 'كمية المرتجع غير صالحة.' };
  const nextLots = lots.map(lot => ({ ...lot }));
  const nextAllocations = allocations.map(allocation => ({ ...allocation }));
  const matches = nextAllocations
    .filter(a => a.invoiceId === invoiceId && a.invoiceItemId === invoiceItemId && a.returnedQty < a.quantity)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const returnable = roundQty(matches.reduce((sum, a) => sum + a.quantity - a.returnedQty, 0));
  if (returnable + 1e-6 < remaining) return { lots, allocations, error: 'كمية المرتجع تتجاوز الكمية المتبقية من تخصيصات FIFO الأصلية.' };
  for (const allocation of matches) {
    if (remaining <= 1e-6) break;
    const take = roundQty(Math.min(remaining, allocation.quantity - allocation.returnedQty));
    const lot = nextLots.find(candidate => candidate.id === allocation.lotId);
    if (!lot) return { lots, allocations, error: `دفعة FIFO المرتبطة بالمرتجع غير موجودة: ${allocation.lotId}` };
    lot.remainingQty = roundQty(lot.remainingQty + take);
    allocation.returnedQty = roundQty(allocation.returnedQty + take);
    remaining = roundQty(remaining - take);
  }
  return { lots: nextLots, allocations: nextAllocations };
}

export function validateFifoAllocations(lots: InventoryLot[], allocations: FifoAllocation[]): string[] {
  const errors: string[] = [];
  const lotById = new Map(lots.map(lot => [lot.id, lot]));
  const ids = new Set<string>();
  for (const allocation of allocations) {
    if (!allocation.id || ids.has(allocation.id)) errors.push(`تخصيص FIFO بمعرّف مكرر أو فارغ: ${allocation.id || 'غير معروف'}.`);
    ids.add(allocation.id);
    const lot = lotById.get(allocation.lotId);
    if (!lot) errors.push(`تخصيص FIFO ${allocation.id}: دفعة المخزون غير موجودة.`);
    else if (lot.productId !== allocation.productId) errors.push(`تخصيص FIFO ${allocation.id}: الصنف لا يطابق دفعة المخزون.`);
    if (!allocation.invoiceId || !allocation.invoiceItemId || !allocation.productId ||
        !Number.isFinite(allocation.quantity) || allocation.quantity <= 0 ||
        !Number.isFinite(allocation.returnedQty) || allocation.returnedQty < 0 ||
        allocation.returnedQty > allocation.quantity + 1e-6 ||
        !Number.isFinite(allocation.unitCost) || allocation.unitCost < 0) {
      errors.push(`تخصيص FIFO ${allocation.id}: بيانات كمية أو تكلفة غير صالحة.`);
    }
  }
  return errors;
}

export function validateFifoLedger(products: Product[], lots: InventoryLot[]): string[] {
  const errors: string[] = [];
  const productMap = new Map(products.map(product => [product.id, product]));
  const byProduct = new Map<string, number>();
  for (const lot of lots) {
    const product = productMap.get(lot.productId);
    if (!product) errors.push(`دفعة ${lot.id}: الصنف غير موجود.`);
    if (!Number.isFinite(lot.originalQty) || lot.originalQty < 0 ||
        !Number.isFinite(lot.remainingQty) || lot.remainingQty < 0 ||
        lot.remainingQty > lot.originalQty + 1e-6 ||
        !Number.isFinite(lot.unitCost) || lot.unitCost < 0) {
      errors.push(`دفعة ${lot.id}: كمية أو تكلفة غير صالحة.`);
    }
    byProduct.set(lot.productId, (byProduct.get(lot.productId) || 0) + (Number(lot.remainingQty) || 0));
  }
  for (const product of products) {
    const stock = roundQty(Number(product.stockPieces) || 0);
    const ledgerStock = roundQty(byProduct.get(product.id) || 0);
    if (Math.abs(stock - ledgerStock) > 0.001) {
      errors.push(`الصنف ${product.name}: رصيد المخزون ${stock} لا يساوي رصيد الدفعات ${ledgerStock}.`);
    }
  }
  return errors;
}
