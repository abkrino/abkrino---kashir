export type Role = 'ADMIN' | 'SALES';
export type StorageType = 'AMBIENT' | 'CHILLED' | 'FROZEN'; // عادي / تبريد ثلاجة (ألبان وأجبان) / مجمدات

export interface UserPermissions {
  canEditPrice: boolean; // تعديل سعر بيع الوحدة في الفاتورة
  canGiveDiscount: boolean; // إعطاء خصم على الفاتورة
  canSellNegativeStock: boolean; // البيع والصرف بالسالب من المخزن
  canDeleteInvoice: boolean; // حذف فواتير المبيعات
  canEditInvoice: boolean; // تعديل فواتير المبيعات
  canViewProfits: boolean; // مشاهدة أرباح الفواتير والتقارير المالية
  canManageProducts: boolean; // إضافة وتعديل الأصناف والشركات
  canManagePurchases: boolean; // تسجيل فواتير الشراء
  canManageCash: boolean; // إدارة الخزينة والمصروفات
}

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  pinCode: string; // كلمة المرور / الرقم السري
  phone?: string;
  avatarColor?: string;
  permissions?: UserPermissions;
}

export interface Product {
  id: string;
  code: string;
  barcode: string;
  cartonBarcode?: string;
  name: string;
  category: string;
  brand: string; // جهينة، دومتي، عبور لاند، المراعي، إيديتا، شيبسي...
  baseUnit: string; // قطعة / عبوة / كيس / كجم / لتر / برطمان / كوب
  wholesaleUnit: string; // كرتونة / علبة / بالتة
  piecesPerWholesaleUnit: number; // عدد القطع بالكرتونة

  // Costs (Admin only visible)
  costPricePerBase: number;
  costPricePerCarton: number;

  // Selling Prices (الأسعار)
  retailPricePerBase: number; // سعر بيع المستهلك القطاعي (الأساسي للسوبر ماركت)
  wholesalePricePerCarton: number;
  halfWholesalePricePerCarton: number;
  
  // المخزن الموحد
  stockPieces: number; // إجمالي الرصيد (بالقطع أو بالكيلوجرام)
  
  reorderLevelPieces: number; // حد الطلب
  expiryDate?: string;
  batchNumber?: string;
  isActive: boolean;

  // خيارات السوبر ماركت وقسم الألبان والميزان
  isWeighing?: boolean; // يباع بالميزان (وزن بالكيلو والجرام مثل الجبن والرومي والقشطة)
  storageType?: StorageType; // تبريد ثلاجة / مجمدات / جاف
  tareGrams?: number; // وزن الفارغ بالجرام
  scaleBarcodePrefix?: string; // بادئة كود الميزان مثل 20 أو 21
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string;
  area: string; // المنطقة / خط السير
  creditLimit: number;
  openingBalance?: number; // الرصيد الافتتاحي
  currentBalance: number; // رصيد الحساب (موجب = مدين عليه فلوس)
  priceTier: 'WHOLESALE' | 'HALF_WHOLESALE' | 'RETAIL';
  isCreditAllowed: boolean;
  notes?: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  type: 'COMPANY' | 'WHOLESALER'; // شركة منتجة أو تاجر جملة
  phone: string;
  contactPerson: string;
  openingBalance?: number; // الرصيد الافتتاحي
  currentBalance: number;
  paymentTermsDays: number;
}

export interface InvoiceLineItem {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  unit: 'CARTON' | 'PIECE' | 'KG' | 'GRAM';
  unitLabel: string;
  quantity: number; // e.g. 1 or 0.25 (kg)
  piecesCount: number;
  unitPrice: number; // سعر الوحدة القابل للتعديل
  defaultUnitPrice: number; // السعر الافتراضي للمقارنة
  costPrice: number; // تكلفة الشراء لاحتساب الربح
  totalPrice: number;
  discount: number;
  lineProfit: number; // ربح السطر = totalPrice - (costPrice * quantity)
  // Retail & scale specifics
  isWeighed?: boolean;
  weightGrams?: number;
  storageType?: StorageType;
}

export interface ParkedCart {
  id: string;
  parkedAt: string;
  customerName: string;
  items: InvoiceLineItem[];
  discountType: 'AMOUNT' | 'PERCENT';
  discountValue: number;
  notes?: string;
}

export interface SalesInvoice {
  id: string;
  invoiceNumber: string;
  date: string;
  time: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  salespersonId: string;
  salespersonName: string;
  items: InvoiceLineItem[];
  subtotal: number;
  
  // نوع الخصم: قيمة بالجنيه أو نسبة مئوية
  discountType: 'AMOUNT' | 'PERCENT';
  discountValue: number; // القيمة المدخلة (مثلاً 5% أو 50 ج.م)
  discountAmount: number; // الخصم الفعلي بالجنيه
  
  total: number;
  paidAmount: number;
  changeDue?: number; // الباقي المستحق للزبون عند دفع نقدية أكبر
  remainingAmount: number;
  paymentType: 'CASH' | 'CARD' | 'WALLET' | 'CREDIT' | 'SPLIT';
  paymentMethodDetails?: string; // تفاصيل إضافية (فودافون كاش / إنستاباي / فيزا البنك الأهلي)
  
  // تتبع المديونية بدقة للطباعة
  previousCustomerBalance: number; // مديونية العميل السابقة قبل هذه الفاتورة
  newCustomerBalance: number; // إجمالي مديونية العميل بعد الفاتورة
  
  // ربح الفاتورة (للعرض على الشاشة فقط، لا يطبع)
  totalCost: number; // إجمالي التكلفة
  totalProfit: number; // صافي ربح الفاتورة
  
  notes?: string;
  hasNegativeStockItem?: boolean; // هل تم الخصم بالسالب
  isReprint?: boolean;
  isDelivery?: boolean; // هل طلب دليفري
  deliveryAddress?: string;
  status: 'POSTED' | 'MODIFIED' | 'RETURNED';
}

export interface PurchaseItem {
  productId: string;
  productName: string;
  unit: 'CARTON' | 'PIECE' | 'PALLET';
  quantity: number;
  unitCost: number; // سعر الشراء القابل للتعديل
  totalCost: number;
  batchNumber?: string;
  expiryDate?: string;
}

export interface PurchaseInvoice {
  id: string;
  invoiceNumber: string;
  supplierInvoiceNumber?: string;
  date: string;
  time?: string;
  supplierId: string;
  supplierName: string;
  supplierType: 'COMPANY' | 'WHOLESALER'; // شراء من شركة أو تاجر جملة
  items: PurchaseItem[];
  subtotal: number;
  discountAmount: number;
  freightCost: number;
  
  // البونص: نقدي في الأرباح أو بضاعة مجانية في المخزن
  bonusType?: 'NONE' | 'CASH' | 'GOODS';
  bonusAmount?: number; // بونص نقدي / خصم إضافي
  bonusGoodsQuantity?: number; // بونص بضاعة
  bonusNotes?: string;

  totalCost: number;
  paidAmount: number;
  remainingAmount: number;
  paymentType: 'CASH' | 'CREDIT';

  // تتبع مديونية المورد السابقة والجديدة
  previousSupplierBalance: number;
  newSupplierBalance: number;

  isStockInserted: boolean; // هل تم إدراج البضاعة في المخزن
  notes?: string;
}

export interface StockAdjustment {
  id: string;
  date: string;
  time: string;
  productId: string;
  productName: string;
  productCode: string;
  previousPieces: number;
  differencePieces: number; // الفرق بالقطع (+ زيادة أو - عجز)
  newPieces: number;
  reason: 'AUDIT' | 'DAMAGE' | 'EXPIRY' | 'BONUS' | 'CORRECTION' | 'OTHER';
  reasonArabic: string;
  notes?: string;
  performedBy: string;
}

export interface CashMovement {
  id: string;
  date: string;
  time: string;
  type: 'IN' | 'OUT';
  category: 'SALES_CASH' | 'CUSTOMER_COLLECTION' | 'SUPPLIER_PAYMENT' | 'EXPENSE' | 'OPENING_BALANCE' | 'DRAWER_ADJUSTMENT' | 'INVOICE_REVERSAL';
  categoryLabelArabic: string;
  amount: number;
  referenceId?: string;
  description: string;
  performedBy: string;
  supplierId?: string;
  supplierName?: string;
  fundingSource?: 'DRAWER' | 'PERSONAL_LOAN' | 'DRAWER_NEGATIVE' | 'OTHER';
}

export interface Expense {
  id: string;
  date: string;
  category: 'RENT' | 'ELECTRICITY' | 'HOSPITALITY' | 'TRANSPORT' | 'LABOR' | 'MAINTENANCE' | 'OTHER';
  categoryLabelArabic: string;
  amount: number;
  notes: string;
  recordedBy: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  username: string;
  action: string;
  actionArabic: string;
  entity: string;
  entityId: string;
  details: string;
}

export interface SystemShift {
  id: string;
  date: string;
  openedAt: string;
  closedAt?: string;
  openedBy: string;
  openingCash: number;
  expectedClosingCash: number;
  actualClosingCash?: number;
  difference?: number;
  status: 'OPEN' | 'CLOSED';
}

// --- CLOUD ARCHITECTURE TYPES ("الكلود") ---
export interface CloudBackupItem {
  id: string;
  timestamp: string;
  dateStr: string;
  timeStr: string;
  itemCounts: {
    products: number;
    customers: number;
    suppliers: number;
    invoices: number;
    cashMovements: number;
  };
  totalValuation: number;
  payloadJson: string;
  createdBy: string;
  sizeBytes?: number;
}

export interface CloudAlert {
  id: string;
  title: string;
  body: string;
  type: 'STOCK' | 'EXPIRY' | 'FINANCE' | 'SYSTEM' | 'SYNC';
  timestamp: string;
  read: boolean;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  linkTab?: string;
}

export interface CrashReport {
  id: string;
  timestamp: string;
  message: string;
  component: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  stack?: string;
  resolved: boolean;
  offlineOccurred: boolean;
}

export interface PerformanceMetric {
  id: string;
  operation: string;
  durationMs: number;
  status: 'SUCCESS' | 'SLOW' | 'FAILED';
  timestamp: string;
  networkOnline: boolean;
}

export interface CloudSettings {
  autoSyncOnAction: boolean; // حفظ نسخة على الكلود بعد كل عملية
  primaryEmail: string; // الإيميل الأساسي mahmoud.mansour0b@gmail.com
  autoBackupIntervalHours: number; // 24
  autoFunctionsEnabled: boolean; // محرك مهام الكلود التلقائية
  crashReportingEnabled: boolean;
  performanceMonitoringEnabled: boolean;
  lastCloudSyncTimestamp?: string;
}

