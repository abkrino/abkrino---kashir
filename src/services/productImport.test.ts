import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { idb } from './idbStore';
import { storage, STORAGE_KEYS, getCairoDateString } from './storageService';
import { snapshotService } from './snapshotService';
import { authSecurityService, hashPasswordWithPbkdf2 } from './authSecurityService';
import {
  MAX_IMPORT_ROWS,
  executeProductImport,
  generateImportTemplateCsv,
  generateImportTemplateXlsx,
  parseAndPreviewProductImport,
} from './productImportService';
import { InventoryManager } from '../components/inventory/InventoryManager';
import { DEFAULT_STORE_PROFILE, Product, User } from '../types';

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

function encodeUtf8Buffer(text: string): ArrayBuffer {
  const uint8 = new TextEncoder().encode(text);
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}

describe('Product Import (Excel .xlsx & UTF-8 BOM CSV), Validation, Atomic pre_import & Opening StockAdjustment', () => {
  let adminUser: User;
  let restrictedSalesUser: User;

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
    storage.setWriteError(null);
    await storage.init();

    const { hashHex, saltHex } = await hashPasswordWithPbkdf2('Adm!n#5522');
    adminUser = {
      id: 'u-admin-imp',
      fullName: 'مدير المخزون والمشتريات',
      username: 'admin_imp',
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
      fullName: 'كاشير بدون صلاحية أصناف',
      username: 'sales_no_prod',
      role: 'SALES',
      pin: '2468',
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
    restrictedSalesUser = cRes.user!;
    storage.setActiveUser(adminUser.id);
  });

  afterEach(async () => {
    await idb.kv.clear();
    await idb.snapshots.clear();
  });

  it('1. ملف سليم (.xlsx عبر القالب وCSV بترميز UTF-8 مع BOM) يُستورد بنجاح مع لقطة pre_import وسجل مراجعة', async () => {
    storage.saveStoreProfile({
      ...DEFAULT_STORE_PROFILE,
      name: 'متجر الروضة',
      phone: '01011223344',
      address: 'الجيزة',
      modules: { dairy: true, weighingScale: true, delivery: false },
    });

    // Generate real .xlsx template and parse it back cleanly with read-excel-file
    const xlsxBlob = await generateImportTemplateXlsx();
    const xlsxBuffer = await xlsxBlob.arrayBuffer();
    const xlsxPreview = await parseAndPreviewProductImport({
      fileName: 'قالب_استيراد_الأصناف.xlsx',
      buffer: xlsxBuffer,
    });

    expect(xlsxPreview.ok).toBe(true);
    expect(xlsxPreview.fileFormat).toBe('XLSX');
    expect(xlsxPreview.totalRows).toBe(2);
    expect(xlsxPreview.newRows).toBe(2);
    expect(xlsxPreview.invalidRows).toBe(0);
    expect(xlsxPreview.errors).toEqual([]);
    expect(xlsxPreview.recognizedColumns).toContain('نوع التخزين');
    expect(xlsxPreview.recognizedColumns).toContain('يباع بالميزان');
    expect(xlsxPreview.recognizedColumns).toContain('كود الميزان');

    const execRes = await executeProductImport({
      preview: xlsxPreview,
      duplicateMode: 'SKIP',
      user: adminUser,
    });

    expect(execRes.success).toBe(true);
    expect(execRes.addedCount).toBe(2);
    expect(execRes.updatedCount).toBe(0);
    expect(execRes.openingAdjustmentsCount).toBe(2);
    expect(execRes.snapshotId).toBeTruthy();

    // Verify products persisted to IDB
    const savedProducts = storage.getProducts();
    expect(savedProducts).toHaveLength(2);
    const idbProductsRec = await idb.kv.get(STORAGE_KEYS.PRODUCTS);
    expect(idbProductsRec?.value).toHaveLength(2);

    // Verify pre_import snapshot created
    const snaps = await snapshotService.getAllSnapshots();
    expect(snaps.some(s => s.id === execRes.snapshotId && s.type === 'pre_import')).toBe(true);

    // Verify AuditLog contains file name & counts
    const auditLogs = storage.getAuditLogs();
    const importLog = auditLogs.find(l => l.action === 'PRODUCT_IMPORT');
    expect(importLog).toBeDefined();
    expect(importLog!.details).toContain('قالب_استيراد_الأصناف.xlsx');
    expect(importLog!.details).toContain('2');

    // Also test CSV template (UTF-8 with BOM) respects disabled modules
    storage.saveStoreProfile({
      ...DEFAULT_STORE_PROFILE,
      name: 'متجر عام',
      modules: { dairy: false, weighingScale: false, delivery: false },
    });
    const csvText = generateImportTemplateCsv();
    expect(csvText.startsWith('\uFEFF')).toBe(true);
    expect(csvText).not.toContain('نوع التخزين');
    expect(csvText).not.toContain('كود الميزان');

    const csvPreview = await parseAndPreviewProductImport({
      fileName: 'general.csv',
      buffer: encodeUtf8Buffer(csvText),
      existingProducts: [],
    });
    expect(csvPreview.ok).toBe(true);
    expect(csvPreview.fileFormat).toBe('CSV');
    expect(csvPreview.totalRows).toBe(2);
  });

  it('2. الصفوف الخاطئة تظهر في جدول الأخطاء مع رقم الصف والعمود والسبب ولا يُكتب منها شيء', async () => {
    const csvWithErrors =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,سعر الشراء,تاريخ الصلاحية',
        'زيت ذرة 1 لتر,زجاجة,-15,10,2027-06-30',
        ',قطعة,25,18,2027-02-30',
      ].join('\r\n');

    const preview = await parseAndPreviewProductImport({
      fileName: 'errors.csv',
      buffer: encodeUtf8Buffer(csvWithErrors),
    });

    expect(preview.ok).toBe(false);
    expect(preview.invalidRows).toBe(2);
    expect(preview.errors.length).toBeGreaterThanOrEqual(3);

    expect(preview.errors.some(e => e.rowNumber === 2 && e.column === 'سعر البيع')).toBe(true);
    expect(preview.errors.some(e => e.rowNumber === 3 && e.column === 'اسم الصنف')).toBe(true);
    expect(preview.errors.some(e => e.rowNumber === 3 && e.column === 'تاريخ الصلاحية')).toBe(true);

    const execRes = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: adminUser,
    });

    expect(execRes.success).toBe(false);
    expect(storage.getProducts()).toHaveLength(0);
    expect(storage.getStockAdjustments()).toHaveLength(0);
  });

  it('3. تكرار الباركود داخل الملف نفسه يُرفض في المعاينة ولا يُكتب شيء', async () => {
    const duplicateCsv =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,الباركود',
        'سكر أبيض 1 كجم,كيس,42,6221000088811',
        'سكر أبيض مستورد 1 كجم,كيس,45,6221000088811',
      ].join('\r\n');

    const preview = await parseAndPreviewProductImport({
      fileName: 'dup_barcode.csv',
      buffer: encodeUtf8Buffer(duplicateCsv),
    });

    expect(preview.ok).toBe(false);
    expect(preview.invalidRows).toBe(1);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0].rowNumber).toBe(3);
    expect(preview.errors[0].column).toBe('الباركود');
    expect(preview.errors[0].reason).toContain('6221000088811');

    const execRes = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: adminUser,
    });
    expect(execRes.success).toBe(false);
    expect(storage.getProducts()).toHaveLength(0);
  });

  it('4. تخطّي الموجود مقابل تحديثه: التخطي يحفظ الأصناف كما هي والتحديث يعدّل الأسعار فقط ولا يلمس الرصيد', async () => {
    const existingProd: Product = {
      id: 'p-exist-1',
      code: 'PRD-500',
      barcode: '6221000050000',
      name: 'مكرونة قلم 400 جم',
      category: 'بقالة',
      brand: 'الملكة',
      baseUnit: 'كيس',
      wholesaleUnit: 'كرتونة',
      piecesPerWholesaleUnit: 20,
      costPricePerBase: 12,
      costPricePerCarton: 240,
      retailPricePerBase: 15,
      wholesalePricePerCarton: 280,
      halfWholesalePricePerCarton: 290,
      stockPieces: 75,
      reorderLevelPieces: 10,
      isActive: true,
    };
    const existingNoBarcode: Product = {
      id: 'p-exist-2',
      code: 'PRD-501',
      barcode: '',
      name: 'صلصة طماطم برطمان',
      category: 'معلبات',
      brand: 'هاينز',
      baseUnit: 'برطمان',
      wholesaleUnit: 'كرتونة',
      piecesPerWholesaleUnit: 12,
      costPricePerBase: 20,
      costPricePerCarton: 240,
      retailPricePerBase: 25,
      wholesalePricePerCarton: 280,
      halfWholesalePricePerCarton: 290,
      stockPieces: 40,
      reorderLevelPieces: 5,
      isActive: true,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [existingProd, existingNoBarcode]);

    const csvText =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,الباركود,سعر الشراء,الرصيد الافتتاحي',
        'مكرونة قلم 400 جم سعر جديد,كيس,18,6221000050000,14,999',
        'صلصة طماطم برطمان,برطمان,30,,22,500',
        'خل أبيض 1 لتر,زجاجة,16,6221000060000,12,20',
      ].join('\r\n');

    // Case A: SKIP mode (default) -> existing untouched, only 1 new added
    const previewSkip = await parseAndPreviewProductImport({
      fileName: 'skip_test.csv',
      buffer: encodeUtf8Buffer(csvText),
    });
    expect(previewSkip.ok).toBe(true);
    expect(previewSkip.newRows).toBe(1);
    expect(previewSkip.duplicateExistingRows).toBe(2);

    const resSkip = await executeProductImport({
      preview: previewSkip,
      duplicateMode: 'SKIP',
      user: adminUser,
    });
    expect(resSkip.success).toBe(true);
    expect(resSkip.addedCount).toBe(1);
    expect(resSkip.updatedCount).toBe(0);
    expect(resSkip.skippedCount).toBe(2);
    expect(storage.getProducts().find(p => p.id === 'p-exist-1')!.retailPricePerBase).toBe(15);
    expect(storage.getProducts().find(p => p.id === 'p-exist-1')!.stockPieces).toBe(75);

    // Case B: UPDATE mode on the 2 existing products -> updates prices, NEVER touches stockPieces!
    const updateOnlyCsv =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,الباركود,سعر الشراء,الرصيد الافتتاحي',
        'مكرونة قلم 400 جم سعر جديد,كيس,18,6221000050000,14,999',
        'صلصة طماطم برطمان,برطمان,30,,22,500',
      ].join('\r\n');

    const previewUpdate = await parseAndPreviewProductImport({
      fileName: 'update_test.csv',
      buffer: encodeUtf8Buffer(updateOnlyCsv),
    });
    expect(previewUpdate.ok).toBe(true);
    expect(previewUpdate.duplicateExistingRows).toBe(2);

    const adjCountBeforeUpdate = storage.getStockAdjustments().length;
    const resUpdate = await executeProductImport({
      preview: previewUpdate,
      duplicateMode: 'UPDATE',
      user: adminUser,
    });

    expect(resUpdate.success).toBe(true);
    expect(resUpdate.updatedCount).toBe(2);
    expect(resUpdate.openingAdjustmentsCount).toBe(0);

    const updated1 = storage.getProducts().find(p => p.id === 'p-exist-1')!;
    expect(updated1.retailPricePerBase).toBe(18);
    expect(updated1.costPricePerBase).toBe(14);
    expect(updated1.name).toBe('مكرونة قلم 400 جم سعر جديد');
    expect(updated1.stockPieces).toBe(75); // UNCHANGED!

    const updated2 = storage.getProducts().find(p => p.id === 'p-exist-2')!;
    expect(updated2.retailPricePerBase).toBe(30);
    expect(updated2.stockPieces).toBe(40); // UNCHANGED!

    // No new StockAdjustments created during UPDATE mode
    expect(storage.getStockAdjustments().length).toBe(adjCountBeforeUpdate);
  });

  it('5. الرصيد الافتتاحي يُسجَّل كتسوية مخزون StockAdjustment من نوع "رصيد افتتاحي" بتاريخ الاستيراد والمستخدم المنفّذ', async () => {
    const csvText =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,الباركود,الرصيد الافتتاحي',
        'عسل نحل 500 جم,برطمان,150,6221000077701,36',
        'مربى فراولة,برطمان,55,6221000077702,0',
      ].join('\r\n');

    const preview = await parseAndPreviewProductImport({
      fileName: 'opening_balance.csv',
      buffer: encodeUtf8Buffer(csvText),
    });
    expect(preview.ok).toBe(true);

    const execRes = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: adminUser,
    });
    expect(execRes.success).toBe(true);
    expect(execRes.openingAdjustmentsCount).toBe(1);

    const adjustments = storage.getStockAdjustments();
    expect(adjustments).toHaveLength(1);
    const adj = adjustments[0];
    expect(adj.productName).toBe('عسل نحل 500 جم');
    expect(adj.previousPieces).toBe(0);
    expect(adj.differencePieces).toBe(36);
    expect(adj.newPieces).toBe(36);
    expect(adj.reason).toBe('OPENING_BALANCE');
    expect(adj.reasonArabic).toBe('رصيد افتتاحي');
    expect(adj.date).toBe(getCairoDateString(new Date()));
    expect(adj.performedBy).toBe(adminUser.fullName);

    const honey = storage.getProducts().find(p => p.barcode === '6221000077701')!;
    expect(honey.stockPieces).toBe(36);
    const jam = storage.getProducts().find(p => p.barcode === '6221000077702')!;
    expect(jam.stockPieces).toBe(0);
  });

  it('6. التنفيذ كل-أو-لا-شيء: عند فشل لقطة pre_import أو فشل flush لا تتغير المنتجات ولا التسويات ولا السجل', async () => {
    const seedProduct: Product = {
      id: 'p-seed-1',
      code: 'PRD-001',
      barcode: '6221000000001',
      name: 'صنف أصلي',
      category: 'عام',
      brand: 'عام',
      baseUnit: 'قطعة',
      wholesaleUnit: 'كرتونة',
      piecesPerWholesaleUnit: 12,
      costPricePerBase: 10,
      costPricePerCarton: 120,
      retailPricePerBase: 15,
      wholesalePricePerCarton: 160,
      halfWholesalePricePerCarton: 170,
      stockPieces: 10,
      reorderLevelPieces: 2,
      isActive: true,
    };
    storage.setItem(STORAGE_KEYS.PRODUCTS, [seedProduct]);
    await storage.flush();

    const csvText =
      '\uFEFF' +
      [
        'اسم الصنف,وحدة البيع,سعر البيع,الباركود,الرصيد الافتتاحي',
        'صنف مستورد جديد,قطعة,25,6221000099901,50',
      ].join('\r\n');

    const preview = await parseAndPreviewProductImport({
      fileName: 'atomic_fail.csv',
      buffer: encodeUtf8Buffer(csvText),
    });
    expect(preview.ok).toBe(true);

    // 6a. Simulate pre_import snapshot failure -> aborts before any mutation
    const failSnap = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: adminUser,
      options: { simulateSnapshotFailure: true },
    });
    expect(failSnap.success).toBe(false);
    expect(storage.getProducts()).toHaveLength(1);
    expect(storage.getProducts()[0].id).toBe('p-seed-1');
    expect(storage.getStockAdjustments()).toHaveLength(0);

    // 6b. Simulate flush failure -> rolls back completely (products, adjustments, audit logs unchanged)
    const auditLogsBefore = storage.getAuditLogs().length;
    const failFlush = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: adminUser,
      options: { simulateFlushFailure: true },
    });
    expect(failFlush.success).toBe(false);
    expect(storage.getProducts()).toHaveLength(1);
    expect(storage.getProducts()[0].id).toBe('p-seed-1');
    expect(storage.getStockAdjustments()).toHaveLength(0);
    // PRODUCT_IMPORT audit entry must NOT persist; only pre_import snapshot log was added
    expect(storage.getAuditLogs().some(l => l.action === 'PRODUCT_IMPORT')).toBe(false);
    expect(storage.getAuditLogs().length).toBe(auditLogsBefore + 1);

    // 6c. Independent pre_import snapshot quota (keep newest 3 without evicting healthy standard snapshots)
    for (let i = 1; i <= 7; i++) {
      await idb.snapshots.put({
        id: `snap_std_${i}`,
        dateStr: `2026-11-0${i}`,
        type: 'daily',
        status: 'healthy',
        timestamp: 1000 + i * 100,
        data: { products: [seedProduct] },
        metadata: {
          approxSizeBytes: 100,
          recordCounts: {
            products: 1,
            invoices: 0,
            customers: 0,
            suppliers: 0,
            purchases: 0,
            cashMovements: 0,
            expenses: 0,
            users: 1,
          },
          schemaVersion: 1,
          appVersion: '1.0.0',
          checksum: 'abc',
        },
      });
    }
    for (let j = 1; j <= 5; j++) {
      await snapshotService.createSnapshot('pre_import', `snap_pre_imp_${j}`, '2026-11-10', { force: true });
    }
    const allSnaps = await snapshotService.getAllSnapshots();
    expect(allSnaps.filter(s => s.type === 'daily' && s.status === 'healthy')).toHaveLength(7);
    expect(allSnaps.filter(s => s.type === 'pre_import')).toHaveLength(3);
  });

  it('7. الأرقام العربية-الهندية، تنظيف المسافات، الحد الأقصى 5000 صف، وصلاحية canManageProducts', async () => {
    const arabicCsv =
      '\uFEFF' +
      [
        '  اسم الصنف  ;  وحدة البيع ; سعر البيع ; الباركود ; عدد القطع في الكرتونة ; سعر الشراء ; الرصيد الافتتاحي ',
        '  تونة قطع ١٧٠ جم  ;  علبة  ;  ٦٥٫٥٠  ;  ٦٢٢١٠٠٠٠٤٤٤٣٣  ;  ٢٤  ;  ٥٢٫٢٥  ;  ٤٨  ',
      ].join('\r\n');

    const preview = await parseAndPreviewProductImport({
      fileName: 'arabic_digits.csv',
      buffer: encodeUtf8Buffer(arabicCsv),
    });

    expect(preview.ok).toBe(true);
    expect(preview.totalRows).toBe(1);
    const row = preview.rows[0];
    expect(row.name).toBe('تونة قطع ١٧٠ جم');
    expect(row.baseUnit).toBe('علبة');
    expect(row.retailPricePerBase).toBe(65.5);
    expect(row.barcode).toBe('6221000044433');
    expect(row.piecesPerWholesaleUnit).toBe(24);
    expect(row.costPricePerBase).toBe(52.25);
    expect(row.openingBalance).toBe(48);

    // Non-authorized sales user cannot execute import or see import button
    const deniedRes = await executeProductImport({
      preview,
      duplicateMode: 'SKIP',
      user: restrictedSalesUser,
    });
    expect(deniedRes.success).toBe(false);
    expect(deniedRes.error).toContain('غير مصرح');

    const restrictedHtml = renderToStaticMarkup(
      React.createElement(InventoryManager, {
        currentUser: restrictedSalesUser,
        onRefreshData: () => {},
      })
    );
    expect(restrictedHtml).not.toContain('استيراد أصناف');

    const adminHtml = renderToStaticMarkup(
      React.createElement(InventoryManager, {
        currentUser: adminUser,
        onRefreshData: () => {},
      })
    );
    expect(adminHtml).toContain('استيراد أصناف');

    // Enforce max 5000 rows limit
    const overLimitLines = ['اسم الصنف,وحدة البيع,سعر البيع'];
    for (let i = 1; i <= MAX_IMPORT_ROWS + 1; i++) {
      overLimitLines.push(`صنف ${i},قطعة,10`);
    }
    const overLimitPreview = await parseAndPreviewProductImport({
      fileName: 'too_big.csv',
      buffer: encodeUtf8Buffer(overLimitLines.join('\n')),
    });
    expect(overLimitPreview.ok).toBe(false);
    expect(overLimitPreview.fatalError).toContain(String(MAX_IMPORT_ROWS));
  });
});
