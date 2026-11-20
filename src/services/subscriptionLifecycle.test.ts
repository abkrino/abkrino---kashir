import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Ensure localStorage works cleanly in Vitest Node environment
const lsStore: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
      setItem: (k: string, v: string) => {
        lsStore[k] = String(v);
      },
      removeItem: (k: string) => {
        delete lsStore[k];
      },
      clear: () => {
        for (const k of Object.keys(lsStore)) delete lsStore[k];
      },
    },
    writable: true,
  });
}

const firestoreMockState = vi.hoisted(() => {
  const getDocCalls: string[] = [];
  const setDocCalls: { path: string; payload: any }[] = [];
  const updateDocCalls: { path: string; payload: any }[] = [];
  let branchDocData: Record<string, any> = {};

  return {
    getDocCalls,
    setDocCalls,
    updateDocCalls,
    get branchDocData() {
      return branchDocData;
    },
    set branchDocData(v: Record<string, any>) {
      branchDocData = v;
    },
    reset: () => {
      getDocCalls.length = 0;
      setDocCalls.length = 0;
      updateDocCalls.length = 0;
      branchDocData = {};
    },
  };
});

vi.mock('firebase/firestore', () => ({
  doc: (_db: any, ...segments: string[]) => ({
    path: segments.join('/'),
    id: segments[segments.length - 1],
  }),
  collection: (_db: any, ...segments: string[]) => ({ path: segments.join('/') }),
  serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
  setDoc: vi.fn(async (ref: { path: string }, data: any) => {
    firestoreMockState.setDocCalls.push({ path: ref.path, payload: data });
  }),
  updateDoc: vi.fn(async (ref: { path: string }, data: any) => {
    firestoreMockState.updateDocCalls.push({ path: ref.path, payload: data });
  }),
  deleteDoc: vi.fn(async () => {}),
  getDoc: vi.fn(async (ref: { path: string }) => {
    firestoreMockState.getDocCalls.push(ref.path);
    return {
      exists: () => true,
      data: () => ({
        lastSeenAt: { toMillis: () => Date.now() },
        ...firestoreMockState.branchDocData,
      }),
    };
  }),
  getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: vi.fn(() => ({
    set: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn(async () => {}),
  })),
}));

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(async () => {}),
  onAuthStateChanged: vi.fn(() => () => {}),
}));

vi.mock('./cloudService', () => ({
  db: { __mockDb: true },
  auth: { currentUser: { uid: 'org-lifecycle-1', email: 'store@test.com' } },
  isCloudConfigured: true,
  cloudService: {
    isConfigured: () => true,
    isOnline: () => true,
    isSyncing: () => false,
    subscribe: () => () => {},
    getCloudSettings: () => ({ autoSyncOnAction: true, autoSyncEnabled: true }),
    getLinkedStore: () => ({
      storeName: 'متجر تجريبي',
      branchName: 'الفرع الرئيسي',
      storeCode: 'main',
      subscriptionPlan: 'Pro',
      subscriptionStatus: 'ACTIVE',
      subscriptionStatusLabel: 'نشط',
    }),
  },
}));

import { idb } from './idbStore';
import { storage } from './storageService';
import { DEFAULT_STORE_PROFILE } from '../types';
import { snapshotService } from './snapshotService';
import { authSecurityService } from './authSecurityService';
import {
  licenseService,
  LicensePayload,
  LICENSE_ENFORCEMENT,
  stringToBase64Url,
  bytesToBase64Url,
} from './licenseService';
import { orgSyncService } from './orgSyncService';
import { cloudBackupService, stripUserCredentialsFromData } from './cloudBackupService';
import { cloudBudgetService } from './cloudBudgetService';

const DAY_MS = 24 * 60 * 60 * 1000;
let testPrivateKeyObj: crypto.KeyObject;

function signTestToken(payload: LicensePayload, tampered = false): string {
  const payloadB64 = stringToBase64Url(JSON.stringify(payload));
  const signature = crypto.sign('SHA256', Buffer.from(payloadB64, 'utf-8'), {
    key: testPrivateKeyObj,
    dsaEncoding: 'ieee-p1363',
  });
  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  if (tampered) {
    const flipped = (payloadB64[0] === 'e' ? 'f' : 'e') + payloadB64.slice(1);
    return `${flipped}.${sigB64}`;
  }
  return `${payloadB64}.${sigB64}`;
}

function makePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  const now = Date.now();
  return {
    v: 1,
    orgId: 'org-lifecycle-1',
    branchId: 'main',
    deviceId: licenseService.getDeviceId(),
    mode: 'offline',
    plan: 'الباقة الاحترافية',
    issuedAt: new Date(now - DAY_MS).toISOString(),
    validUntil: new Date(now + 30 * DAY_MS).toISOString(),
    graceDays: 7,
    maxOfflineDays: 30,
    ...overrides,
  };
}

describe('Subscription Lifecycle, Enforcement Matrix, Features Gating & Online Auto-Renewal', () => {
  beforeAll(async () => {
    const keyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    licenseService.setPublicKeyForTesting(publicJwk as JsonWebKey);
    testPrivateKeyObj = crypto.createPrivateKey({ key: privateJwk as any, format: 'jwk' });
  });

  afterAll(() => {
    licenseService.setPublicKeyForTesting(null);
  });

  beforeEach(async () => {
    localStorage.clear();
    firestoreMockState.reset();
    licenseService.simulateLicenseDate(null);
    licenseService.removeLicense();
    licenseService.clearTrialBypass();
    orgSyncService.resetForTesting();
    cloudBackupService.resetInternalStateForTesting();
    await cloudBudgetService.resetForTesting();
    await idb.kv.clear();
    await idb.snapshots.clear();
    (storage as any).cache.clear();
    (storage as any).pendingWrites.clear();
    (storage as any).initPromise = null;
    (storage as any).isReady = false;
    (storage as any).isFallback = false;
    (storage as any).migrationRecoveryRequired = false;
    await storage.init();
    storage.loadDemoData();
    const adminUser = {
      id: 'user-admin-1',
      username: 'admin',
      fullName: 'مدير النظام',
      role: 'ADMIN' as const,
      isActive: true,
      pinCode: '998877',
    };
    storage.saveUser(adminUser, { bypassLicenseCheck: true });
    storage.setActiveUser(adminUser.id);
    await storage.flush();
  });

  afterEach(() => {
    licenseService.simulateLicenseDate(null);
    orgSyncService.stopService();
  });

  it('0. يبقي LICENSE_ENFORCEMENT على false', () => {
    expect(LICENSE_ENFORCEMENT).toBe(false);
  });

  it('1. يشتق المراحل الأربع (ACTIVE / EXPIRING / GRACE / EXPIRED) مع daysToExpiry وgraceDaysLeft عبر simulateLicenseDate بدون تفعيل تلاعب الساعة', async () => {
    const baseMs = Date.now();
    const validUntilMs = baseMs + 30 * DAY_MS;
    const token = signTestToken(
      makePayload({
        issuedAt: new Date(baseMs - DAY_MS).toISOString(),
        validUntil: new Date(validUntilMs).toISOString(),
        graceDays: 7,
      })
    );

    const res = await licenseService.verifyAndStoreLicense(token);
    expect(res.success).toBe(true);

    // Day +10 -> ACTIVE (20 days left > 7)
    licenseService.simulateLicenseDate(new Date(baseMs + 10 * DAY_MS));
    let state = licenseService.getLicenseState();
    expect(state.subscriptionPhase).toBe('ACTIVE');
    expect(state.status).toBe('valid');
    expect(state.daysToExpiry).toBe(20);
    expect(state.graceDaysLeft).toBe(7);

    // Day +25 -> EXPIRING (5 days left <= 7)
    licenseService.simulateLicenseDate(new Date(baseMs + 25 * DAY_MS));
    state = licenseService.getLicenseState();
    expect(state.subscriptionPhase).toBe('EXPIRING');
    expect(state.status).toBe('valid');
    expect(state.daysToExpiry).toBe(5);

    // Day +33 -> GRACE (3 days past expiry out of 7 => 4 grace days left)
    licenseService.simulateLicenseDate(new Date(baseMs + 33 * DAY_MS));
    state = licenseService.getLicenseState();
    expect(state.subscriptionPhase).toBe('GRACE');
    expect(state.status).toBe('grace');
    expect(state.daysToExpiry).toBe(0);
    expect(state.graceDaysLeft).toBe(4);

    // Day +40 -> EXPIRED (10 days past expiry > 7)
    licenseService.simulateLicenseDate(new Date(baseMs + 40 * DAY_MS));
    state = licenseService.getLicenseState();
    expect(state.subscriptionPhase).toBe('EXPIRED');
    expect(state.status).toBe('expired');
    expect(state.daysToExpiry).toBe(0);
    expect(state.graceDaysLeft).toBe(0);

    // Stepping back to real clock does NOT trigger clock-rollback
    licenseService.simulateLicenseDate(null);
    expect(licenseService.checkClockRollback()).toBe(false);
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('ACTIVE');
  });

  it('2. يفرض مصفوفة الكتابة على الفئات الست عبر المراحل الأربع ويسجل LICENSE_BLOCK في auditLogs عند الرفض', async () => {
    const baseMs = Date.now();
    const validUntilMs = baseMs + 30 * DAY_MS;
    const token = signTestToken(
      makePayload({
        issuedAt: new Date(baseMs - DAY_MS).toISOString(),
        validUntil: new Date(validUntilMs).toISOString(),
        graceDays: 7,
      })
    );
    await licenseService.verifyAndStoreLicense(token);

    const products = storage.getProducts();
    const customers = storage.getCustomers();
    const suppliers = storage.getSuppliers();
    const adminUser = storage.getUsers()[0];
    expect(products.length).toBeGreaterThan(0);
    expect(customers.length).toBeGreaterThan(0);
    expect(suppliers.length).toBeGreaterThan(0);

    const makeSaleInvoice = (id: string) => {
      const unitPrice = products[0].retailPricePerBase;
      const costPrice = products[0].costPricePerBase;
      return {
        id,
        invoiceNumber: `INV-${id}`,
        date: '2026-11-19',
        time: '12:00',
        customerId: customers[0].id,
        customerName: customers[0].name,
        customerPhone: customers[0].phone,
        salespersonId: adminUser.id,
        salespersonName: adminUser.fullName,
        items: [
          {
            id: `line-${id}`,
            productId: products[0].id,
            productCode: products[0].code,
            productName: products[0].name,
            unit: 'PIECE' as const,
            unitLabel: 'قطعة',
            quantity: 1,
            piecesCount: 1,
            unitPrice,
            defaultUnitPrice: unitPrice,
            costPrice,
            totalPrice: unitPrice,
            discount: 0,
            lineProfit: unitPrice - costPrice,
          },
        ],
        subtotal: unitPrice,
        discountType: 'AMOUNT' as const,
        discountValue: 0,
        discountAmount: 0,
        total: unitPrice,
        paidAmount: unitPrice,
        remainingAmount: 0,
        paymentType: 'CASH' as const,
        previousCustomerBalance: 0,
        newCustomerBalance: 0,
        totalCost: costPrice,
        totalProfit: unitPrice - costPrice,
        status: 'POSTED' as const,
      };
    };

    // --- ACTIVE + EXPIRING: all 6 categories allowed ---
    licenseService.simulateLicenseDate(new Date(baseMs + 25 * DAY_MS)); // EXPIRING
    expect(storage.postSalesInvoice(makeSaleInvoice('sale-expiring')).success).toBe(true);
    expect(
      storage.saveCustomer({ ...customers[0], notes: 'تحديث في التنبيه' }).success
    ).toBe(true);

    // --- GRACE: 5 operational categories allowed, ADMIN_DATA blocked + audit logged ---
    licenseService.simulateLicenseDate(new Date(baseMs + 32 * DAY_MS)); // GRACE
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('GRACE');

    const graceSale = storage.postSalesInvoice(makeSaleInvoice('sale-grace'));
    expect(graceSale.success).toBe(true);

    const graceReturn = storage.processSalesReturn({
      invoiceId: 'sale-grace',
      items: [
        {
          invoiceItemId: 'line-sale-grace',
          productId: products[0].id,
          unit: 'PIECE',
          quantity: 1,
        },
      ],
      reason: 'CUSTOMER_CHANGED_MIND',
      refundMethod: 'CASH',
      returnToStock: true,
      user: adminUser,
      allowNegativeCash: true,
      fundingDetails: { type: 'DRAWER_NEGATIVE', label: 'سحب مباشر بالسالب' },
    });
    expect(graceReturn.success).toBe(true);

    const gracePurchase = storage.postPurchaseInvoice({
      id: 'pur-grace',
      invoiceNumber: 'PUR-GRACE-1',
      date: '2026-11-19',
      time: '13:00',
      supplierId: suppliers[0].id,
      supplierName: suppliers[0].name,
      supplierType: suppliers[0].type,
      items: [
        {
          productId: products[0].id,
          productName: products[0].name,
          unit: 'PIECE',
          quantity: 2,
          unitCost: products[0].costPricePerBase,
          totalCost: products[0].costPricePerBase * 2,
        },
      ],
      subtotal: products[0].costPricePerBase * 2,
      discountAmount: 0,
      freightCost: 0,
      bonusType: 'NONE',
      totalCost: products[0].costPricePerBase * 2,
      paidAmount: 0,
      remainingAmount: products[0].costPricePerBase * 2,
      paymentType: 'CREDIT',
      previousSupplierBalance: suppliers[0].currentBalance,
      newSupplierBalance: suppliers[0].currentBalance + products[0].costPricePerBase * 2,
      isStockInserted: true,
    });
    expect(gracePurchase.success).toBe(true);

    const graceCollection = storage.recordCustomerCollection({
      customerId: customers[0].id,
      amount: 10,
      collectedBy: adminUser.fullName,
    });
    expect(graceCollection.success).toBe(true);

    const graceSupplierPay = storage.recordSupplierPayment({
      supplierId: suppliers[0].id,
      amount: 10,
      paidBy: adminUser.fullName,
      user: adminUser,
      allowNegativeCash: true,
      fundingDetails: { type: 'OWNER_LOAN', label: 'تمويل مالك' },
    });
    expect(graceSupplierPay.success).toBe(true);

    // ADMIN_DATA blocked in GRACE
    const graceAdminProduct = storage.saveProduct({ ...products[0], name: 'ممنوع في السماح' });
    expect(graceAdminProduct.success).toBe(false);
    expect(graceAdminProduct.error).toContain('فترة السماح');

    const graceAdminExpense = storage.recordExpense(
      {
        id: 'exp-grace-1',
        date: '2026-11-19',
        category: 'OTHER',
        categoryLabelArabic: 'مصروف',
        amount: 5,
        notes: 'ممنوع في السماح',
        recordedBy: adminUser.fullName,
      },
      {
        user: adminUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'OWNER_LOAN', label: 'تمويل مالك' },
      }
    );
    expect(graceAdminExpense.success).toBe(false);

    const graceAdminProfile = storage.saveStoreProfile({ ...DEFAULT_STORE_PROFILE, name: 'ممنوع' });
    expect(graceAdminProfile.success).toBe(false);

    // --- EXPIRED: ALL 6 categories blocked ---
    licenseService.simulateLicenseDate(new Date(baseMs + 40 * DAY_MS)); // EXPIRED
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('EXPIRED');

    const auditCountBefore = storage.getAuditLogs().length;

    expect(storage.postSalesInvoice(makeSaleInvoice('sale-expired')).success).toBe(false);
    expect(
      storage.processSalesReturn({
        invoiceId: 'sale-grace',
        items: [],
        reason: 'CUSTOMER_CHANGED_MIND',
        refundMethod: 'CASH',
        returnToStock: true,
        user: adminUser,
      }).success
    ).toBe(false);
    expect(
      storage.postPurchaseInvoice({
        id: 'pur-exp',
        invoiceNumber: 'PUR-EXP',
        date: '2026-11-19',
        time: '14:00',
        supplierId: suppliers[0].id,
        supplierName: suppliers[0].name,
        supplierType: suppliers[0].type,
        items: [],
        subtotal: 0,
        discountAmount: 0,
        freightCost: 0,
        bonusType: 'NONE',
        totalCost: 0,
        paidAmount: 0,
        remainingAmount: 0,
        paymentType: 'CASH',
        previousSupplierBalance: 0,
        newSupplierBalance: 0,
        isStockInserted: true,
      }).success
    ).toBe(false);
    expect(
      storage.recordCustomerCollection({
        customerId: customers[0].id,
        amount: 10,
        collectedBy: adminUser.fullName,
      }).success
    ).toBe(false);
    expect(
      storage.recordSupplierPayment({
        supplierId: suppliers[0].id,
        amount: 10,
        paidBy: adminUser.fullName,
        user: adminUser,
        allowNegativeCash: true,
        fundingDetails: { type: 'OWNER_LOAN', label: 'تمويل مالك' },
      }).success
    ).toBe(false);
    expect(storage.saveProduct({ ...products[0], name: 'ممنوع بعد الانتهاء' }).success).toBe(false);

    const licenseBlockLogs = storage.getAuditLogs().filter(l => l.action === 'LICENSE_BLOCK');
    expect(storage.getAuditLogs().length).toBeGreaterThan(auditCountBefore);
    expect(licenseBlockLogs.length).toBeGreaterThanOrEqual(7);
  });

  it('3. يستثني كتابات النظام (cloudBudgetService / summaryDirty / snapshot / cloudRestore / auth migration / addAuditLog) أثناء EXPIRED', async () => {
    const baseMs = Date.now();
    const expiredToken = signTestToken(
      makePayload({
        issuedAt: new Date(baseMs - 45 * DAY_MS).toISOString(),
        validUntil: new Date(baseMs - 15 * DAY_MS).toISOString(),
        graceDays: 7,
      })
    );
    await licenseService.verifyAndStoreLicense(expiredToken);
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('EXPIRED');

    // 1. cloudBudgetService writes remain active
    cloudBudgetService.recordUsage('read', 1);
    cloudBudgetService.recordUsage('write', 1);
    expect(cloudBudgetService.getUsage().reads).toBeGreaterThanOrEqual(1);

    // 2. storage.setSummaryDirty remains active
    storage.setSummaryDirty(true);
    expect(storage.getSummaryDirty()).toBe(true);

    // 3. snapshotService.createSnapshot remains active in EXPIRED
    const snapRes = await snapshotService.createSnapshot('manual', 'snap-expired-1', undefined, { force: true });
    expect(snapRes).not.toBeNull();
    expect(snapRes?.id).toBe('snap-expired-1');

    // 4. addAuditLog remains active
    storage.addAuditLog('SYSTEM_TEST', 'اختبار نظام', 'الترخيص', 'sys-1', 'سجل نظام مستثنى');
    expect(storage.getAuditLogs().some(l => l.entityId === 'sys-1')).toBe(true);

    // 5. cloudBackupService.executeCloudRestore succeeds in EXPIRED (allowInExpiredRestore: true)
    const strippedData = stripUserCredentialsFromData(snapshotService.getCurrentBusinessData());
    const restoreRes = await cloudBackupService.executeCloudRestore(strippedData, 'اختبار استعادة عند الانتهاء');
    expect(restoreRes.success).toBe(true);

    // 6. Post-restore admin password setup & PBKDF2 migration succeed via bypassLicenseCheck
    const adminUser = storage.getUsers().find(u => u.role === 'ADMIN')!;
    const setupRes = await authSecurityService.completePostRestoreAdminSetup(adminUser.id, 'Secure#9182');
    expect(setupRes.success).toBe(true);

    const legacyHashUser = {
      ...adminUser,
      pinCode: '918273',
      pinHash: undefined,
      pinSalt: undefined,
    };
    storage.saveUser(legacyHashUser, { bypassLicenseCheck: true });
    const pinVerify = await authSecurityService.authenticate(legacyHashUser.id, '918273');
    expect(pinVerify.success).toBe(true);
    expect(pinVerify.user?.pinHash).toBeTruthy();
    expect(pinVerify.user?.pinCode).toBeUndefined();
  });

  it('4. التجديد من EXPIRED يعيد النظام إلى ACTIVE دون فقد بيانات، ويمنع التخفيض (Anti-Downgrade)', async () => {
    const baseMs = Date.now();
    const initialValidUntil = new Date(baseMs + 30 * DAY_MS).toISOString();
    const token1 = signTestToken(
      makePayload({
        issuedAt: new Date(baseMs - DAY_MS).toISOString(),
        validUntil: initialValidUntil,
        graceDays: 7,
      })
    );
    await licenseService.verifyAndStoreLicense(token1);

    const countBefore = storage.getProducts().length;

    // Move to EXPIRED
    licenseService.simulateLicenseDate(new Date(baseMs + 45 * DAY_MS));
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('EXPIRED');
    expect(storage.saveProduct({ ...storage.getProducts()[0], name: 'مرفوض' }).success).toBe(false);

    // Renew with a strictly newer token (validUntil = baseMs + 365 days)
    const newerValidUntil = new Date(baseMs + 365 * DAY_MS).toISOString();
    const token2 = signTestToken(
      makePayload({
        issuedAt: new Date(baseMs + 45 * DAY_MS).toISOString(),
        validUntil: newerValidUntil,
        graceDays: 7,
      })
    );
    const renewRes = await licenseService.verifyAndStoreLicense(token2);
    expect(renewRes.success).toBe(true);
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('ACTIVE');
    expect(storage.getProducts().length).toBe(countBefore);
    expect(storage.saveProduct({ ...storage.getProducts()[0], name: 'مسموح بعد التجديد' }).success).toBe(true);

    // Anti-downgrade: attempting to install token1 (older validUntil) is rejected!
    const downgradeRes = await licenseService.verifyAndStoreLicense(token1);
    expect(downgradeRes.success).toBe(false);
    expect(downgradeRes.error).toContain('أقدم');
    expect(licenseService.getLicenseState().payload?.validUntil).toBe(newerValidUntil);
  });

  it('5. يقيد الميزات من payload.features (cloudSummary و cloudBackup) ويدعم --features في dev-license.mjs', async () => {
    // Missing features defaults to true
    const legacyToken = signTestToken(makePayload({ features: undefined }));
    await licenseService.verifyAndStoreLicense(legacyToken);
    expect(licenseService.isFeatureEnabled('cloudSummary')).toBe(true);
    expect(licenseService.isFeatureEnabled('cloudBackup')).toBe(true);

    // Install newer license with cloudSummary: false & cloudBackup: false
    const restrictedToken = signTestToken(
      makePayload({
        validUntil: new Date(Date.now() + 60 * DAY_MS).toISOString(),
        features: { cloudSummary: false, cloudBackup: false },
      })
    );
    const installRes = await licenseService.verifyAndStoreLicense(restrictedToken);
    expect(installRes.success).toBe(true);
    expect(licenseService.isFeatureEnabled('cloudSummary')).toBe(false);
    expect(licenseService.isFeatureEnabled('cloudBackup')).toBe(false);

    // pushDailySummary performs ZERO Firestore writes
    storage.setSummaryDirty(false);
    orgSyncService.handleSummaryDataChange();
    expect(storage.getSummaryDirty()).toBe(false);
    const summaryRes = await orgSyncService.pushDailySummary(true);
    expect(summaryRes.skipped).toBe(true);
    expect(firestoreMockState.setDocCalls.length).toBe(0);

    // cloudBackupService creation/check/shift-close perform ZERO Firestore writes
    const backupRes = await cloudBackupService.createAndUploadBackup('manual');
    expect(backupRes.success).toBe(false);
    expect(backupRes.skipped).toBe(true);
    expect(backupRes.reason).toBe('feature_disabled');

    const dailyBackupRes = await cloudBackupService.checkAndCreateDailyBackup();
    expect(dailyBackupRes.reason).toBe('feature_disabled');

    const periodicRes = await cloudBackupService.runPeriodicBackupCheck();
    expect(periodicRes.reason).toBe('feature_disabled');

    const shiftRes = await cloudBackupService.onShiftClosed();
    expect(shiftRes.reason).toBe('feature_disabled');
    expect(firestoreMockState.setDocCalls.length).toBe(0);

    // CLI --features flag test (using temporary private key so repo key is untouched)
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'dev-lic-test-'));
    const tmpPrivKeyPath = join(tmpDir, 'test-priv.json');
    try {
      const { privateKey: cliPrivKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      fs.writeFileSync(tmpPrivKeyPath, JSON.stringify(cliPrivKey.export({ format: 'jwk' })), 'utf-8');

      const cliOut = execFileSync(
        'node',
        [
          resolve(__dirname, '../../tools/dev-license.mjs'),
          'sign',
          '--deviceId',
          'dev-cli-test',
          '--days',
          '30',
          '--orgId',
          'org-cli',
          '--branchId',
          'main',
          '--features',
          '{"cloudSummary":false,"cloudBackup":true}',
        ],
        {
          encoding: 'utf-8',
          env: { ...process.env, DEV_LICENSE_PRIVATE_KEY_PATH: tmpPrivKeyPath },
        }
      );
      const tokenMatch = cliOut.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/m);
      expect(tokenMatch).not.toBeNull();
      const [cliPayloadB64] = tokenMatch![1].split('.');
      const decodedCli = JSON.parse(
        Buffer.from(cliPayloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
      );
      expect(decodedCli.features).toEqual({ cloudSummary: false, cloudBackup: true });

      const cliOutCsv = execFileSync(
        'node',
        [
          resolve(__dirname, '../../tools/dev-license.mjs'),
          'sign',
          '--deviceId',
          'dev-cli-csv',
          '--days',
          '30',
          '--features',
          'cloudSummary=true,cloudBackup=false',
        ],
        {
          encoding: 'utf-8',
          env: { ...process.env, DEV_LICENSE_PRIVATE_KEY_PATH: tmpPrivKeyPath },
        }
      );
      const tokenMatchCsv = cliOutCsv.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/m);
      expect(tokenMatchCsv).not.toBeNull();
      const [csvPayloadB64] = tokenMatchCsv![1].split('.');
      const decodedCsv = JSON.parse(
        Buffer.from(csvPayloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
      );
      expect(decodedCsv.features).toEqual({ cloudSummary: true, cloudBackup: false });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. التحديث الأونلاين من branchDoc.licenseToken يحدث الترخيص بلا قراءات إضافية ويتجاهل التوكن التالف أو الحقول غير الموقّعة ولا يسبب حلقة', async () => {
    const baseMs = Date.now();
    const initialValidUntil = new Date(baseMs + 5 * DAY_MS).toISOString();
    const newerValidUntil = new Date(baseMs + 180 * DAY_MS).toISOString();

    const initialToken = signTestToken(
      makePayload({
        mode: 'online',
        validUntil: initialValidUntil,
        plan: 'الباقة الحالية',
      })
    );
    await licenseService.verifyAndStoreLicense(initialToken);

    // Tampered / wrong-device / unsigned fields must be IGNORED
    const wrongDeviceToken = signTestToken(
      makePayload({
        mode: 'online',
        deviceId: 'other-device-xyz',
        validUntil: newerValidUntil,
      })
    );
    const tamperedToken = signTestToken(
      makePayload({ mode: 'online', validUntil: newerValidUntil }),
      true
    );

    firestoreMockState.branchDocData = {
      licenseToken: tamperedToken,
      validUntil: '2099-12-31T00:00:00.000Z',
      plan: 'خطة مزورة غير موقعة',
      status: 'ACTIVE',
    };

    orgSyncService.startService();
    // Wait a tick for startup heartbeat triggered by startService()
    await new Promise(r => setTimeout(r, 30));

    // Tampered token + unsigned fields ignored
    expect(licenseService.getLicenseState().payload?.validUntil).toBe(initialValidUntil);
    expect(licenseService.getLicenseState().payload?.plan).toBe('الباقة الحالية');

    // Wrong device token directly ignored as well
    const wrongInstall = await licenseService.tryAutoInstallBranchToken(wrongDeviceToken);
    expect(wrongInstall.updated).toBe(false);
    expect(licenseService.getLicenseState().payload?.validUntil).toBe(initialValidUntil);

    // Valid newer token on branch doc -> installed automatically on single heartbeat read with ZERO loop
    const newerToken = signTestToken(
      makePayload({
        mode: 'online',
        validUntil: newerValidUntil,
        plan: 'الباقة المجددة',
      })
    );
    firestoreMockState.branchDocData = {
      licenseToken: newerToken,
      validUntil: '2099-12-31T00:00:00.000Z',
    };
    orgSyncService.setLastClockReconcileMsForTesting(0);
    const writesBefore = firestoreMockState.updateDocCalls.length;
    const readsBefore = firestoreMockState.getDocCalls.length;

    const hbRes = await orgSyncService.sendHeartbeat({ reason: 'manual', force: true });
    expect(hbRes.success).toBe(true);
    await new Promise(r => setTimeout(r, 30));

    // Zero loop: strictly 1 write + 1 piggybacked read
    expect(firestoreMockState.updateDocCalls.length - writesBefore).toBe(1);
    expect(firestoreMockState.getDocCalls.length - readsBefore).toBe(1);
    expect(licenseService.getLicenseState().payload?.validUntil).toBe(newerValidUntil);
    expect(licenseService.getLicenseState().payload?.plan).toBe('الباقة المجددة');
    expect(licenseService.getLicenseState().subscriptionPhase).toBe('ACTIVE');
  });
});
