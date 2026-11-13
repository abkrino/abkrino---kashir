import { readSheet } from 'read-excel-file/universal';
import writeXlsxFile from 'write-excel-file/universal';
import {
  Product,
  StockAdjustment,
  StorageType,
  StoreProfile,
  User,
} from '../types';
import { storage, STORAGE_KEYS, getCairoDateString } from './storageService';
import { snapshotService } from './snapshotService';

export const MAX_IMPORT_ROWS = 5000;

export type ImportDuplicateMode = 'SKIP' | 'UPDATE';

export interface ImportCellError {
  rowNumber: number; // 1-based row number in file (row 2 = first data row)
  column: string;
  reason: string;
}

export interface ParsedImportProductRow {
  rowNumber: number;
  name: string;
  baseUnit: string;
  retailPricePerBase: number;
  barcode: string;
  cartonBarcode?: string;
  code?: string;
  category: string;
  brand: string;
  wholesaleUnit: string;
  piecesPerWholesaleUnit: number;
  hasCustomPiecesPerUnit: boolean;
  costPricePerBase: number;
  hasCostPerBase: boolean;
  costPricePerCarton: number;
  hasCostPerCarton: boolean;
  wholesalePricePerCarton: number;
  hasWholesalePrice: boolean;
  halfWholesalePricePerCarton: number;
  hasHalfWholesalePrice: boolean;
  openingBalance: number;
  hasOpeningBalance: boolean;
  reorderLevelPieces: number;
  hasReorderLevel: boolean;
  expiryDate?: string;
  batchNumber?: string;
  storageType?: StorageType;
  isWeighing?: boolean;
  scaleBarcodePrefix?: string;
  tareGrams?: number;
  matchType: 'NEW' | 'EXISTING';
  existingProductId?: string;
  existingProductName?: string;
}

export interface ProductImportPreview {
  ok: boolean;
  fileName: string;
  fileFormat: 'XLSX' | 'CSV';
  fatalError?: string;
  totalRows: number;
  newRows: number;
  duplicateExistingRows: number;
  invalidRows: number;
  errors: ImportCellError[];
  rows: ParsedImportProductRow[];
  recognizedColumns: string[];
}

export interface ExecuteImportResult {
  success: boolean;
  error?: string;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  openingAdjustmentsCount: number;
  snapshotId?: string;
}

// Canonical column keys
type CanonicalCol =
  | 'name'
  | 'baseUnit'
  | 'retailPricePerBase'
  | 'barcode'
  | 'cartonBarcode'
  | 'code'
  | 'category'
  | 'brand'
  | 'wholesaleUnit'
  | 'piecesPerWholesaleUnit'
  | 'costPricePerBase'
  | 'costPricePerCarton'
  | 'wholesalePricePerCarton'
  | 'halfWholesalePricePerCarton'
  | 'openingBalance'
  | 'reorderLevelPieces'
  | 'expiryDate'
  | 'batchNumber'
  | 'storageType'
  | 'isWeighing'
  | 'scaleBarcodePrefix'
  | 'tareGrams';

const COLUMN_ARABIC_LABELS: Record<CanonicalCol, string> = {
  name: 'اسم الصنف',
  baseUnit: 'وحدة البيع',
  retailPricePerBase: 'سعر البيع',
  barcode: 'الباركود',
  cartonBarcode: 'باركود الكرتونة',
  code: 'كود الصنف',
  category: 'الفئة',
  brand: 'الشركة',
  wholesaleUnit: 'وحدة الجملة',
  piecesPerWholesaleUnit: 'عدد القطع في الكرتونة',
  costPricePerBase: 'سعر الشراء',
  costPricePerCarton: 'سعر شراء الكرتونة',
  wholesalePricePerCarton: 'سعر الجملة',
  halfWholesalePricePerCarton: 'سعر نص الجملة',
  openingBalance: 'الرصيد الافتتاحي',
  reorderLevelPieces: 'حد الطلب',
  expiryDate: 'تاريخ الصلاحية',
  batchNumber: 'رقم التشغيلة',
  storageType: 'نوع التخزين',
  isWeighing: 'يباع بالميزان',
  scaleBarcodePrefix: 'كود الميزان',
  tareGrams: 'وزن الفارغ بالجرام',
};

const HEADER_ALIASES: Record<string, CanonicalCol> = {
  'اسم الصنف': 'name',
  'اسم المنتج': 'name',
  'الصنف': 'name',
  'الاسم': 'name',
  'وحدة البيع': 'baseUnit',
  'الوحدة': 'baseUnit',
  'الوحدة الأساسية': 'baseUnit',
  'وحدة التجزئة': 'baseUnit',
  'سعر البيع': 'retailPricePerBase',
  'سعر البيع القطاعي': 'retailPricePerBase',
  'سعر القطاعي': 'retailPricePerBase',
  'سعر المستهلك': 'retailPricePerBase',
  'السعر': 'retailPricePerBase',
  'الباركود': 'barcode',
  'باركود': 'barcode',
  'باركود الكرتونة': 'cartonBarcode',
  'كود الصنف': 'code',
  'الكود': 'code',
  'الفئة': 'category',
  'التصنيف': 'category',
  'القسم': 'category',
  'الشركة': 'brand',
  'الشركة المنتجة': 'brand',
  'العلامة التجارية': 'brand',
  'الماركة': 'brand',
  'وحدة الجملة': 'wholesaleUnit',
  'وحدة الشراء': 'wholesaleUnit',
  'عدد القطع في الكرتونة': 'piecesPerWholesaleUnit',
  'عدد القطع بالكرتونة': 'piecesPerWholesaleUnit',
  'القطع في الكرتونة': 'piecesPerWholesaleUnit',
  'معامل التحويل': 'piecesPerWholesaleUnit',
  'سعر الشراء': 'costPricePerBase',
  'التكلفة': 'costPricePerBase',
  'سعر التكلفة': 'costPricePerBase',
  'سعر شراء الكرتونة': 'costPricePerCarton',
  'تكلفة الكرتونة': 'costPricePerCarton',
  'سعر الجملة': 'wholesalePricePerCarton',
  'سعر بيع الجملة': 'wholesalePricePerCarton',
  'سعر جملة الكرتونة': 'wholesalePricePerCarton',
  'سعر نص الجملة': 'halfWholesalePricePerCarton',
  'سعر نصف الجملة': 'halfWholesalePricePerCarton',
  'الرصيد الافتتاحي': 'openingBalance',
  'رصيد افتتاحي': 'openingBalance',
  'الكمية الافتتاحية': 'openingBalance',
  'حد الطلب': 'reorderLevelPieces',
  'حد إعادة الطلب': 'reorderLevelPieces',
  'الحد الأدنى': 'reorderLevelPieces',
  'تاريخ الصلاحية': 'expiryDate',
  'الصلاحية': 'expiryDate',
  'رقم التشغيلة': 'batchNumber',
  'التشغيلة': 'batchNumber',
  'نوع التخزين': 'storageType',
  'التخزين': 'storageType',
  'التبريد': 'storageType',
  'يباع بالميزان': 'isWeighing',
  'صنف ميزان': 'isWeighing',
  'ميزان': 'isWeighing',
  'كود الميزان': 'scaleBarcodePrefix',
  'بادئة الميزان': 'scaleBarcodePrefix',
  'بادئة كود الميزان': 'scaleBarcodePrefix',
  'وزن الفارغ بالجرام': 'tareGrams',
  'وزن الفارغ': 'tareGrams',
};

/**
 * Converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits plus Arabic decimal/thousand separators into standard ASCII digits.
 */
export function normalizeArabicNumerals(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, '.') // Arabic decimal separator ٫
    .replace(/\u066C/g, '')  // Arabic thousands separator ٬
    .trim();
}

export function normalizeCellString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return '';
    const y = cell.getUTCFullYear();
    const m = String(cell.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cell.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof cell === 'boolean') {
    return cell ? 'نعم' : 'لا';
  }
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '';
    return String(cell).trim();
  }
  return String(cell)
    .replace(/\uFEFF/g, '')
    .trim();
}

function normalizeHeaderText(raw: string): string {
  return normalizeArabicNumerals(raw.replace(/\uFEFF/g, '').replace(/[*✦]/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNameForMatch(name: string): string {
  return normalizeArabicNumerals(name)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseNumericCell(
  cell: unknown
): { empty: boolean; valid: boolean; value?: number } {
  const str = normalizeCellString(cell);
  if (!str) return { empty: true, valid: true };

  let normalized = normalizeArabicNumerals(str).replace(/\s+/g, '');
  // Handle common English thousands comma (e.g. 1,250 or 1,250.50)
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, '');
  } else if (/^[+-]?\d+,\d{1,2}$/.test(normalized) && !normalized.includes('.')) {
    // e.g. 12,50 -> 12.50
    normalized = normalized.replace(',', '.');
  }

  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(normalized)) {
    return { empty: false, valid: false };
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    return { empty: false, valid: false };
  }
  return { empty: false, valid: true, value: num };
}

function parseBooleanCell(cell: unknown): { empty: boolean; valid: boolean; value?: boolean } {
  if (typeof cell === 'boolean') return { empty: false, valid: true, value: cell };
  const raw = normalizeArabicNumerals(normalizeCellString(cell)).toLowerCase();
  if (!raw) return { empty: true, valid: true };
  if (['نعم', 'yes', 'true', '1', 'y', 'صح', 'مفعل'].includes(raw)) {
    return { empty: false, valid: true, value: true };
  }
  if (['لا', 'no', 'false', '0', 'n', 'خطأ', 'غير مفعل'].includes(raw)) {
    return { empty: false, valid: true, value: false };
  }
  return { empty: false, valid: false };
}

function parseStorageTypeCell(cell: unknown): { empty: boolean; valid: boolean; value?: StorageType } {
  const raw = normalizeArabicNumerals(normalizeCellString(cell)).toUpperCase();
  if (!raw) return { empty: true, valid: true };
  if (['AMBIENT', 'عادي', 'جاف', 'رف', 'غرفة', 'بقالة'].includes(raw)) {
    return { empty: false, valid: true, value: 'AMBIENT' };
  }
  if (['CHILLED', 'مبرد', 'ثلاجة', 'تبريد', 'ألبان'].includes(raw)) {
    return { empty: false, valid: true, value: 'CHILLED' };
  }
  if (['FROZEN', 'مجمد', 'فريزر', 'تجميد', 'مجمدات'].includes(raw)) {
    return { empty: false, valid: true, value: 'FROZEN' };
  }
  return { empty: false, valid: false };
}

function parseDateCell(cell: unknown): { empty: boolean; valid: boolean; value?: string } {
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return { empty: false, valid: false };
    const y = cell.getUTCFullYear();
    const m = String(cell.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cell.getUTCDate()).padStart(2, '0');
    return { empty: false, valid: true, value: `${y}-${m}-${d}` };
  }
  const raw = normalizeArabicNumerals(normalizeCellString(cell));
  if (!raw) return { empty: true, valid: true };

  // Support YYYY-MM-DD or YYYY/MM/DD
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  let year: number;
  let month: number;
  let day: number;

  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    // Support DD/MM/YYYY or DD-MM-YYYY
    match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) return { empty: false, valid: false };
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
    return { empty: false, valid: false };
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { empty: false, valid: false };
  }
  return {
    empty: false,
    valid: true,
    value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * RFC-4180 UTF-8 CSV Parser (handles BOM, comma or semicolon separator, quoted newlines & escaped quotes).
 */
export function parseCsvMatrix(csvText: string): string[][] {
  const cleanText = csvText.replace(/^\uFEFF/, '');
  const firstLineEnd = cleanText.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? cleanText : cleanText.slice(0, firstLineEnd);

  // Auto-detect delimiter from header line (comma vs semicolon)
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const next = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentRow.push(currentCell);
      currentCell = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += ch;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function detectFileFormat(fileName: string, buffer: ArrayBuffer): 'XLSX' | 'CSV' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'XLSX';
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'CSV';
  const bytes = new Uint8Array(buffer.slice(0, 4));
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return 'XLSX';
  }
  return 'CSV';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Returns ordered list of template headers & 2 example rows tailored to StoreProfile.modules.
 */
export function getTemplateSpec(storeProfile: StoreProfile = storage.getStoreProfile()): {
  headers: string[];
  examples: (string | number)[][];
} {
  const dairy = Boolean(storeProfile?.modules?.dairy);
  const scale = Boolean(storeProfile?.modules?.weighingScale);

  const headers: string[] = [
    'اسم الصنف',
    'وحدة البيع',
    'سعر البيع',
    'الباركود',
    'باركود الكرتونة',
    'كود الصنف',
    'الفئة',
    'الشركة',
    'وحدة الجملة',
    'عدد القطع في الكرتونة',
    'سعر الشراء',
    'سعر شراء الكرتونة',
    'سعر الجملة',
    'سعر نص الجملة',
    'الرصيد الافتتاحي',
    'حد الطلب',
    'تاريخ الصلاحية',
    'رقم التشغيلة',
  ];

  if (dairy) {
    headers.push('نوع التخزين');
  }
  if (scale) {
    headers.push('يباع بالميزان', 'كود الميزان', 'وزن الفارغ بالجرام');
  }

  const row1: (string | number)[] = [
    dairy ? 'حليب كامل الدسم 1 لتر' : 'أرز أبيض مصري 1 كجم',
    dairy ? 'عبوة' : 'كيس',
    dairy ? 45 : 35,
    '6221000010011',
    '6221000010012',
    'PRD-101',
    dairy ? 'منتجات الألبان والأجبان' : 'بقالة ومواد غذائية جافة',
    dairy ? 'شركة ألبان' : 'شركة حبوب',
    'كرتونة',
    12,
    dairy ? 38 : 29,
    dairy ? 456 : 348,
    dairy ? 510 : 396,
    dairy ? 525 : 408,
    24,
    6,
    '2027-06-30',
    'B-2026-01',
  ];

  if (dairy) {
    row1.push('مبرد');
  }
  if (scale) {
    row1.push('لا', '', 0);
  }

  const row2: (string | number)[] = [
    scale ? 'جبن رومي قديم (بالوزن)' : 'شاي ناعم 250 جم',
    scale ? 'كجم' : 'عبوة',
    scale ? 240 : 65,
    scale ? '2000105' : '6221000020022',
    '',
    'PRD-102',
    scale ? (dairy ? 'منتجات الألبان والأجبان' : 'بقالة وزن') : 'مشروبات وسلع غذائية',
    scale ? 'مزارع متخصصة' : 'شركة مشروبات',
    scale ? 'قرص / بالوزن' : 'كرتونة',
    scale ? 1 : 24,
    scale ? 195 : 54,
    scale ? 195 : 1296,
    scale ? 225 : 1488,
    scale ? 232 : 1512,
    scale ? 10 : 48,
    scale ? 2 : 12,
    '2027-03-31',
    '',
  ];

  if (dairy) {
    row2.push(scale ? 'مبرد' : 'جاف');
  }
  if (scale) {
    row2.push('نعم', '20', 15);
  }

  return { headers, examples: [row1, row2] };
}

export async function generateImportTemplateXlsx(
  storeProfile: StoreProfile = storage.getStoreProfile()
): Promise<Blob> {
  const { headers, examples } = getTemplateSpec(storeProfile);
  const sheetData = [
    headers.map(h => ({ value: h, fontWeight: 'bold' as const })),
    ...examples.map(row =>
      row.map(cell => (cell === '' ? null : cell))
    ),
  ];

  const result = await writeXlsxFile(sheetData, {
    sheet: 'الأصناف',
    rightToLeft: true,
  });
  return await result.toBlob();
}

export function generateImportTemplateCsv(
  storeProfile: StoreProfile = storage.getStoreProfile()
): string {
  const { headers, examples } = getTemplateSpec(storeProfile);
  const escapeCsv = (val: string | number): string => {
    const str = String(val ?? '');
    if (/[",\r\n;]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [
    headers.map(escapeCsv).join(','),
    ...examples.map(r => r.map(escapeCsv).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}

/**
 * Parses an Excel (.xlsx) or UTF-8 CSV buffer and validates every row before any write.
 */
export async function parseAndPreviewProductImport(params: {
  fileName: string;
  buffer: ArrayBuffer;
  existingProducts?: Product[];
  storeProfile?: StoreProfile;
}): Promise<ProductImportPreview> {
  const { fileName, buffer } = params;
  const existingProducts = params.existingProducts ?? storage.getProducts();
  const storeProfile = params.storeProfile ?? storage.getStoreProfile();
  const fileFormat = detectFileFormat(fileName, buffer);

  let rawMatrix: unknown[][];
  try {
    if (fileFormat === 'XLSX') {
      const sheet = await readSheet(buffer);
      rawMatrix = sheet as unknown[][];
    } else {
      const text = new TextDecoder('utf-8').decode(buffer);
      rawMatrix = parseCsvMatrix(text);
    }
  } catch (err: any) {
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: `تعذر قراءة الملف (${fileFormat === 'XLSX' ? 'Excel' : 'CSV'}): تأكد من سلامة التنسيق وأن الملف غير محمي بكلمة مرور. (${err?.message || 'خطأ قراءة'})`,
      totalRows: 0,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns: [],
    };
  }

  if (!rawMatrix || rawMatrix.length === 0) {
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: 'الملف فارغ ولا يحتوي على صف عناوين.',
      totalRows: 0,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns: [],
    };
  }

  // Find header row (first non-empty row)
  let headerRowIdx = -1;
  for (let i = 0; i < rawMatrix.length; i++) {
    const row = rawMatrix[i] || [];
    if (row.some(c => normalizeCellString(c) !== '')) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: 'لم يتم العثور على صف عناوين الأعمدة في الملف.',
      totalRows: 0,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns: [],
    };
  }

  const headerRow = rawMatrix[headerRowIdx];
  const colIndexMap: Partial<Record<CanonicalCol, number>> = {};
  const recognizedColumns: string[] = [];

  headerRow.forEach((cell, idx) => {
    const normalized = normalizeHeaderText(normalizeCellString(cell));
    const canonical = HEADER_ALIASES[normalized];
    if (canonical && colIndexMap[canonical] === undefined) {
      colIndexMap[canonical] = idx;
      recognizedColumns.push(COLUMN_ARABIC_LABELS[canonical]);
    }
  });

  // Check mandatory headers
  const requiredCols: CanonicalCol[] = ['name', 'baseUnit', 'retailPricePerBase'];
  const missingHeaders = requiredCols.filter(c => colIndexMap[c] === undefined);
  if (missingHeaders.length > 0) {
    const missingNames = missingHeaders.map(c => COLUMN_ARABIC_LABELS[c]).join('، ');
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: `الأعمدة الإلزامية مفقودة في صف العناوين: (${missingNames}). يرجى استخدام القالب المعتمد.`,
      totalRows: 0,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns,
    };
  }

  // Filter non-empty data rows
  const nonEmptyEntries: { rowNumber: number; row: unknown[] }[] = [];
  for (let i = headerRowIdx + 1; i < rawMatrix.length; i++) {
    const r = rawMatrix[i] || [];
    const hasAnyValue = r.some(c => normalizeCellString(c) !== '');
    if (hasAnyValue) {
      nonEmptyEntries.push({ rowNumber: i + 1, row: r });
    }
  }

  if (nonEmptyEntries.length === 0) {
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: 'الملف يحتوي على صف العناوين فقط ولا توجد بيانات أصناف للاستيراد.',
      totalRows: 0,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns,
    };
  }

  if (nonEmptyEntries.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      fileName,
      fileFormat,
      fatalError: `الحد الأقصى للاستيراد في الملف الواحد هو ${MAX_IMPORT_ROWS} صف. يحتوي الملف على ${nonEmptyEntries.length} صفاً.`,
      totalRows: nonEmptyEntries.length,
      newRows: 0,
      duplicateExistingRows: 0,
      invalidRows: 0,
      errors: [],
      rows: [],
      recognizedColumns,
    };
  }

  // Build existing product lookup maps (barcode first, normalized name fallback)
  const existingByBarcode = new Map<string, Product>();
  const existingByName = new Map<string, Product>();
  for (const prod of existingProducts) {
    if (prod.barcode && prod.barcode.trim()) {
      existingByBarcode.set(normalizeArabicNumerals(prod.barcode.trim()), prod);
    }
    if (prod.name && prod.name.trim()) {
      existingByName.set(normalizeNameForMatch(prod.name), prod);
    }
  }

  const seenBarcodesInFile = new Map<string, number>();
  const seenNamesWithoutBarcodeInFile = new Map<string, number>();

  const errors: ImportCellError[] = [];
  const invalidRowSet = new Set<number>();
  const parsedRows: ParsedImportProductRow[] = [];

  const getCell = (row: unknown[], col: CanonicalCol): unknown => {
    const idx = colIndexMap[col];
    return idx === undefined ? undefined : row[idx];
  };

  const addError = (rowNumber: number, col: CanonicalCol, reason: string) => {
    invalidRowSet.add(rowNumber);
    errors.push({
      rowNumber,
      column: COLUMN_ARABIC_LABELS[col],
      reason,
    });
  };

  const allowDairy = Boolean(storeProfile?.modules?.dairy);
  const allowWeighing = Boolean(storeProfile?.modules?.weighingScale);

  for (const { rowNumber, row } of nonEmptyEntries) {
    const name = normalizeCellString(getCell(row, 'name')).replace(/\s+/g, ' ');
    const baseUnit = normalizeCellString(getCell(row, 'baseUnit')).replace(/\s+/g, ' ');
    const barcodeRaw = normalizeArabicNumerals(normalizeCellString(getCell(row, 'barcode')));
    const cartonBarcode = normalizeArabicNumerals(normalizeCellString(getCell(row, 'cartonBarcode'))) || undefined;
    const code = normalizeArabicNumerals(normalizeCellString(getCell(row, 'code'))) || undefined;
    const category = normalizeCellString(getCell(row, 'category')).replace(/\s+/g, ' ') || 'عام';
    const brand = normalizeCellString(getCell(row, 'brand')).replace(/\s+/g, ' ') || 'عام';
    const wholesaleUnit = normalizeCellString(getCell(row, 'wholesaleUnit')).replace(/\s+/g, ' ') || 'كرتونة';
    const batchNumber = normalizeCellString(getCell(row, 'batchNumber')) || undefined;
    const scaleBarcodePrefix = allowWeighing
      ? normalizeArabicNumerals(normalizeCellString(getCell(row, 'scaleBarcodePrefix'))) || undefined
      : undefined;

    if (!name) {
      addError(rowNumber, 'name', 'اسم الصنف إلزامي ولا يمكن أن يكون فارغاً.');
    }
    if (!baseUnit) {
      addError(rowNumber, 'baseUnit', 'وحدة البيع إلزامية ولا يمكن أن تكون فارغة.');
    }

    // In-file duplicate checks
    if (barcodeRaw) {
      const firstRow = seenBarcodesInFile.get(barcodeRaw);
      if (firstRow !== undefined) {
        addError(
          rowNumber,
          'barcode',
          `تكرار الباركود "${barcodeRaw}" داخل نفس الملف (سبق ظهوره في الصف ${firstRow}).`
        );
      } else {
        seenBarcodesInFile.set(barcodeRaw, rowNumber);
      }
    } else if (name) {
      const normName = normalizeNameForMatch(name);
      const firstRow = seenNamesWithoutBarcodeInFile.get(normName);
      if (firstRow !== undefined) {
        addError(
          rowNumber,
          'name',
          `تكرار اسم الصنف "${name}" داخل نفس الملف بدون باركود (سبق ظهوره في الصف ${firstRow}).`
        );
      } else {
        seenNamesWithoutBarcodeInFile.set(normName, rowNumber);
      }
    }

    // Required numeric: retailPricePerBase
    const retailParsed = parseNumericCell(getCell(row, 'retailPricePerBase'));
    if (retailParsed.empty) {
      addError(rowNumber, 'retailPricePerBase', 'سعر البيع إلزامي.');
    } else if (!retailParsed.valid || (retailParsed.value ?? 0) < 0) {
      addError(rowNumber, 'retailPricePerBase', 'سعر البيع يجب أن يكون رقماً موجباً أو صفراً.');
    }

    // Optional numerics
    const piecesParsed = parseNumericCell(getCell(row, 'piecesPerWholesaleUnit'));
    if (!piecesParsed.empty && (!piecesParsed.valid || (piecesParsed.value ?? 0) < 1)) {
      addError(rowNumber, 'piecesPerWholesaleUnit', 'عدد القطع في الكرتونة يجب أن يكون رقماً أكبر من أو يساوي 1.');
    }

    const costBaseParsed = parseNumericCell(getCell(row, 'costPricePerBase'));
    if (!costBaseParsed.empty && (!costBaseParsed.valid || (costBaseParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'costPricePerBase', 'سعر الشراء يجب أن يكون رقماً غير سالب.');
    }

    const costCartonParsed = parseNumericCell(getCell(row, 'costPricePerCarton'));
    if (!costCartonParsed.empty && (!costCartonParsed.valid || (costCartonParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'costPricePerCarton', 'سعر شراء الكرتونة يجب أن يكون رقماً غير سالب.');
    }

    const wholesaleParsed = parseNumericCell(getCell(row, 'wholesalePricePerCarton'));
    if (!wholesaleParsed.empty && (!wholesaleParsed.valid || (wholesaleParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'wholesalePricePerCarton', 'سعر الجملة يجب أن يكون رقماً غير سالب.');
    }

    const halfWholesaleParsed = parseNumericCell(getCell(row, 'halfWholesalePricePerCarton'));
    if (!halfWholesaleParsed.empty && (!halfWholesaleParsed.valid || (halfWholesaleParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'halfWholesalePricePerCarton', 'سعر نص الجملة يجب أن يكون رقماً غير سالب.');
    }

    const openingParsed = parseNumericCell(getCell(row, 'openingBalance'));
    if (!openingParsed.empty && (!openingParsed.valid || (openingParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'openingBalance', 'الرصيد الافتتاحي يجب أن يكون رقماً غير سالب.');
    }

    const reorderParsed = parseNumericCell(getCell(row, 'reorderLevelPieces'));
    if (!reorderParsed.empty && (!reorderParsed.valid || (reorderParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'reorderLevelPieces', 'حد الطلب يجب أن يكون رقماً غير سالب.');
    }

    const expiryParsed = parseDateCell(getCell(row, 'expiryDate'));
    if (!expiryParsed.empty && !expiryParsed.valid) {
      addError(rowNumber, 'expiryDate', 'تاريخ الصلاحية غير صالح (الصيغة المعتمدة YYYY-MM-DD).');
    }

    const storageParsed = parseStorageTypeCell(getCell(row, 'storageType'));
    if (allowDairy && !storageParsed.empty && !storageParsed.valid) {
      addError(rowNumber, 'storageType', 'نوع التخزين غير معروف (استخدم: جاف، مبرد، أو مجمد).');
    }

    const weighingParsed = parseBooleanCell(getCell(row, 'isWeighing'));
    if (allowWeighing && !weighingParsed.empty && !weighingParsed.valid) {
      addError(rowNumber, 'isWeighing', 'قيمة "يباع بالميزان" غير صالحة (استخدم: نعم أو لا).');
    }

    const tareParsed = parseNumericCell(getCell(row, 'tareGrams'));
    if (allowWeighing && !tareParsed.empty && (!tareParsed.valid || (tareParsed.value ?? 0) < 0)) {
      addError(rowNumber, 'tareGrams', 'وزن الفارغ بالجرام يجب أن يكون رقماً غير سالب.');
    }

    const pieces = !piecesParsed.empty && piecesParsed.valid ? (piecesParsed.value as number) : 1;
    const retailPrice = retailParsed.valid && !retailParsed.empty ? (retailParsed.value as number) : 0;

    let costPerBase = 0;
    let costPerCarton = 0;
    if (!costBaseParsed.empty && costBaseParsed.valid) {
      costPerBase = costBaseParsed.value as number;
      costPerCarton =
        !costCartonParsed.empty && costCartonParsed.valid
          ? (costCartonParsed.value as number)
          : round2(costPerBase * pieces);
    } else if (!costCartonParsed.empty && costCartonParsed.valid) {
      costPerCarton = costCartonParsed.value as number;
      costPerBase = round2(costPerCarton / Math.max(1, pieces));
    }

    const wholesalePrice =
      !wholesaleParsed.empty && wholesaleParsed.valid
        ? (wholesaleParsed.value as number)
        : round2(retailPrice * pieces);

    const halfWholesalePrice =
      !halfWholesaleParsed.empty && halfWholesaleParsed.valid
        ? (halfWholesaleParsed.value as number)
        : wholesalePrice;

    // Matching: barcode first, normalized name only when barcode is absent
    let matchedExisting: Product | undefined;
    if (barcodeRaw) {
      matchedExisting = existingByBarcode.get(barcodeRaw);
    } else if (name) {
      matchedExisting = existingByName.get(normalizeNameForMatch(name));
    }

    parsedRows.push({
      rowNumber,
      name,
      baseUnit,
      retailPricePerBase: retailPrice,
      barcode: barcodeRaw,
      cartonBarcode,
      code,
      category,
      brand,
      wholesaleUnit,
      piecesPerWholesaleUnit: pieces,
      hasCustomPiecesPerUnit: !piecesParsed.empty && piecesParsed.valid,
      costPricePerBase: costPerBase,
      hasCostPerBase: !costBaseParsed.empty && costBaseParsed.valid,
      costPricePerCarton: costPerCarton,
      hasCostPerCarton: !costCartonParsed.empty && costCartonParsed.valid,
      wholesalePricePerCarton: wholesalePrice,
      hasWholesalePrice: !wholesaleParsed.empty && wholesaleParsed.valid,
      halfWholesalePricePerCarton: halfWholesalePrice,
      hasHalfWholesalePrice: !halfWholesaleParsed.empty && halfWholesaleParsed.valid,
      openingBalance: !openingParsed.empty && openingParsed.valid ? (openingParsed.value as number) : 0,
      hasOpeningBalance: !openingParsed.empty && openingParsed.valid,
      reorderLevelPieces: !reorderParsed.empty && reorderParsed.valid ? (reorderParsed.value as number) : 0,
      hasReorderLevel: !reorderParsed.empty && reorderParsed.valid,
      expiryDate: expiryParsed.valid ? expiryParsed.value : undefined,
      batchNumber,
      storageType: allowDairy ? (storageParsed.valid ? storageParsed.value : undefined) : undefined,
      isWeighing: allowWeighing
        ? weighingParsed.valid && !weighingParsed.empty
          ? weighingParsed.value
          : scaleBarcodePrefix
          ? true
          : undefined
        : undefined,
      scaleBarcodePrefix,
      tareGrams: allowWeighing && !tareParsed.empty && tareParsed.valid ? tareParsed.value : undefined,
      matchType: matchedExisting ? 'EXISTING' : 'NEW',
      existingProductId: matchedExisting?.id,
      existingProductName: matchedExisting?.name,
    });
  }

  const newRows = parsedRows.filter(r => r.matchType === 'NEW' && !invalidRowSet.has(r.rowNumber)).length;
  const duplicateExistingRows = parsedRows.filter(
    r => r.matchType === 'EXISTING' && !invalidRowSet.has(r.rowNumber)
  ).length;

  return {
    ok: errors.length === 0,
    fileName,
    fileFormat,
    totalRows: nonEmptyEntries.length,
    newRows,
    duplicateExistingRows,
    invalidRows: invalidRowSet.size,
    errors,
    rows: parsedRows,
    recognizedColumns,
  };
}

/**
 * Executes an all-or-nothing import:
 * 1. Verifies RBAC & zero validation errors.
 * 2. Takes a dedicated `pre_import` snapshot before mutating anything.
 * 3. Creates new products at stockPieces = 0, then records StockAdjustment (`OPENING_BALANCE` / 'رصيد افتتاحي').
 * 4. In UPDATE mode, updates metadata/prices on matched items without modifying stockPieces.
 * 5. Calls `await storage.flush()` and rolls back completely on any failure.
 */
export async function executeProductImport(params: {
  preview: ProductImportPreview;
  duplicateMode: ImportDuplicateMode;
  user: User | null | undefined;
  options?: {
    simulateSnapshotFailure?: boolean;
    simulateFlushFailure?: boolean;
  };
}): Promise<ExecuteImportResult> {
  const { preview, duplicateMode, user, options } = params;

  if (!user || (user.role !== 'ADMIN' && !user.permissions?.canManageProducts)) {
    return {
      success: false,
      error: 'غير مصرح: استيراد الأصناف مقتصر على المدير أو من يملك صلاحية إدارة الأصناف.',
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      openingAdjustmentsCount: 0,
    };
  }

  if (preview.fatalError || preview.errors.length > 0 || !preview.ok) {
    return {
      success: false,
      error:
        preview.fatalError ||
        `يوجد ${preview.errors.length} أخطاء في بيانات الملف؛ يجب معالجتها أولاً قبل التنفيذ.`,
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      openingAdjustmentsCount: 0,
    };
  }

  if (preview.rows.length === 0) {
    return {
      success: false,
      error: 'لا توجد صفوف صالحة للاستيراد.',
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      openingAdjustmentsCount: 0,
    };
  }

  const actionableNew = preview.rows.filter(r => r.matchType === 'NEW');
  const actionableExisting = preview.rows.filter(r => r.matchType === 'EXISTING');
  if (actionableNew.length === 0 && (duplicateMode === 'SKIP' || actionableExisting.length === 0)) {
    return {
      success: false,
      error: 'جميع الأصناف في الملف موجودة مسبقاً ووضع التخطي مفعّل، لا توجد أصناف جديدة لإضافتها.',
      addedCount: 0,
      updatedCount: 0,
      skippedCount: actionableExisting.length,
      openingAdjustmentsCount: 0,
    };
  }

  // Step 1: Mandatory pre_import snapshot before any mutation
  let snapshotId: string | undefined;
  if (options?.simulateSnapshotFailure) {
    return {
      success: false,
      error: 'تعذر إنشاء لقطة الأمان التلقائية (قبل الاستيراد). تم إيقاف الاستيراد بالكامل ولم يتغير أي صنف.',
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      openingAdjustmentsCount: 0,
    };
  }

  if (typeof indexedDB !== 'undefined') {
    const snap = await snapshotService.createSnapshot('pre_import', undefined, undefined, { force: true });
    if (!snap) {
      return {
        success: false,
        error: 'تعذر إنشاء لقطة الأمان التلقائية (قبل الاستيراد). تم إيقاف الاستيراد بالكامل ولم يتغير أي صنف.',
        addedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        openingAdjustmentsCount: 0,
      };
    }
    snapshotId = snap.id;
  }

  // Step 2: Capture clean deep rollback copies before any modification
  const prevProducts: Product[] = JSON.parse(JSON.stringify(storage.getProducts()));
  const prevAdjustments: StockAdjustment[] = JSON.parse(JSON.stringify(storage.getStockAdjustments()));
  const prevAuditLogs = JSON.parse(JSON.stringify(storage.getAuditLogs()));
  const prevWriteError = storage.getWriteError();

  try {
    const now = new Date();
    const importDateStr = getCairoDateString(now);
    const importTimeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const baseTs = now.getTime();

    const nextProducts: Product[] = JSON.parse(JSON.stringify(prevProducts));
    const nextAdjustments: StockAdjustment[] = JSON.parse(JSON.stringify(prevAdjustments));

    const existingCodes = new Set(nextProducts.map(p => p.code));
    let autoCodeSeq = nextProducts.length + 101;
    const nextUniqueCode = (): string => {
      while (existingCodes.has(`PRD-${autoCodeSeq}`)) {
        autoCodeSeq++;
      }
      const c = `PRD-${autoCodeSeq}`;
      existingCodes.add(c);
      autoCodeSeq++;
      return c;
    };

    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let openingAdjustmentsCount = 0;

    const newProductsToPrepend: Product[] = [];
    const newAdjustmentsToPrepend: StockAdjustment[] = [];

    preview.rows.forEach((row, index) => {
      if (row.matchType === 'EXISTING') {
        if (duplicateMode === 'SKIP') {
          skippedCount++;
          return;
        }
        // UPDATE mode: modify prices & metadata ONLY, NEVER modify stockPieces
        const target = nextProducts.find(p => p.id === row.existingProductId);
        if (!target) {
          skippedCount++;
          return;
        }

        const effectivePieces = row.hasCustomPiecesPerUnit
          ? row.piecesPerWholesaleUnit
          : Math.max(1, target.piecesPerWholesaleUnit);

        target.name = row.name;
        target.baseUnit = row.baseUnit;
        target.retailPricePerBase = row.retailPricePerBase;
        if (row.barcode) target.barcode = row.barcode;
        if (row.cartonBarcode !== undefined) target.cartonBarcode = row.cartonBarcode;
        if (row.code) target.code = row.code;
        if (row.category && row.category !== 'عام') target.category = row.category;
        if (row.brand && row.brand !== 'عام') target.brand = row.brand;
        if (row.wholesaleUnit && row.wholesaleUnit !== 'كرتونة') target.wholesaleUnit = row.wholesaleUnit;
        target.piecesPerWholesaleUnit = effectivePieces;

        if (row.hasCostPerBase) {
          target.costPricePerBase = row.costPricePerBase;
          target.costPricePerCarton = row.hasCostPerCarton
            ? row.costPricePerCarton
            : round2(row.costPricePerBase * effectivePieces);
        } else if (row.hasCostPerCarton) {
          target.costPricePerCarton = row.costPricePerCarton;
          target.costPricePerBase = round2(row.costPricePerCarton / Math.max(1, effectivePieces));
        }

        if (row.hasWholesalePrice) {
          target.wholesalePricePerCarton = row.wholesalePricePerCarton;
          target.halfWholesalePricePerCarton = row.hasHalfWholesalePrice
            ? row.halfWholesalePricePerCarton
            : row.wholesalePricePerCarton;
        } else if (row.hasHalfWholesalePrice) {
          target.halfWholesalePricePerCarton = row.halfWholesalePricePerCarton;
        }

        if (row.hasReorderLevel) target.reorderLevelPieces = row.reorderLevelPieces;
        if (row.expiryDate !== undefined) target.expiryDate = row.expiryDate;
        if (row.batchNumber !== undefined) target.batchNumber = row.batchNumber;
        if (row.storageType !== undefined) target.storageType = row.storageType;
        if (row.isWeighing !== undefined) target.isWeighing = row.isWeighing;
        if (row.scaleBarcodePrefix !== undefined) target.scaleBarcodePrefix = row.scaleBarcodePrefix;
        if (row.tareGrams !== undefined) target.tareGrams = row.tareGrams;

        // Explicitly DO NOT touch target.stockPieces!
        updatedCount++;
        return;
      }

      // NEW product: always initialized at stockPieces: 0 first
      const productId = `p-imp-${baseTs}-${index}`;
      const productCode = row.code || nextUniqueCode();
      const newProduct: Product = {
        id: productId,
        code: productCode,
        barcode: row.barcode,
        cartonBarcode: row.cartonBarcode,
        name: row.name,
        category: row.category,
        brand: row.brand,
        baseUnit: row.baseUnit,
        wholesaleUnit: row.wholesaleUnit,
        piecesPerWholesaleUnit: row.piecesPerWholesaleUnit,
        costPricePerBase: row.costPricePerBase,
        costPricePerCarton: row.costPricePerCarton,
        retailPricePerBase: row.retailPricePerBase,
        wholesalePricePerCarton: row.wholesalePricePerCarton,
        halfWholesalePricePerCarton: row.halfWholesalePricePerCarton,
        stockPieces: 0, // Must remain 0 initially; opening balance is recorded via StockAdjustment
        reorderLevelPieces: row.reorderLevelPieces,
        expiryDate: row.expiryDate,
        batchNumber: row.batchNumber,
        isActive: true,
        isWeighing: row.isWeighing,
        storageType: row.storageType,
        tareGrams: row.tareGrams,
        scaleBarcodePrefix: row.scaleBarcodePrefix,
      };

      // Opening balance recorded strictly via StockAdjustment ('OPENING_BALANCE' / 'رصيد افتتاحي')
      if (row.openingBalance > 0) {
        const adj: StockAdjustment = {
          id: `adj-imp-${baseTs}-${index}`,
          date: importDateStr,
          time: importTimeStr,
          productId: newProduct.id,
          productName: newProduct.name,
          productCode: newProduct.code,
          previousPieces: 0,
          differencePieces: row.openingBalance,
          newPieces: row.openingBalance,
          reason: 'OPENING_BALANCE',
          reasonArabic: 'رصيد افتتاحي',
          notes: `رصيد افتتاحي عند الاستيراد من الملف: ${preview.fileName}`,
          performedBy: user.fullName,
        };
        newProduct.stockPieces = adj.newPieces;
        newAdjustmentsToPrepend.push(adj);
        openingAdjustmentsCount++;
      }

      newProductsToPrepend.push(newProduct);
      addedCount++;
    });

    const finalProducts = [...newProductsToPrepend, ...nextProducts];
    const finalAdjustments = [...newAdjustmentsToPrepend, ...nextAdjustments];

    storage.setItem(STORAGE_KEYS.PRODUCTS, finalProducts);
    storage.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, finalAdjustments);
    storage.addAuditLog(
      'PRODUCT_IMPORT',
      'استيراد أصناف من ملف',
      'الأصناف',
      preview.fileName,
      `استيراد دفعة أصناف من الملف (${preview.fileName}) بواسطة (${user.fullName}): إضافة ${addedCount} صنف جديد، تحديث ${updatedCount} صنف، تخطي ${skippedCount} صنف، تسجيل ${openingAdjustmentsCount} تسوية رصيد افتتاحي`
    );

    if (options?.simulateFlushFailure) {
      throw new Error('فشل محاكى أثناء حفظ الدفعة في التخزين الدائم');
    }

    await storage.flush();
    const writeErr = storage.getWriteError();
    if (writeErr) {
      throw new Error(writeErr);
    }

    storage.notifyAction(`استيراد ${addedCount} صنف من ${preview.fileName}`);

    return {
      success: true,
      addedCount,
      updatedCount,
      skippedCount,
      openingAdjustmentsCount,
      snapshotId,
    };
  } catch (err: any) {
    // Full atomic rollback so NOTHING changes in memory or persistent storage
    storage.setItem(STORAGE_KEYS.PRODUCTS, prevProducts);
    storage.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, prevAdjustments);
    storage.setItem(STORAGE_KEYS.AUDIT_LOGS, prevAuditLogs);
    storage.setWriteError(prevWriteError);
    try {
      await storage.flush();
    } catch {
      // ignore secondary flush error in fallback test mode
    }

    return {
      success: false,
      error: `فشل تنفيذ الاستيراد وتم التراجع الكامل دون تعديل أي بيانات: ${err?.message || 'خطأ غير متوقع'}`,
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      openingAdjustmentsCount: 0,
      snapshotId,
    };
  }
}
