import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS } from './storageService';
import { authSecurityService, hashPasswordWithPbkdf2 } from './authSecurityService';
import { snapshotService, CURRENT_SCHEMA_VERSION, computeDataChecksum } from './snapshotService';
import { INITIAL_SHIFT } from '../data/initialData';
import {
  DEFAULT_FUNDING_SOURCES,
  Product,
  PurchaseInvoice,
  Supplier,
  User,
} from '../types';

// Mock localStorage for node test environment
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

describe('Accounting Modes, Unified evaluateCashOut & Structured Funding Sources', () => {
  let adminUser: User;
  let cashierUser: User;
  let cashierWithNegPerm: User;
  let testSupplier: Supplier;
  let testProduct: Product;

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

    // Bootstrap Admin directly with PBKDF2 pinHash / pinSalt
    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(ADMIN_PASS);
    adminUser = {
      id: 'u-admin-1',
      fullName: 'المدير العام للاختبار',
      username: 'admin_test',
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
      },
    };
    storage.setItem(STORAGE_KEYS.USERS, [adminUser]);

    const c1 = await authSecurityService.saveCashier(adminUser, {
      fullName: 'كاشير عادي',
      username: 'cashier_1',
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
        canManagePurchases: true,
        canManageCash: true,
        canWithdrawNegativeCash: false,
      },
    });
    expect(c1.success).toBe(true);
    cashierUser = c1.user!;

    const c2 = await authSecurityService.saveCashier(adminUser, {
      fullName: 'كاشير بصلاحية السحب بالسالب',
      username: 'cashier_neg',
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
        canManagePurchases: true,
        canManageCash: true,
        canWithdrawNegativeCash: true,
      },
    });
    expect(c2.success).toBe(true);
    cashierWithNegPerm = c2.user!;

    storage.setActiveUser(adminUser.id);

    // Seed clean product & supplier matching strict TypeScript interfaces
    testProduct = {
      id: 'prod-1',
      code: '1001',
      barcode: '6221000001001',
      name: 'صنف اختباري',
      category: 'بقالة',
      brand: 'شركة التجربة',
      baseUnit: 'قطعة',
      wholesaleUnit: 'كرتونة',
      piecesPerWholesaleUnit: 12,
      costPricePerBase: 10,
      costPricePerCarton: 120,
      retailPricePerBase: 15,
      wholesalePricePerCarton: 150,
      halfWholesalePricePerCarton: 160,
      stockPieces: 100,
      reorderLevelPieces: 10,
      isActive: true,
    };
    storage.saveProduct(testProduct);

    testSupplier = {
      id: 'supp-1',
      code: 'SUP-01',
      name: 'مورد التجربة',
      type: 'WHOLESALER',
      phone: '01000000001',
      contactPerson: 'مسؤول التوريد',
      currentBalance: 5000,
      paymentTermsDays: 14,
    };
    storage.saveSupplier(testSupplier);

    // Clean ledger & closed shift default state
    storage.setItem(STORAGE_KEYS.CASH_MOVEMENTS, []);
    storage.setItem(STORAGE_KEYS.EXPENSES, []);
    storage.setItem(STORAGE_KEYS.PURCHASES, []);
    storage.saveCurrentShift({ ...INITIAL_SHIFT, status: 'OPEN' });
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
  });

  function seedDrawerCash(amount: number, dateStr?: string) {
    const today = dateStr || new Date().toISOString().split('T')[0];
    storage.addCashMovement(
      {
        id: `cm-seed-${Math.random().toString(36).slice(2, 7)}`,
        date: today,
        time: '09:00',
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'مبيعات نقدية',
        amount,
        description: 'مبيعات اختبارية',
        performedBy: adminUser.fullName,
        affectsDrawer: true,
      },
      { skipCashOutCheck: true }
    );
  }

  function makePurchaseInvoice(paidAmount: number, totalAmount = 1000): PurchaseInvoice {
    return {
      id: `pur-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      invoiceNumber: `PUR-${Date.now().toString().slice(-5)}`,
      date: new Date().toISOString().split('T')[0],
      time: '10:00',
      supplierId: testSupplier.id,
      supplierName: testSupplier.name,
      supplierType: testSupplier.type,
      items: [
        {
          productId: testProduct.id,
          productName: testProduct.name,
          unit: 'CARTON',
          quantity: 1,
          unitCost: totalAmount,
          totalCost: totalAmount,
        },
      ],
      subtotal: totalAmount,
      discountAmount: 0,
      freightCost: 0,
      totalCost: totalAmount,
      paidAmount,
      remainingAmount: Math.max(0, totalAmount - paidAmount),
      paymentType: paidAmount >= totalAmount ? 'CASH' : 'CREDIT',
      previousSupplierBalance: testSupplier.currentBalance,
      newSupplierBalance: testSupplier.currentBalance + Math.max(0, totalAmount - paidAmount),
      isStockInserted: true,
      notes: 'فاتورة شراء اختبارية',
    };
  }

  it('defaults to DAILY_DRAWER and structured DEFAULT_FUNDING_SOURCES', () => {
    expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');
    const sources = storage.getFundingSources();
    expect(sources.length).toBeGreaterThanOrEqual(DEFAULT_FUNDING_SOURCES.length);
    expect(sources.map(s => s.type)).toEqual(
      expect.arrayContaining(['DRAWER', 'OWNER_LOAN', 'CUSTODY', 'EXTERNAL_FUNDING', 'DRAWER_NEGATIVE', 'OTHER'])
    );
  });

  describe('1. DAILY_DRAWER mode across all 4 cash-out points', () => {
    beforeEach(() => {
      seedDrawerCash(1000);
    });

    it('allows all 4 cash-out operations when drawer covers the amount', () => {
      expect(storage.evaluateCashOut(200, { user: cashierUser }).allowed).toBe(true);

      // 1) Supplier payment (200)
      const supRes = storage.recordSupplierPayment({
        supplierId: testSupplier.id,
        amount: 200,
        paidBy: cashierUser.fullName,
        user: cashierUser,
      });
      expect(supRes.success).toBe(true);

      // 2) Expense (200)
      const expRes = storage.recordExpense(
        {
          id: 'exp-1',
          date: new Date().toISOString().split('T')[0],
          category: 'RENT',
          categoryLabelArabic: 'إيجار',
          amount: 200,
          notes: 'دفعة إيجار',
          recordedBy: cashierUser.fullName,
        },
        { user: cashierUser }
      );
      expect(expRes.success).toBe(true);

      // 3) Purchase cash payment (200)
      const purRes = storage.postPurchaseInvoice(makePurchaseInvoice(200, 500), {
        user: cashierUser,
      });
      expect(purRes.success).toBe(true);

      // 4) Manual withdrawal (200)
      const wdRes = storage.recordManualWithdrawal({
        amount: 200,
        description: 'سحب توريد بنك',
        performedBy: cashierUser.fullName,
        user: cashierUser,
      });
      expect(wdRes.success).toBe(true);

      expect(storage.calculateCurrentCashInDrawer()).toBe(200);
    });

    it('blocks cashier (without canWithdrawNegativeCash) at all 4 cash-out points when insufficient', () => {
      const ev = storage.evaluateCashOut(1500, {
        user: cashierUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة من صاحب العمل' },
      });
      expect(ev.allowed).toBe(false);
      expect(ev.requiresFundingSource).toBe(true);

      // 1) Supplier payment blocked without touching supplier debt
      const supRes = storage.recordSupplierPayment({
        supplierId: testSupplier.id,
        amount: 1500,
        paidBy: cashierUser.fullName,
        user: cashierUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة' },
      });
      expect(supRes.success).toBe(false);
      expect(storage.getSuppliers()[0].currentBalance).toBe(5000);

      // 2) Expense blocked without adding expense
      const expRes = storage.recordExpense(
        {
          id: 'exp-fail',
          date: new Date().toISOString().split('T')[0],
          category: 'ELECTRICITY',
          categoryLabelArabic: 'كهرباء',
          amount: 1500,
          notes: 'فاتورة كهرباء',
          recordedBy: cashierUser.fullName,
        },
        {
          user: cashierUser,
          allowNegativeCash: true,
          fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة' },
        }
      );
      expect(expRes.success).toBe(false);
      expect(storage.getExpenses().length).toBe(0);

      // 3) Purchase cash payment blocked without touching stock or purchases
      const purRes = storage.postPurchaseInvoice(makePurchaseInvoice(1500, 1500), {
        user: cashierUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة' },
      });
      expect(purRes.success).toBe(false);
      expect(storage.getPurchases().length).toBe(0);
      expect(storage.getProducts()[0].stockPieces).toBe(100);

      // 4) Manual withdrawal & direct addCashMovement blocked
      const wdRes = storage.recordManualWithdrawal({
        amount: 1500,
        description: 'محاولة سحب',
        performedBy: cashierUser.fullName,
        user: cashierUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'DRAWER_NEGATIVE', label: 'سحب بالسالب' },
      });
      expect(wdRes.success).toBe(false);

      const directOut = storage.addCashMovement(
        {
          id: 'cm-bad',
          date: new Date().toISOString().split('T')[0],
          time: '11:00',
          type: 'OUT',
          category: 'DRAWER_ADJUSTMENT',
          categoryLabelArabic: 'سحب',
          amount: 1500,
          description: 'سحب مباشر',
          performedBy: cashierUser.fullName,
        },
        { user: cashierUser }
      );
      expect(directOut.success).toBe(false);
      expect(storage.calculateCurrentCashInDrawer()).toBe(1000);
    });

    it('allows admin or cashier with canWithdrawNegativeCash + structured fundingDetails', () => {
      // Cashier with negative perm succeeds on supplier payment
      const res1 = storage.recordSupplierPayment({
        supplierId: testSupplier.id,
        amount: 1500,
        paidBy: cashierWithNegPerm.fullName,
        user: cashierWithNegPerm,
        allowNegativeCash: true,
        fundingDetails: { type: 'CUSTODY', label: 'عهدة المدير' },
      });
      expect(res1.success).toBe(true);
      expect(storage.calculateCurrentCashInDrawer()).toBe(-500);

      const lastCm = storage.getCashMovements()[0];
      expect(lastCm.fundingDetails?.type).toBe('CUSTODY');
      expect(lastCm.fundingDetails?.label).toBe('عهدة المدير');

      // Admin succeeds on remaining cash-out points too
      const expRes = storage.recordExpense(
        {
          id: 'exp-admin',
          date: new Date().toISOString().split('T')[0],
          category: 'OTHER',
          categoryLabelArabic: 'أخرى',
          amount: 300,
          notes: 'صيانة',
          recordedBy: adminUser.fullName,
        },
        {
          user: adminUser,
          allowNegativeCash: true,
          fundingDetails: { type: 'OWNER_LOAN', label: 'سلفة من صاحب العمل' },
        }
      );
      expect(expRes.success).toBe(true);
    });
  });

  describe('2. MONTHLY_POOL mode across all 4 cash-out points', () => {
    beforeEach(async () => {
      const shift = storage.getCurrentShift();
      storage.saveCurrentShift({ ...shift, status: 'CLOSED' });
      const sw = await storage.setAccountingMode('MONTHLY_POOL', adminUser, ADMIN_PASS);
      expect(sw.success).toBe(true);
    });

    it('uses net current-month inflows instead of moment drawer balance and ignores prior month / OPENING_BALANCE', () => {
      const now = new Date();
      const thisMonthDate = now.toISOString().split('T')[0];
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      const prevMonthDate = prevMonth.toISOString().split('T')[0];

      // Add OPENING_BALANCE this month (2000) -> MUST be excluded from monthly pool
      storage.addCashMovement(
        {
          id: 'cm-open',
          date: thisMonthDate,
          time: '08:00',
          type: 'IN',
          category: 'OPENING_BALANCE',
          categoryLabelArabic: 'رصيد افتتاحي',
          amount: 2000,
          description: 'افتتاح',
          performedBy: adminUser.fullName,
        },
        { skipCashOutCheck: true }
      );

      // Prior-month outflow (-3500 bank transfer) + current-month cash sales (+5000) - current-month expense (-1000)
      storage.setItem(STORAGE_KEYS.CASH_MOVEMENTS, [
        {
          id: 'cm-open-adj',
          date: prevMonthDate,
          time: '08:00',
          type: 'OUT',
          category: 'DRAWER_ADJUSTMENT',
          categoryLabelArabic: 'توريد سابق للبنك',
          amount: 3500,
          description: 'ترحيل شهر سابق',
          performedBy: adminUser.fullName,
        },
        {
          id: 'cm-m1',
          date: thisMonthDate,
          time: '10:00',
          type: 'IN',
          category: 'SALES_CASH',
          categoryLabelArabic: 'مبيعات نقدية',
          amount: 5000,
          description: 'مبيعات الشهر',
          performedBy: adminUser.fullName,
        },
        {
          id: 'cm-m2',
          date: thisMonthDate,
          time: '11:00',
          type: 'OUT',
          category: 'EXPENSE',
          categoryLabelArabic: 'مصروف',
          amount: 1000,
          description: 'مصروف الشهر',
          performedBy: adminUser.fullName,
        },
      ]);

      // Moment drawer = 500, Monthly pool = 4000
      expect(storage.calculateCurrentCashInDrawer()).toBe(500);
      expect(storage.calculateMonthlyPoolAvailable()).toBe(4000);

      // Cashier CAN spend 900 at each of the 4 points (total 3600 <= 4000) despite drawer having only 500!
      expect(storage.evaluateCashOut(900, { user: cashierUser }).allowed).toBe(true);

      expect(
        storage.recordSupplierPayment({
          supplierId: testSupplier.id,
          amount: 900,
          paidBy: cashierUser.fullName,
          user: cashierUser,
        }).success
      ).toBe(true);

      expect(
        storage.recordExpense(
          {
            id: 'exp-pool',
            date: thisMonthDate,
            category: 'ELECTRICITY',
            categoryLabelArabic: 'كهرباء',
            amount: 900,
            notes: 'كهرباء',
            recordedBy: cashierUser.fullName,
          },
          { user: cashierUser }
        ).success
      ).toBe(true);

      expect(
        storage.postPurchaseInvoice(makePurchaseInvoice(900, 1000), { user: cashierUser }).success
      ).toBe(true);

      expect(
        storage.recordManualWithdrawal({
          amount: 900,
          description: 'سحب',
          performedBy: cashierUser.fullName,
          user: cashierUser,
        }).success
      ).toBe(true);

      // Remaining pool = 4000 - 3600 = 400
      expect(storage.calculateMonthlyPoolAvailable()).toBe(400);

      // Spending 500 (> 400 pool remaining) is blocked for cashier
      expect(
        storage.recordSupplierPayment({
          supplierId: testSupplier.id,
          amount: 500,
          paidBy: cashierUser.fullName,
          user: cashierUser,
        }).success
      ).toBe(false);
    });
  });

  describe('3. CAPITAL mode: no coverage check, affectsDrawer=false, CAPITAL_INJECTION non-revenue', () => {
    beforeEach(async () => {
      seedDrawerCash(1000);
      const shift = storage.getCurrentShift();
      storage.saveCurrentShift({ ...shift, status: 'CLOSED' });
      const sw = await storage.setAccountingMode('CAPITAL', adminUser, ADMIN_PASS);
      expect(sw.success).toBe(true);
    });

    it('never restricts cash-outs, sets affectsDrawer=false across all 4 points, and isolates CAPITAL_INJECTION', () => {
      expect(storage.calculateCurrentCashInDrawer()).toBe(1000);

      const ev = storage.evaluateCashOut(999999, { user: cashierUser });
      expect(ev.allowed).toBe(true);
      expect(ev.requiresFundingSource).toBe(false);
      expect(ev.mode).toBe('CAPITAL');

      // 1) Supplier payment
      expect(
        storage.recordSupplierPayment({
          supplierId: testSupplier.id,
          amount: 2000,
          paidBy: cashierUser.fullName,
          user: cashierUser,
        }).success
      ).toBe(true);

      // 2) Expense
      expect(
        storage.recordExpense(
          {
            id: 'exp-cap',
            date: new Date().toISOString().split('T')[0],
            category: 'RENT',
            categoryLabelArabic: 'إيجار',
            amount: 5000,
            notes: 'إيجار رأس مال',
            recordedBy: cashierUser.fullName,
          },
          { user: cashierUser }
        ).success
      ).toBe(true);

      // 3) Purchase cash invoice
      const pur = makePurchaseInvoice(8000, 8000);
      expect(storage.postPurchaseInvoice(pur, { user: cashierUser }).success).toBe(true);

      // 4) Manual withdrawal
      expect(
        storage.recordManualWithdrawal({
          amount: 1500,
          description: 'سحب من رأس المال',
          performedBy: cashierUser.fullName,
          user: cashierUser,
        }).success
      ).toBe(true);

      // 5) Capital injection (separate non-revenue, non-profit movement)
      const inj = storage.recordCapitalInjection({
        amount: 50000,
        description: 'زيادة رأس مال',
        performedBy: adminUser.fullName,
        user: adminUser,
      });
      expect(inj.success).toBe(true);

      const movements = storage.getCashMovements();
      const capInj = movements.find(m => m.category === 'CAPITAL_INJECTION');
      expect(capInj).toBeDefined();
      expect(capInj?.type).toBe('IN');
      expect(capInj?.affectsDrawer).toBe(false);

      // All 4 cash-out movements have affectsDrawer === false
      const outMovements = movements.filter(m => m.type === 'OUT');
      expect(outMovements.length).toBe(4);
      expect(outMovements.every(m => m.affectsDrawer === false)).toBe(true);

      // Drawer cash MUST remain untouched at 1000!
      expect(storage.calculateCurrentCashInDrawer()).toBe(1000);

      // Monthly pool also excludes CAPITAL_INJECTION & affectsDrawer=false movements
      expect(storage.calculateMonthlyPoolAvailable()).toBe(1000);

      // Sales invoices remain empty so revenue & gross profit are zero (CAPITAL_INJECTION is NOT revenue)
      expect(storage.getSalesInvoices().length).toBe(0);
    });
  });

  describe('4. Structured Funding Source validation & management', () => {
    beforeEach(() => {
      seedDrawerCash(500);
    });

    it('rejects OTHER funding source without mandatory note text in service layer across all points', () => {
      const emptyOther = { type: 'OTHER' as const, label: 'أخرى', note: '   ' };

      // Rejected directly in evaluateCashOut even when funds suffice
      const ev = storage.evaluateCashOut(100, {
        user: adminUser,
        fundingDetails: emptyOther,
      });
      expect(ev.allowed).toBe(false);
      expect(ev.reason).toContain('توضيح مصدر التمويل');

      // Rejected at all 4 service methods
      expect(
        storage.recordSupplierPayment({
          supplierId: testSupplier.id,
          amount: 100,
          paidBy: adminUser.fullName,
          user: adminUser,
          allowNegativeCash: true,
          fundingDetails: emptyOther,
        }).success
      ).toBe(false);

      expect(
        storage.recordExpense(
          {
            id: 'exp-other-fail',
            date: new Date().toISOString().split('T')[0],
            category: 'OTHER',
            categoryLabelArabic: 'أخرى',
            amount: 100,
            notes: 'نثريات',
            recordedBy: adminUser.fullName,
          },
          { user: adminUser, allowNegativeCash: true, fundingDetails: emptyOther }
        ).success
      ).toBe(false);

      expect(
        storage.postPurchaseInvoice(makePurchaseInvoice(100, 100), {
          user: adminUser,
          allowNegativeCash: true,
          fundingDetails: emptyOther,
        }).success
      ).toBe(false);

      expect(
        storage.recordManualWithdrawal({
          amount: 100,
          description: 'سحب',
          performedBy: adminUser.fullName,
          user: adminUser,
          allowNegativeCash: true,
          fundingDetails: emptyOther,
        }).success
      ).toBe(false);

      // Valid OTHER with text succeeds
      const validRes = storage.recordSupplierPayment({
        supplierId: testSupplier.id,
        amount: 800,
        paidBy: adminUser.fullName,
        user: adminUser,
        allowNegativeCash: true,
        fundingDetails: {
          type: 'OTHER',
          label: 'أخرى',
          note: 'دفع من حساب شريك المحل البنكي',
        },
      });
      expect(validRes.success).toBe(true);
      const savedCm = storage.getCashMovements()[0];
      expect(savedCm.fundingDetails?.type).toBe('OTHER');
      expect(savedCm.fundingDetails?.note).toBe('دفع من حساب شريك المحل البنكي');
    });

    it('lets ADMIN add and toggle funding sources while blocking cashiers', () => {
      const denied = storage.addFundingSource(cashierUser, {
        type: 'EXTERNAL_FUNDING',
        label: 'محفظة تجريبية',
      });
      expect(denied.success).toBe(false);

      const added = storage.addFundingSource(adminUser, {
        type: 'EXTERNAL_FUNDING',
        label: 'حساب بنكي فرعي',
        note: 'البنك الأهلي',
      });
      expect(added.success).toBe(true);
      expect(added.source?.isActive).toBe(true);

      const toggleDenied = storage.toggleFundingSource(cashierUser, added.source!.id);
      expect(toggleDenied.success).toBe(false);

      const toggled = storage.toggleFundingSource(adminUser, added.source!.id);
      expect(toggled.success).toBe(true);
      expect(toggled.source?.isActive).toBe(false);
      expect(storage.getActiveFundingSources().some(s => s.id === added.source!.id)).toBe(false);
    });
  });

  describe('5. Switching accountingMode security, shift gate & history preservation', () => {
    it('blocks switching when shift is OPEN, when user is non-admin, or when password is invalid', async () => {
      const shift = storage.getCurrentShift();
      expect(shift.status).toBe('OPEN');

      // 1) Open shift -> rejected even with valid admin + password
      const openFail = await storage.setAccountingMode('CAPITAL', adminUser, ADMIN_PASS);
      expect(openFail.success).toBe(false);
      expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');

      // Close shift now
      storage.saveCurrentShift({ ...shift, status: 'CLOSED' });

      // 2) Cashier -> rejected
      const cashierFail = await storage.setAccountingMode('CAPITAL', cashierUser, CASHIER_PASS);
      expect(cashierFail.success).toBe(false);
      expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');

      // 3) Admin with wrong password -> rejected
      const wrongPassFail = await storage.setAccountingMode('CAPITAL', adminUser, 'wrong-password');
      expect(wrongPassFail.success).toBe(false);
      expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');

      // 4) Admin with empty password -> rejected
      const emptyPassFail = await storage.setAccountingMode('CAPITAL', adminUser, '');
      expect(emptyPassFail.success).toBe(false);
      expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');
    });

    it('switches mode with closed shift + valid admin password, logs AuditLog, and keeps historical movements untouched', async () => {
      seedDrawerCash(1500);
      const historicalPurchase = makePurchaseInvoice(500, 500);
      storage.postPurchaseInvoice(historicalPurchase, { user: adminUser });
      const snapshotBeforeSwitch = JSON.stringify(storage.getCashMovements());

      const shift = storage.getCurrentShift();
      storage.saveCurrentShift({ ...shift, status: 'CLOSED' });

      const ok = await storage.setAccountingMode('CAPITAL', adminUser, ADMIN_PASS);
      expect(ok.success).toBe(true);
      expect(storage.getAccountingMode()).toBe('CAPITAL');

      // Historical cash movements remain byte-for-byte identical
      expect(JSON.stringify(storage.getCashMovements())).toBe(snapshotBeforeSwitch);

      // Audit log recorded the switch
      const audit = storage.getAuditLogs().find(l => l.action === 'ACCOUNTING_MODE');
      expect(audit).toBeDefined();
      expect(audit?.entityId).toBe('CAPITAL');
    });
  });

  describe('6. Backup & Restore preserves accountingMode/fundingSources and accepts legacy backups', () => {
    it('exports and restores accountingMode & custom fundingSources', async () => {
      const shift = storage.getCurrentShift();
      storage.saveCurrentShift({ ...shift, status: 'CLOSED' });
      const sw = await storage.setAccountingMode('MONTHLY_POOL', adminUser, ADMIN_PASS);
      expect(sw.success).toBe(true);
      const customSrc = storage.addFundingSource(adminUser, {
        type: 'EXTERNAL_FUNDING',
        label: 'خزنة الشركة الرئيسية',
      });
      expect(customSrc.success).toBe(true);

      const pkg = await snapshotService.generateExportPackage();
      expect(pkg.data.accountingMode).toBe('MONTHLY_POOL');
      expect(pkg.data.fundingSources.some((s: any) => s.label === 'خزنة الشركة الرئيسية')).toBe(true);

      // Reset to defaults then restore exported package
      storage.setItem(STORAGE_KEYS.ACCOUNTING_MODE, 'DAILY_DRAWER');
      storage.setItem(STORAGE_KEYS.FUNDING_SOURCES, DEFAULT_FUNDING_SOURCES);

      const restored = await snapshotService.restoreData(pkg);
      expect(restored.success).toBe(true);
      expect(storage.getAccountingMode()).toBe('MONTHLY_POOL');
      expect(
        storage.getFundingSources().some(s => s.label === 'خزنة الشركة الرئيسية')
      ).toBe(true);
    });

    it('accepts legacy backups without accountingMode or fundingSources using safe defaults', async () => {
      const legacyData = {
        products: [testProduct],
        customers: [],
        suppliers: [testSupplier],
        invoices: [],
        purchases: [],
        cashMovements: [],
        expenses: [],
        auditLogs: [],
        stockAdjustments: [],
        currentShift: storage.getCurrentShift(),
        users: [adminUser],
        parkedCarts: [],
      };
      const checksum = await computeDataChecksum(legacyData);
      const legacyPkg = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion: '1.0.0',
        timestamp: new Date().toISOString(),
        recordCounts: {
          products: 1,
          customers: 0,
          suppliers: 1,
          invoices: 0,
          purchases: 0,
          cashMovements: 0,
          expenses: 0,
          auditLogs: 0,
          stockAdjustments: 0,
          users: 1,
          parkedCarts: 0,
        },
        checksum,
        data: legacyData,
      };

      const validation = await snapshotService.validateBackup(legacyPkg);
      expect(validation.valid).toBe(true);

      // Switch current state to CAPITAL first to prove restore resets it to default DAILY_DRAWER
      storage.setItem(STORAGE_KEYS.ACCOUNTING_MODE, 'CAPITAL');

      const restored = await snapshotService.restoreData(legacyPkg);
      expect(restored.success).toBe(true);
      expect(storage.getAccountingMode()).toBe('DAILY_DRAWER');
      expect(storage.getFundingSources().length).toBe(DEFAULT_FUNDING_SOURCES.length);
    });
  });
});
