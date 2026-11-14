import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { idb } from './idbStore';
import {
  storage,
  STORAGE_KEYS,
  getCairoDateString,
  getCairoMonthPrefix,
  getMovementCairoMonthPrefix,
} from './storageService';
import { authSecurityService, hashPasswordWithPbkdf2 } from './authSecurityService';
import { snapshotService, CURRENT_SCHEMA_VERSION, computeDataChecksum } from './snapshotService';
import { cloudService } from './cloudService';
import { licenseService } from './licenseService';
import { ProfitReports } from '../components/reports/ProfitReports';
import {
  CashMovement,
  DEFAULT_STORE_PROFILE,
  LEGACY_STORE_PROFILE,
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

describe('Cleanup, Monthly Pool Capital Injection Toggle & Africa/Cairo Boundary Tests', () => {
  let adminUser: User;
  let cashierUser: User;
  const ADMIN_PASS = 'Adm!n#7391';
  const CASHIER_PASS = '1357';

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
      id: 'u-admin-clean',
      fullName: 'المدير العام',
      username: 'admin_clean',
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

    const cRes = await authSecurityService.saveCashier(adminUser, {
      fullName: 'موظف مبيعات',
      username: 'cashier_clean',
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
      },
    });
    expect(cRes.success).toBe(true);
    cashierUser = cRes.user!;
    storage.setActiveUser(adminUser.id);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await idb.kv.clear();
    await idb.snapshots.clear();
  });

  it('أ-4: عدم وجود "الخير والبركة" في أي ملف داخل src باستثناء src/types/index.ts وملفات الاختبار', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
          if (relPath === 'src/types/index.ts' || /\.test\.(ts|tsx)$/.test(relPath)) {
            continue;
          }
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes('الخير والبركة')) {
            offenders.push(relPath);
          }
        }
      }
    };

    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('أ-1: LEGACY_STORE_PROFILE يترك phone و address فارغين ويحفظ الاسم والموديولات القديمة', () => {
    expect(LEGACY_STORE_PROFILE.phone).toBe('');
    expect(LEGACY_STORE_PROFILE.address).toBe('');
    expect(LEGACY_STORE_PROFILE.name).toBeTruthy();
    expect(LEGACY_STORE_PROFILE.modules.dairy).toBe(true);
    expect(LEGACY_STORE_PROFILE.modules.weighingScale).toBe(true);
    expect(LEGACY_STORE_PROFILE.modules.delivery).toBe(false);
  });

  it('أ-2: cloudService.getLinkedStore() يشتق الاسم وحالة الترخيص فعلياً ولا يعرض ACTIVE إلا عند ترخيص valid', () => {
    storage.saveStoreProfile({
      ...DEFAULT_STORE_PROFILE,
      name: 'متجر الندى التجاري',
      branchName: 'فرع المعادي',
      phone: '01012345678',
      address: 'شارع 9، المعادي',
    });

    vi.spyOn(licenseService, 'getLicenseState').mockReturnValue({
      status: 'unlicensed',
      canOperate: true,
      payload: null,
      daysRemaining: 0,
      message: 'لا يوجد ترخيص مفعّل',
    });

    const unlicensedLinked = cloudService.getLinkedStore();
    expect(unlicensedLinked.storeName).toBe('متجر الندى التجاري');
    expect(unlicensedLinked.branchName).toBe('فرع المعادي');
    expect(unlicensedLinked.subscriptionStatus).toBe('UNLICENSED');
    expect(unlicensedLinked.subscriptionStatus).not.toBe('ACTIVE');
    expect(unlicensedLinked.subscriptionStatusLabel).toBe('غير مرخص');

    vi.spyOn(licenseService, 'getLicenseState').mockReturnValue({
      status: 'valid',
      canOperate: true,
      payload: {
        v: 1,
        orgId: 'org-nada',
        branchId: 'br-maadi',
        deviceId: 'DEV-1234',
        mode: 'offline',
        plan: 'pro',
        issuedAt: '2026-11-01T00:00:00.000Z',
        validUntil: '2027-11-01T00:00:00.000Z',
        graceDays: 7,
        maxOfflineDays: 30,
      },
      daysRemaining: 350,
      message: 'الترخيص سارٍ',
    });

    const validLinked = cloudService.getLinkedStore();
    expect(validLinked.subscriptionStatus).toBe('ACTIVE');
    expect(validLinked.subscriptionPlan).toBe('pro');
    expect(validLinked.storeCode).toBe('br-maadi');
  });

  it('ب-1، ب-2، ب-3: monthlyPoolIncludesCapitalInjection يبدأ false ويتطلب Admin + كلمة مرور ويسجل AuditLog ويغير نتيجة الوعاء الشهري دون المساس بالحركات', async () => {
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(false);

    const monthPrefix = getCairoMonthPrefix(new Date());
    const movements: CashMovement[] = [
      {
        id: 'cm-sales-1',
        date: `${monthPrefix}-05`,
        time: '10:00',
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'مبيعات نقدية',
        amount: 1000,
        description: 'مبيعات نقدية',
        performedBy: adminUser.fullName,
        affectsDrawer: true,
      },
      {
        id: 'cm-cap-drawer',
        date: `${monthPrefix}-06`,
        time: '11:00',
        type: 'IN',
        category: 'CAPITAL_INJECTION',
        categoryLabelArabic: 'إيداع رأس مال (غير إيرادي)',
        amount: 5000,
        description: 'ضخ سيولة بالدرج',
        performedBy: adminUser.fullName,
        affectsDrawer: true,
      },
      {
        id: 'cm-cap-nondrawer',
        date: `${monthPrefix}-07`,
        time: '12:00',
        type: 'IN',
        category: 'CAPITAL_INJECTION',
        categoryLabelArabic: 'إيداع رأس مال (غير إيرادي)',
        amount: 2000,
        description: 'تمويل خارج الدرج',
        performedBy: adminUser.fullName,
        affectsDrawer: false,
      },
    ];
    storage.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);

    // 1. Default = false -> excludes CAPITAL_INJECTION
    expect(storage.calculateMonthlyPoolAvailable()).toBe(1000);

    // 2. Non-admin cannot change setting
    const deniedNonAdmin = await storage.setMonthlyPoolIncludesCapitalInjection(true, cashierUser, CASHIER_PASS);
    expect(deniedNonAdmin.success).toBe(false);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(false);

    // 3. Wrong admin password rejected
    const deniedWrongPass = await storage.setMonthlyPoolIncludesCapitalInjection(true, adminUser, 'wrong-password');
    expect(deniedWrongPass.success).toBe(false);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(false);

    // 4. Valid admin + password succeeds, logs AuditLog with old & new states, keeps movements untouched
    const okRes = await storage.setMonthlyPoolIncludesCapitalInjection(true, adminUser, ADMIN_PASS);
    expect(okRes.success).toBe(true);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(true);

    // Same movements now include CAPITAL_INJECTION with affectsDrawer !== false (1000 + 5000 = 6000), never affectsDrawer === false
    expect(storage.calculateMonthlyPoolAvailable()).toBe(6000);

    // Original cash movements count and amounts untouched
    const afterMovements = storage.getCashMovements();
    expect(afterMovements).toHaveLength(3);
    expect(afterMovements.map(m => m.amount)).toEqual([1000, 5000, 2000]);

    const logs = storage.getAuditLogs();
    const settingLog = logs.find(l => l.action === 'ACCOUNTING_SETTINGS' && l.entityId === 'monthlyPoolIncludesCapitalInjection');
    expect(settingLog).toBeDefined();
    expect(settingLog!.details).toContain('معطل');
    expect(settingLog!.details).toContain('مفعّل');
  });

  it('ب-5: إيداع رأس المال لا يدخل في الإيرادات أو الأرباح حتى عند تفعيل monthlyPoolIncludesCapitalInjection', async () => {
    await storage.setMonthlyPoolIncludesCapitalInjection(true, adminUser, ADMIN_PASS);
    // Record capital injection dated today (UTC/Cairo current month matching ProfitReports MONTH filter)
    storage.recordCapitalInjection({
      amount: 15000,
      description: 'ضخ رأس مال إضافي بالدرج',
      performedBy: adminUser.fullName,
      user: adminUser,
      affectsDrawer: true,
    });

    const html = renderToStaticMarkup(
      React.createElement(ProfitReports, {
        currentUser: adminUser,
      })
    );

    const formattedZero = (0).toLocaleString('ar-EG', { minimumFractionDigits: 2 });
    const formattedCapital = (15000).toLocaleString('ar-EG', { minimumFractionDigits: 2 });

    // CAPITAL_INJECTION appears only in its separate non-revenue section; revenue/net profit stay zero
    expect(html).toContain('إيداعات رأس المال (غير إيرادية)');
    expect(html).toContain(formattedCapital);
    expect(html).toContain(`صافي إيرادات المبيعات</span><div class="mt-2"><span class="text-2xl font-black text-slate-900 dark:text-white font-mono">${formattedZero}</span>`);
  });

  it('ب-4: التصدير والاستعادة واللقطات تحفظ الإعداد، والنسخ القديمة بدونه تُقبل بقيمة افتراضية false', async () => {
    const okRes = await storage.setMonthlyPoolIncludesCapitalInjection(true, adminUser, ADMIN_PASS);
    expect(okRes.success).toBe(true);

    // Full JSON backup export preserves true
    const exportedJson = storage.exportFullBackupJson();
    const parsedExport = JSON.parse(exportedJson);
    expect(parsedExport.data.monthlyPoolIncludesCapitalInjection).toBe(true);

    // Reset back to false then restore JSON -> restores true
    await storage.setMonthlyPoolIncludesCapitalInjection(false, adminUser, ADMIN_PASS);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(false);

    const restoreJsonRes = storage.restoreBackupJson(exportedJson);
    expect(restoreJsonRes.success).toBe(true);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(true);

    // SnapshotService export package + validate + transactional restore preserves true
    const pkg = await snapshotService.generateExportPackage();
    expect(pkg.data.monthlyPoolIncludesCapitalInjection).toBe(true);
    const pkgJson = JSON.stringify(pkg);
    await storage.setMonthlyPoolIncludesCapitalInjection(false, adminUser, ADMIN_PASS);
    const valPkg = await snapshotService.validateBackup(pkgJson);
    expect(valPkg.valid).toBe(true);
    const resSnap = await snapshotService.restoreData(JSON.parse(pkgJson));
    expect(resSnap.success).toBe(true);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(true);

    // Internal IDB snapshot preserves true even after toggling to false
    const snap = await snapshotService.createSnapshot('manual');
    expect(snap).not.toBeNull();
    expect(snap!.data.monthlyPoolIncludesCapitalInjection).toBe(true);
    await storage.setMonthlyPoolIncludesCapitalInjection(false, adminUser, ADMIN_PASS);
    const restoreInternal = await snapshotService.restoreData(snap!.data);
    expect(restoreInternal.success).toBe(true);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(true);

    // Legacy backup omitting monthlyPoolIncludesCapitalInjection is accepted & defaults to false
    const legacyData: Record<string, any> = {
      products: [],
      customers: [],
      suppliers: [],
      invoices: [],
      purchases: [],
      cashMovements: [],
      expenses: [],
      auditLogs: [],
      stockAdjustments: [],
      users: [adminUser],
      parkedCarts: [],
      currentShift: null,
    };
    const legacyChecksum = await computeDataChecksum(legacyData);
    const legacyPkg = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      checksum: legacyChecksum,
      data: legacyData,
    };
    const valLegacy = await snapshotService.validateBackup(legacyPkg);
    expect(valLegacy.valid).toBe(true);
    const resLegacy = await snapshotService.restoreData(legacyPkg);
    expect(resLegacy.success).toBe(true);
    expect(storage.getMonthlyPoolIncludesCapitalInjection()).toBe(false);
  });

  it('ج: حدود الشهر في الوعاء الشهري تتبع توقيت Africa/Cairo بدلاً من UTC', () => {
    // 2026-10-31T23:30:00.000Z is 2026-11-01 01:30:00 in Africa/Cairo (UTC+2 in Nov)
    const boundaryUtcIso = '2026-10-31T23:30:00.000Z';
    expect(getCairoDateString(new Date(boundaryUtcIso))).toBe('2026-11-01');
    expect(getCairoMonthPrefix(new Date(boundaryUtcIso))).toBe('2026-11');
    expect(getMovementCairoMonthPrefix(boundaryUtcIso)).toBe('2026-11');
    expect(getMovementCairoMonthPrefix('2026-10-31')).toBe('2026-10');

    const movements: CashMovement[] = [
      {
        id: 'cm-oct-day',
        date: '2026-10-31',
        time: '18:00',
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'مبيعات نقدية',
        amount: 400,
        description: 'مبيعات آخر يوم في أكتوبر بتوقيت القاهرة',
        performedBy: adminUser.fullName,
        affectsDrawer: true,
      },
      {
        id: 'cm-nov-midnight-cairo',
        date: boundaryUtcIso,
        time: '01:30',
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'مبيعات نقدية',
        amount: 750,
        description: 'حركة الساعة 1:30 ص يوم 1 نوفمبر بتوقيت القاهرة (31 أكتوبر 23:30 UTC)',
        performedBy: adminUser.fullName,
        affectsDrawer: true,
      },
    ];
    storage.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);

    // During October in Cairo -> includes only Oct movement (400)
    expect(storage.calculateMonthlyPoolAvailable(new Date('2026-10-31T20:00:00.000Z'))).toBe(400);
    // During November in Cairo -> includes 2026-10-31T23:30:00.000Z (750)
    expect(storage.calculateMonthlyPoolAvailable(new Date('2026-11-15T12:00:00.000Z'))).toBe(750);
  });

  it('د: تهيئة Firestore تعطّل useFetchStreams لمنع خطأ AbortError عند إغلاق القنوات', async () => {
    const { FIRESTORE_SETTINGS, createFirestoreInstance } = await import('./cloudService');
    expect(FIRESTORE_SETTINGS.useFetchStreams).toBe(false);
    expect(FIRESTORE_SETTINGS.experimentalAutoDetectLongPolling).toBe(true);

    const { initializeApp } = await import('firebase/app');
    const testApp = initializeApp(
      { apiKey: 'test-key', projectId: 'test-proj', appId: 'test-app' },
      'settings-verify-app'
    );
    const testDb = createFirestoreInstance(testApp, '(default)');
    const settings = (testDb as unknown as { _getSettings: () => { useFetchStreams?: boolean; experimentalAutoDetectLongPolling?: boolean } })._getSettings();
    expect(settings.useFetchStreams).toBe(false);
    expect(settings.experimentalAutoDetectLongPolling).toBe(true);
  });
});
