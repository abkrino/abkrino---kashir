import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { authSecurityService, hashPasswordWithPbkdf2 } from './authSecurityService';
import { snapshotService, CURRENT_SCHEMA_VERSION, computeDataChecksum } from './snapshotService';
import { calculateDailySummaryData } from './orgSyncService';
import { INITIAL_SHIFT } from '../data/initialData';
import {
  Customer,
  Product,
  SalesInvoice,
  User,
} from '../types';

const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
  });
}

describe('Sales Returns (مرتجعات المبيعات)', () => {
  let adminUser: User;
  let cashierWithReturns: User;
  let cashierNoReturns: User;
  let creditCustomer: Customer;
  let walkinCustomer: Customer;
  let testProduct: Product;
  let kgProduct: Product;

  const ADMIN_PASS = 'Adm!n#9482';
  const CASHIER_PASS = '4829';

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
    await storage.init();

    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(ADMIN_PASS);
    adminUser = {
      id: 'u-admin-ret',
      fullName: 'المدير العام للاختبار',
      username: 'admin_ret',
      role: 'ADMIN',
      pinHash: hashHex,
      pinSalt: saltHex,
      isActive: true,
      permissions: {
        canEditPrice: true,
        canGiveDiscount: true,
        canSellNegativeStock: true,
        canDeleteInvoice: true,
        canEditInvoice: true,
        canViewProfits: true,
        canManageProducts: true,
        canManagePurchases: true,
        canManageCash: true,
        canWithdrawNegativeCash: true,
        canProcessReturns: true,
      },
    };
    storage.setItem(STORAGE_KEYS.USERS, [adminUser]);

    const c1 = await authSecurityService.saveCashier(adminUser, {
      fullName: 'كاشير بصلاحية المرتجعات',
      username: 'cashier_ret',
      role: 'SALES',
      pin: CASHIER_PASS,
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
        canManageCash: true,
        canWithdrawNegativeCash: false,
        canProcessReturns: true,
      },
    });
    expect(c1.success).toBe(true);
    cashierWithReturns = c1.user!;

    const c2 = await authSecurityService.saveCashier(adminUser, {
      fullName: 'كاشير بدون صلاحية المرتجعات',
      username: 'cashier_noret',
      role: 'SALES',
      pin: CASHIER_PASS,
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
    expect(c2.success).toBe(true);
    cashierNoReturns = c2.user!;

    storage.setActiveUser(adminUser.id);

    testProduct = {
      id: 'prod-ret-1',
      code: '2001',
      barcode: '6221000002001',
      name: 'جبنة رومي قديمة',
      category: 'بقالة',
      brand: 'العلامة',
      baseUnit: 'قطعة',
      wholesaleUnit: 'كرتونة',
      piecesPerWholesaleUnit: 10,
      costPricePerBase: 20,
      costPricePerCarton: 200,
      retailPricePerBase: 30,
      wholesalePricePerCarton: 280,
      halfWholesalePricePerCarton: 290,
      stockPieces: 100,
      reorderLevelPieces: 10,
      isActive: true,
    };
    kgProduct = {
      id: 'prod-ret-kg',
      code: '2002',
      barcode: '6221000002002',
      name: 'زيتون مخلل',
      category: 'مخللات',
      brand: 'العلامة',
      baseUnit: 'كيلو',
      wholesaleUnit: 'صفيحة',
      piecesPerWholesaleUnit: 10,
      costPricePerBase: 40,
      costPricePerCarton: 400,
      retailPricePerBase: 60,
      wholesalePricePerCarton: 550,
      halfWholesalePricePerCarton: 580,
      stockPieces: 50,
      reorderLevelPieces: 5,
      isActive: true,
      isWeighing: true,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [testProduct, kgProduct]);

    creditCustomer = {
      id: 'cust-credit-1',
      code: 'C-101',
      name: 'سوبر ماركت الأمل',
      phone: '01011111111',
      area: 'وسط البلد',
      priceTier: 'RETAIL',
      creditLimit: 10000,
      currentBalance: 0,
      isCreditAllowed: true,
    };
    walkinCustomer = {
      id: 'c-cash',
      code: 'C-000',
      name: 'عميل نقدي مباشر',
      phone: '-',
      area: '-',
      priceTier: 'RETAIL',
      creditLimit: 0,
      currentBalance: 0,
      isCreditAllowed: false,
    };
    storage.setItem(STORAGE_KEYS.CUSTOMERS, [walkinCustomer, creditCustomer]);

    storage.setItem(STORAGE_KEYS.INVOICES, []);
    storage.setItem(STORAGE_KEYS.SALES_RETURNS, []);
    storage.setItem(STORAGE_KEYS.DOCUMENT_SEQUENCES, {});
    storage.setItem(STORAGE_KEYS.CASH_MOVEMENTS, []);
    storage.setItem(STORAGE_KEYS.AUDIT_LOGS, []);
    storage.saveCurrentShift({ ...INITIAL_SHIFT, status: 'OPEN' });
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
  });

  function postSampleInvoice(overrides?: Partial<SalesInvoice>): SalesInvoice {
    const today = new Date().toISOString().split('T')[0];
    const inv: SalesInvoice = {
      id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      invoiceNumber: storage.nextDocumentNumber('INV'),
      date: today,
      time: '11:00',
      customerId: walkinCustomer.id,
      customerName: walkinCustomer.name,
      customerPhone: walkinCustomer.phone,
      salespersonId: adminUser.id,
      salespersonName: adminUser.fullName,
      paymentType: 'CASH',
      items: [
        {
          id: 'line-1',
          productId: testProduct.id,
          productCode: testProduct.code,
          productName: testProduct.name,
          unit: 'PIECE',
          unitLabel: 'قطعة',
          quantity: 10,
          piecesCount: 10,
          unitPrice: 30,
          defaultUnitPrice: 30,
          costPrice: 20, // sale-time cost = 20
          totalPrice: 300,
          discount: 0,
          lineProfit: 100,
        },
        {
          id: 'line-2',
          productId: kgProduct.id,
          productCode: kgProduct.code,
          productName: kgProduct.name,
          unit: 'KG',
          unitLabel: 'كيلو',
          quantity: 2.5,
          piecesCount: 1, // simulates PosSales behavior on KG lines
          unitPrice: 60,
          defaultUnitPrice: 60,
          costPrice: 40,
          totalPrice: 150,
          discount: 0,
          lineProfit: 50,
        },
      ],
      subtotal: 450,
      discountType: 'AMOUNT',
      discountValue: 0,
      discountAmount: 0,
      total: 450,
      paidAmount: 450,
      remainingAmount: 0,
      previousCustomerBalance: 0,
      newCustomerBalance: 0,
      totalCost: 300,
      totalProfit: 150,
      status: 'POSTED',
      ...overrides,
    };
    const res = storage.postSalesInvoice(inv);
    expect(res.success).toBe(true);
    return inv;
  }

  it('blocks a sale that exceeds stock without changing stock, invoices, cash or customer balances', () => {
    const existing = postSampleInvoice();
    const stockBefore = storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces;
    const invoicesBefore = storage.getSalesInvoices().length;
    const cashBefore = storage.getCashMovements().length;
    const customersBefore = JSON.stringify(storage.getCustomers());

    const attempted: SalesInvoice = {
      ...existing,
      id: 'inv-overstock-attempt',
      invoiceNumber: 'INV-OVERSTOCK-ATTEMPT',
      items: existing.items.map((item, index) =>
        index === 0 ? { ...item, piecesCount: stockBefore + 1 } : item
      ),
    };

    const result = storage.postSalesInvoice(attempted);
    expect(result.success).toBe(false);
    expect(result.error).toContain('لا يمكن إتمام البيع');
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(stockBefore);
    expect(storage.getSalesInvoices()).toHaveLength(invoicesBefore);
    expect(storage.getCashMovements()).toHaveLength(cashBefore);
    expect(JSON.stringify(storage.getCustomers())).toBe(customersBefore);
  });

  it('aggregates duplicate invoice lines when checking available stock', () => {
    const existing = postSampleInvoice();
    const stockBefore = storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces;
    const attempted: SalesInvoice = {
      ...existing,
      id: 'inv-duplicate-lines-attempt',
      invoiceNumber: 'INV-DUPLICATE-LINES',
      items: [
        { ...existing.items[0], id: 'dup-1', piecesCount: stockBefore * 0.6 },
        { ...existing.items[0], id: 'dup-2', piecesCount: stockBefore * 0.6 },
      ],
    };

    const result = storage.postSalesInvoice(attempted);
    expect(result.success).toBe(false);
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(stockBefore);
  });

  it('blocks invoice edits that would make stock negative without reverting the old invoice first', () => {
    const first = postSampleInvoice();
    const second = postSampleInvoice();
    const stockBefore = storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces;
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());

    const edited: SalesInvoice = {
      ...first,
      items: first.items.map((item, index) =>
        index === 0 ? { ...item, piecesCount: stockBefore + item.piecesCount + 1 } : item
      ),
    };

    const result = storage.updateSalesInvoice(edited);
    expect(result.success).toBe(false);
    expect(result.error).toContain('لا يمكن تعديل الفاتورة');
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(stockBefore);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
    expect(storage.getSalesInvoices().some(invoice => invoice.id === second.id)).toBe(true);
  });

  it('reassigns an edited credit invoice debt from the old customer to the new customer', () => {
    const invoice = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      paymentType: 'CREDIT',
      paidAmount: 0,
      remainingAmount: 450,
    });
    expect(storage.getCustomers().find(c => c.id === creditCustomer.id)!.currentBalance).toBe(450);

    const edited: SalesInvoice = {
      ...invoice,
      customerId: walkinCustomer.id,
      customerName: walkinCustomer.name,
      remainingAmount: 450,
      paidAmount: 0,
    };
    const result = storage.updateSalesInvoice(edited);

    expect(result.success).toBe(true);
    expect(storage.getCustomers().find(c => c.id === creditCustomer.id)!.currentBalance).toBe(0);
    expect(storage.getCustomers().find(c => c.id === walkinCustomer.id)!.currentBalance).toBe(450);
    expect(storage.getSalesInvoices().find(i => i.id === invoice.id)!.customerId).toBe(walkinCustomer.id);
  });

  it('adjusts the same customer debt by the difference instead of reversing and re-adding the full debt', () => {
    const invoice = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      paymentType: 'CREDIT',
      paidAmount: 0,
      remainingAmount: 450,
    });
    const edited: SalesInvoice = { ...invoice, remainingAmount: 300, total: 300 };

    const result = storage.updateSalesInvoice(edited);

    expect(result.success).toBe(true);
    expect(storage.getCustomers().find(c => c.id === creditCustomer.id)!.currentBalance).toBe(300);
    expect(storage.getSalesInvoices().find(i => i.id === invoice.id)!.newCustomerBalance).toBe(300);
  });

  it('rejects an edited invoice with a missing customer without changing stock, balances, cash or invoice data', () => {
    const invoice = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      paymentType: 'CREDIT',
      paidAmount: 0,
      remainingAmount: 450,
    });
    const productsBefore = JSON.stringify(storage.getProducts());
    const customersBefore = JSON.stringify(storage.getCustomers());
    const cashBefore = JSON.stringify(storage.getCashMovements());
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());

    const result = storage.updateSalesInvoice({
      ...invoice,
      customerId: 'missing-customer',
      customerName: 'عميل غير موجود',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('العميل المحدد غير موجود');
    expect(JSON.stringify(storage.getProducts())).toBe(productsBefore);
    expect(JSON.stringify(storage.getCustomers())).toBe(customersBefore);
    expect(JSON.stringify(storage.getCashMovements())).toBe(cashBefore);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
  });

  it('reverses the previous collected amount and records the new amount when editing payment values', () => {
    const invoice = postSampleInvoice({
      paymentType: 'SPLIT',
      paidAmount: 100,
      remainingAmount: 350,
    });
    const cashBeforeEdit = storage.getCashMovements().filter(m => m.referenceId === invoice.invoiceNumber);
    expect(cashBeforeEdit.some(m => m.type === 'IN' && m.amount === 100)).toBe(true);

    const result = storage.updateSalesInvoice({
      ...invoice,
      paidAmount: 150,
      remainingAmount: 300,
    });

    expect(result.success).toBe(true);
    const movements = storage.getCashMovements().filter(m => m.referenceId === invoice.invoiceNumber);
    expect(movements.some(m => m.type === 'OUT' && m.category === 'INVOICE_REVERSAL' && m.amount === 100)).toBe(true);
    expect(movements.some(m => m.type === 'IN' && m.category === 'SALES_CASH' && m.amount === 150)).toBe(true);
  });

  it('blocks editing or deleting an invoice after a return has been registered', () => {
    const invoice = postSampleInvoice();
    const returned = storage.processSalesReturn({
      invoiceId: invoice.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 1 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: true,
      user: adminUser,
    });
    expect(returned.success).toBe(true);

    const productsBefore = JSON.stringify(storage.getProducts());
    const customersBefore = JSON.stringify(storage.getCustomers());
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());
    const returnsBefore = JSON.stringify(storage.getSalesReturns());

    const editResult = storage.updateSalesInvoice({ ...invoice, total: invoice.total + 10 });
    const deleteResult = storage.deleteSalesInvoice(invoice.id);

    expect(editResult.success).toBe(false);
    expect(editResult.error).toContain('لها مرتجعات مسجلة');
    expect(deleteResult.success).toBe(false);
    expect(deleteResult.error).toContain('لها مرتجعات مسجلة');
    expect(JSON.stringify(storage.getProducts())).toBe(productsBefore);
    expect(JSON.stringify(storage.getCustomers())).toBe(customersBefore);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
    expect(JSON.stringify(storage.getSalesReturns())).toBe(returnsBefore);
  });

  it('rejects negative stock through product editing and inventory adjustments', () => {
    const before = storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces;
    const edited = storage.saveProduct({ ...testProduct, stockPieces: -1 });
    expect(edited.success).toBe(false);
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(before);

    const adjustment = storage.recordStockAdjustment({
      productId: testProduct.id,
      differencePieces: -(before + 1),
      reason: 'CORRECTION',
      reasonArabic: 'اختبار منع الرصيد السالب',
      performedBy: adminUser.fullName,
    });
    expect(adjustment.success).toBe(false);
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(before);
    expect(storage.getStockAdjustments()).toHaveLength(0);
  });

  it('1. Enforces quantity cap (sold - previouslyReturned) and supports multiple partial returns up to FULL', () => {
    const inv = postSampleInvoice();
    const initialInvoiceSnapshot = JSON.stringify(storage.getSalesInvoices().find(i => i.id === inv.id));

    expect(storage.getInvoiceReturnSummary(inv).status).toBe('NONE');

    // First partial return: 4 PIECEs of product 1
    const r1 = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 4 }],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(r1.success).toBe(true);
    expect(r1.salesReturn?.returnNumber).toMatch(/^RET-\d{4}-00001$/);

    let summary = storage.getInvoiceReturnSummary(inv);
    expect(summary.status).toBe('PARTIAL');
    expect(summary.totalReturnedQty).toBe(4);
    expect(summary.returnedCount).toBe(1);

    // Attempt to exceed remaining quantity (10 - 4 = 6 left; asking 7)
    const over = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 7 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(over.success).toBe(false);
    expect(over.error).toContain('تتجاوز المتاح للاسترجاع (6)');

    // Second partial return returning exact remaining items (6 PIECEs + 2.5 KG) -> becomes FULL
    const r2 = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [
        { invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 6 },
        { invoiceItemId: 'line-2', productId: kgProduct.id, unit: 'KG', quantity: 2.5 },
      ],
      reason: 'EXPIRED',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(r2.success).toBe(true);
    expect(r2.salesReturn?.returnNumber).toMatch(/^RET-\d{4}-00002$/);

    summary = storage.getInvoiceReturnSummary(inv);
    expect(summary.status).toBe('FULL');
    expect(summary.totalReturnedAmount).toBe(450);

    // Original SalesInvoice MUST NOT be mutated or deleted
    const afterInvoiceSnapshot = JSON.stringify(storage.getSalesInvoices().find(i => i.id === inv.id));
    expect(afterInvoiceSnapshot).toBe(initialInvoiceSnapshot);
  });

  it('2. Restores stock ONLY when returnToStock is true; leaves stock untouched when false (damaged)', () => {
    const inv = postSampleInvoice();
    // Stock after invoice post: prod 1 = 100 - 10 = 90
    expect(storage.getProducts().find(p => p.id === testProduct.id)?.stockPieces).toBe(90);

    // Damaged return (returnToStock: false) for 3 pieces -> stock stays 90
    const damagedRes = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 3 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: false,
      user: cashierWithReturns,
    });
    expect(damagedRes.success).toBe(true);
    expect(storage.getProducts().find(p => p.id === testProduct.id)?.stockPieces).toBe(90);

    // Good condition return (returnToStock: true) for 5 pieces + 2.5 kg -> prod 1 = 95, kgProduct + 2.5
    const kgBefore = storage.getProducts().find(p => p.id === kgProduct.id)!.stockPieces;
    const goodRes = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [
        { invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 5 },
        { invoiceItemId: 'line-2', productId: kgProduct.id, unit: 'KG', quantity: 2.5 },
      ],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(goodRes.success).toBe(true);
    expect(storage.getProducts().find(p => p.id === testProduct.id)?.stockPieces).toBe(95);
    expect(storage.getProducts().find(p => p.id === kgProduct.id)?.stockPieces).toBe(kgBefore + 2.5);
  });

  it('rejects a restock return when its linked product is missing without changing financial or return records', () => {
    const inv = postSampleInvoice();
    storage.setItem(
      STORAGE_KEYS.PRODUCTS,
      storage.getProducts().filter(product => product.id !== testProduct.id)
    );

    const productsBefore = JSON.stringify(storage.getProducts());
    const customersBefore = JSON.stringify(storage.getCustomers());
    const cashBefore = JSON.stringify(storage.getCashMovements());
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());
    const returnsBefore = JSON.stringify(storage.getSalesReturns());
    const auditBefore = JSON.stringify(storage.getAuditLogs());

    const result = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 1 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: true,
      user: adminUser,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('الصنف المرتبط بالمرتجع غير موجود');
    expect(JSON.stringify(storage.getProducts())).toBe(productsBefore);
    expect(JSON.stringify(storage.getCustomers())).toBe(customersBefore);
    expect(JSON.stringify(storage.getCashMovements())).toBe(cashBefore);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
    expect(JSON.stringify(storage.getSalesReturns())).toBe(returnsBefore);
    expect(JSON.stringify(storage.getAuditLogs())).toBe(auditBefore);
  });

  it('3. CASH refund creates SALES_REFUND affecting drawer even in CAPITAL mode; CUSTOMER_CREDIT lowers customer debt without drawer outflow', async () => {
    // Credit invoice for creditCustomer: total 300, paid 0, remaining 300
    const creditInv = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      customerPhone: creditCustomer.phone,
      paymentType: 'CREDIT',
      items: [
        {
          id: 'line-c1',
          productId: testProduct.id,
          productCode: testProduct.code,
          productName: testProduct.name,
          unit: 'PIECE',
          unitLabel: 'قطعة',
          quantity: 10,
          piecesCount: 10,
          unitPrice: 30,
          defaultUnitPrice: 30,
          costPrice: 20,
          totalPrice: 300,
          discount: 0,
          lineProfit: 100,
        },
      ],
      subtotal: 300,
      total: 300,
      paidAmount: 0,
      remainingAmount: 300,
      totalCost: 200,
      totalProfit: 100,
    });
    expect(storage.getCustomers().find(c => c.id === creditCustomer.id)?.currentBalance).toBe(300);

    // Walk-in invoice rejects CUSTOMER_CREDIT refund
    const walkinInv = postSampleInvoice();
    const walkinCreditAttempt = storage.processSalesReturn({
      invoiceId: walkinInv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 1 }],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CUSTOMER_CREDIT',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(walkinCreditAttempt.success).toBe(false);

    // Credit invoice accepts CUSTOMER_CREDIT refund -> lowers customer balance, NO cash movement
    const movementsBefore = storage.getCashMovements().length;
    const custCredRes = storage.processSalesReturn({
      invoiceId: creditInv.id,
      items: [{ invoiceItemId: 'line-c1', productId: testProduct.id, unit: 'PIECE', quantity: 4 }],
      reason: 'WRONG_ITEM',
      refundMethod: 'CUSTOMER_CREDIT',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(custCredRes.success).toBe(true);
    expect(custCredRes.salesReturn?.totalAmount).toBe(120);
    expect(storage.getCustomers().find(c => c.id === creditCustomer.id)?.currentBalance).toBe(180);
    expect(storage.getCashMovements().length).toBe(movementsBefore);

    // Switch accountingMode to CAPITAL -> CASH sales refund MUST still affect drawer (affectsDrawer = true)
    const shift = storage.getCurrentShift();
    storage.saveCurrentShift({ ...shift, status: 'CLOSED' });
    const modeSwitch = await storage.setAccountingMode('CAPITAL', adminUser, ADMIN_PASS);
    expect(modeSwitch.success).toBe(true);

    const drawerBefore = storage.calculateCurrentCashInDrawer();
    expect(drawerBefore).toBe(450); // from walkinInv

    const cashRefundRes = storage.processSalesReturn({
      invoiceId: walkinInv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 5 }],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(cashRefundRes.success).toBe(true);
    expect(storage.calculateCurrentCashInDrawer()).toBe(300);
    const refundMove = storage.getCashMovements().find(m => m.category === 'SALES_REFUND');
    expect(refundMove).toBeDefined();
    expect(refundMove?.type).toBe('OUT');
    expect(refundMove?.affectsDrawer).toBe(true);
    expect(refundMove?.amount).toBe(150);
  });

  it('4. Blocks CASH refund when drawer is insufficient & suggests CUSTOMER_CREDIT; allows Admin negative drawer override', () => {
    // Credit invoice paid 0 -> drawer has 0 cash!
    const creditInv = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      customerPhone: creditCustomer.phone,
      paymentType: 'CREDIT',
      paidAmount: 0,
      remainingAmount: 450,
    });
    expect(storage.calculateCurrentCashInDrawer()).toBe(0);

    // Cashier without negative cash perm gets blocked with suggestion for CUSTOMER_CREDIT
    const blocked = storage.processSalesReturn({
      invoiceId: creditInv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 2 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: false,
      user: cashierWithReturns,
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('رصيد للعميل');
    expect(storage.getSalesReturns().length).toBe(0);

    // Admin overrides with fundingDetails
    const adminOverride = storage.processSalesReturn({
      invoiceId: creditInv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 2 }],
      reason: 'DAMAGED',
      refundMethod: 'CASH',
      returnToStock: false,
      user: adminUser,
      allowNegativeCash: true,
      fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة من صاحب العمل' },
    });
    expect(adminOverride.success).toBe(true);
    expect(storage.calculateCurrentCashInDrawer()).toBe(-60);
  });

  it('5. Enforces canProcessReturns permission, mandatory OTHER reason note, and logs AuditLog', () => {
    const inv = postSampleInvoice();

    // User without canProcessReturns is denied
    const deniedUser = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 1 }],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierNoReturns,
    });
    expect(deniedUser.success).toBe(false);
    expect(deniedUser.error).toContain('صلاحية');

    // OTHER without text note is denied
    const emptyOther = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 1 }],
      reason: 'OTHER',
      reasonNote: '   ',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(emptyOther.success).toBe(false);
    expect(emptyOther.error).toContain('أخرى');

    // Valid OTHER with text note succeeds & writes AuditLog
    const ok = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 2 }],
      reason: 'OTHER',
      reasonNote: 'تغليف غير مناسب للعميل',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(ok.success).toBe(true);
    const audit = storage.getAuditLogs().find(l => l.action === 'SALES_RETURN');
    expect(audit).toBeDefined();
    expect(audit?.entityId).toBe(ok.salesReturn?.returnNumber);
    expect(audit?.details).toContain('تغليف غير مناسب للعميل');
  });

  it('6. Preserves sale-time cost for profit reversal, deducts from daily summary, and preserves backup/legacy compatibility', async () => {
    const inv = postSampleInvoice(); // unitPrice: 30, costPrice: 20

    // Change current catalog product cost AFTER the invoice was posted!
    const prods = storage.getProducts();
    const p1 = prods.find(p => p.id === testProduct.id)!;
    p1.costPricePerBase = 29;
    storage.saveProduct(p1);

    // Return 3 pieces -> MUST reverse profit using sale-time cost (20), NOT new catalog cost (29)
    // Returned revenue = 3 * 30 = 90, Returned cost = 3 * 20 = 60, Profit reversed = 30
    const retRes = storage.processSalesReturn({
      invoiceId: inv.id,
      items: [{ invoiceItemId: 'line-1', productId: testProduct.id, unit: 'PIECE', quantity: 3 }],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: cashierWithReturns,
    });
    expect(retRes.success).toBe(true);
    expect(retRes.salesReturn?.totalAmount).toBe(90);
    expect(retRes.salesReturn?.totalCost).toBe(60);
    expect(retRes.salesReturn?.totalProfitReversed).toBe(30);

    // Daily summary deducts returns from salesTotal
    const cairoToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const daily = calculateDailySummaryData({
      invoices: storage.getSalesInvoices().map(i => ({ ...i, date: cairoToday })),
      purchases: [],
      products: storage.getProducts(),
      customers: storage.getCustomers(),
      suppliers: [],
      cashInDrawer: storage.calculateCurrentCashInDrawer(),
      cairoDateStr: cairoToday,
      salesReturns: storage.getSalesReturns().map(r => ({ ...r, date: cairoToday })),
    });
    expect(daily.salesTotal).toBe(360); // 450 - 90

    // Export package includes salesReturns and restores cleanly
    const pkg = await snapshotService.generateExportPackage();
    expect(pkg.data.salesReturns.length).toBe(1);
    expect(pkg.recordCounts.salesReturns).toBe(1);

    storage.setItem(STORAGE_KEYS.SALES_RETURNS, []);
    const restoredPkg = await snapshotService.restoreData(pkg);
    expect(restoredPkg.success).toBe(true);
    expect(storage.getSalesReturns().length).toBe(1);

    // Legacy backup without salesReturns STILL passes validation and restores with []
    const legacyData = {
      products: storage.getProducts(),
      customers: storage.getCustomers(),
      suppliers: [],
      invoices: storage.getSalesInvoices(),
      purchases: [],
      cashMovements: storage.getCashMovements(),
      expenses: [],
      auditLogs: storage.getAuditLogs(),
      stockAdjustments: [],
      currentShift: storage.getCurrentShift(),
      users: storage.getUsers(),
      parkedCarts: [],
    };
    const legacyChecksum = await computeDataChecksum(legacyData);
    const legacyPkg = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: '1.0.0',
      timestamp: new Date().toISOString(),
      recordCounts: {
        products: legacyData.products.length,
        customers: legacyData.customers.length,
        suppliers: 0,
        invoices: legacyData.invoices.length,
        purchases: 0,
        cashMovements: legacyData.cashMovements.length,
        expenses: 0,
        auditLogs: legacyData.auditLogs.length,
        stockAdjustments: 0,
        users: legacyData.users.length,
        parkedCarts: 0,
      },
      checksum: legacyChecksum,
      data: legacyData,
    };

    const validation = await snapshotService.validateBackup(legacyPkg);
    expect(validation.valid).toBe(true);

    const legacyRestore = await snapshotService.restoreData(legacyPkg);
    expect(legacyRestore.success).toBe(true);
    expect(storage.getSalesReturns()).toEqual([]);
  });

  it('blocks deleting a received purchase when removing its goods and bonus would make stock negative', () => {
    const product = { ...testProduct, stockPieces: 10 };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [product]);
    const purchase = {
      id: 'pur-over-delete',
      invoiceNumber: 'PUR-OVER-DELETE',
      date: new Date().toISOString().slice(0, 10),
      supplierId: 'supplier-test',
      supplierName: 'مورد اختبار',
      supplierType: 'WHOLESALER',
      items: [{ productId: product.id, productName: product.name, quantity: 5, unit: 'PIECE' }],
      subtotal: 100,
      discountAmount: 0,
      freightCost: 0,
      bonusType: 'GOODS',
      bonusGoodsQuantity: 1,
      totalCost: 100,
      paidAmount: 0,
      remainingAmount: 0,
      paymentType: 'CASH',
      previousSupplierBalance: 0,
      newSupplierBalance: 0,
      isStockInserted: true,
    };
    storage.setItem(STORAGE_KEYS.PURCHASES, [purchase]);

    const result = storage.deletePurchaseInvoice(purchase.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('لا يمكن حذف فاتورة الشراء');
    expect(storage.getProducts().find(p => p.id === product.id)?.stockPieces).toBe(10);
    expect(storage.getPurchases()).toHaveLength(1);
  });

  it('deletes a received purchase only when stock can cover its goods and bonus', () => {
    const product = { ...testProduct, stockPieces: 100 };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [product]);
    const purchase = {
      id: 'pur-safe-delete',
      invoiceNumber: 'PUR-SAFE-DELETE',
      date: new Date().toISOString().slice(0, 10),
      supplierId: 'supplier-test',
      supplierName: 'مورد اختبار',
      supplierType: 'WHOLESALER',
      items: [{ productId: product.id, productName: product.name, quantity: 5, unit: 'PIECE' }],
      subtotal: 100,
      discountAmount: 0,
      freightCost: 0,
      bonusType: 'GOODS',
      bonusGoodsQuantity: 1,
      totalCost: 100,
      paidAmount: 0,
      remainingAmount: 0,
      paymentType: 'CASH',
      previousSupplierBalance: 0,
      newSupplierBalance: 0,
      isStockInserted: true,
    };
    storage.setItem(STORAGE_KEYS.PURCHASES, [purchase]);

    const result = storage.deletePurchaseInvoice(purchase.id);

    expect(result.success).toBe(true);
    expect(storage.getProducts().find(p => p.id === product.id)?.stockPieces).toBe(85);
    expect(storage.getPurchases()).toHaveLength(0);
  });


  it('refuses to delete a received purchase when its linked product is missing without deleting the purchase', () => {
    const product = { ...testProduct, stockPieces: 50 };
    const purchase = {
      id: 'pur-missing-product',
      invoiceNumber: 'PUR-MISSING-PRODUCT',
      date: new Date().toISOString().slice(0, 10),
      supplierId: 'supplier-test',
      supplierName: 'مورد اختبار',
      supplierType: 'WHOLESALER',
      items: [{ productId: product.id, productName: product.name, quantity: 5, unit: 'PIECE' }],
      subtotal: 100, discountAmount: 0, freightCost: 0, bonusType: 'NONE',
      bonusGoodsQuantity: 0, totalCost: 100, paidAmount: 0, remainingAmount: 0,
      paymentType: 'CASH', previousSupplierBalance: 0, newSupplierBalance: 0,
      isStockInserted: true,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, []);
    storage.setItem(STORAGE_KEYS.PURCHASES, [purchase]);
    const result = storage.deletePurchaseInvoice(purchase.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('الصنف المرتبط بها غير موجود');
    expect(storage.getPurchases()).toHaveLength(1);
    expect(storage.getProducts()).toHaveLength(0);
  });

  it('refuses to delete a credit purchase when its supplier record is missing without changing stock', () => {
    const product = { ...testProduct, stockPieces: 50 };
    const purchase = {
      id: 'pur-missing-supplier',
      invoiceNumber: 'PUR-MISSING-SUPPLIER',
      date: new Date().toISOString().slice(0, 10),
      supplierId: 'supplier-that-does-not-exist',
      supplierName: 'مورد مفقود',
      supplierType: 'WHOLESALER',
      items: [{ productId: product.id, productName: product.name, quantity: 5, unit: 'PIECE' }],
      subtotal: 100, discountAmount: 0, freightCost: 0, bonusCost: 0,
      bonusType: 'NONE', bonusGoodsQuantity: 0, totalCost: 100,
      paidAmount: 0, remainingAmount: 75, paymentType: 'CREDIT',
      previousSupplierBalance: 0, newSupplierBalance: 75, isStockInserted: true,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [product]);
    storage.setItem(STORAGE_KEYS.SUPPLIERS, []);
    storage.setItem(STORAGE_KEYS.PURCHASES, [purchase]);
    const stockBefore = storage.getProducts()[0].stockPieces;
    const result = storage.deletePurchaseInvoice(purchase.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('المورد المرتبط بها غير موجود');
    expect(storage.getProducts()[0].stockPieces).toBe(stockBefore);
    expect(storage.getPurchases()).toHaveLength(1);
  });

  it('rejects negative or zero purchase quantities before posting stock or financial records', () => {
    const product = { ...testProduct, stockPieces: 10 };
    const supplier = {
      id: 'supplier-invalid-purchase',
      code: 'SUP-TEST',
      name: 'مورد اختبار',
      type: 'WHOLESALER' as const,
      phone: '',
      contactPerson: '',
      currentBalance: 0,
      paymentTermsDays: 0,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [product]);
    storage.setItem(STORAGE_KEYS.SUPPLIERS, [supplier]);
    const purchase = {
      id: 'pur-invalid-quantity',
      invoiceNumber: 'PUR-INVALID-QUANTITY',
      date: new Date().toISOString().slice(0, 10),
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierType: 'WHOLESALER' as const,
      items: [{
        productId: product.id,
        productName: product.name,
        unit: 'PIECE' as const,
        quantity: -5,
        unitCost: 20,
        totalCost: -100,
      }],
      subtotal: -100,
      discountAmount: 0,
      freightCost: 0,
      totalCost: -100,
      paidAmount: 0,
      remainingAmount: 0,
      paymentType: 'CASH' as const,
      previousSupplierBalance: 0,
      newSupplierBalance: 0,
      isStockInserted: true,
    };

    const result = storage.postPurchaseInvoice(purchase);

    expect(result.success).toBe(false);
    expect(result.error).toContain('كمية الشراء غير صالحة');
    expect(storage.getProducts().find(p => p.id === product.id)?.stockPieces).toBe(10);
    expect(storage.getSuppliers()[0].currentBalance).toBe(0);
    expect(storage.getPurchases()).toHaveLength(0);
    expect(storage.getCashMovements()).toHaveLength(0);
  });

  it('rejects invalid legacy purchase quantities when inserting a draft into stock', () => {
    const product = { ...testProduct, stockPieces: 10 };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [product]);
    const purchase = {
      id: 'pur-invalid-draft',
      invoiceNumber: 'PUR-INVALID-DRAFT',
      date: new Date().toISOString().slice(0, 10),
      supplierId: 'supplier-test',
      supplierName: 'مورد اختبار',
      supplierType: 'WHOLESALER' as const,
      items: [{
        productId: product.id,
        productName: product.name,
        unit: 'PIECE' as const,
        quantity: -3,
        unitCost: 20,
        totalCost: -60,
      }],
      subtotal: -60,
      discountAmount: 0,
      freightCost: 0,
      totalCost: -60,
      paidAmount: 0,
      remainingAmount: 0,
      paymentType: 'CASH' as const,
      previousSupplierBalance: 0,
      newSupplierBalance: 0,
      isStockInserted: false,
    };
    storage.setItem(STORAGE_KEYS.PURCHASES, [purchase]);

    const result = storage.insertPurchaseIntoStock(purchase.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('كمية الإدراج غير صالحة');
    expect(storage.getProducts().find(p => p.id === product.id)?.stockPieces).toBe(10);
    expect(storage.getPurchases()[0].isStockInserted).toBe(false);
  });


  it('refuses to delete a sales invoice when one of its products is missing, without changing records', () => {
    const invoice = postSampleInvoice();
    const productsBefore = JSON.stringify(storage.getProducts());
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());
    const cashBefore = JSON.stringify(storage.getCashMovements());

    storage.setItem(STORAGE_KEYS.PRODUCTS, storage.getProducts().filter(p => p.id !== testProduct.id));
    const productsAfterRemovingReference = JSON.stringify(storage.getProducts());
    const result = storage.deleteSalesInvoice(invoice.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('الصنف المرتبط بها غير موجود');
    expect(JSON.stringify(storage.getProducts())).toBe(productsAfterRemovingReference);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
    expect(JSON.stringify(storage.getCashMovements())).toBe(cashBefore);
    expect(productsBefore).not.toBe(productsAfterRemovingReference);
  });

  it('refuses to delete a credit invoice when its customer record is missing, without restoring stock or removing the invoice', () => {
    const invoice = postSampleInvoice({
      customerId: creditCustomer.id,
      customerName: creditCustomer.name,
      paymentType: 'CREDIT',
      paidAmount: 0,
      remainingAmount: 450,
    });
    const stockBefore = storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces;
    const invoicesBefore = JSON.stringify(storage.getSalesInvoices());
    storage.setItem(STORAGE_KEYS.CUSTOMERS, storage.getCustomers().filter(c => c.id !== creditCustomer.id));

    const result = storage.deleteSalesInvoice(invoice.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('العميل المرتبط بها غير موجود');
    expect(storage.getProducts().find(p => p.id === testProduct.id)!.stockPieces).toBe(stockBefore);
    expect(JSON.stringify(storage.getSalesInvoices())).toBe(invoicesBefore);
  });

});
