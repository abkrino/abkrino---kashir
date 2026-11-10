import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Product, Customer, InvoiceLineItem, SalesInvoice, User, ParkedCart } from '../../types';
import { storage } from '../../services/storageService';
import { 
  Barcode, 
  Search, 
  Trash2, 
  Plus, 
  Minus, 
  Save, 
  Printer, 
  AlertCircle, 
  UserPlus, 
  Package, 
  TrendingUp, 
  Coins, 
  AlertTriangle, 
  RotateCcw, 
  Eye, 
  EyeOff, 
  CheckCircle2, 
  Store, 
  RefreshCw,
  Building2,
  Tag,
  Receipt,
  Scale,
  Clock,
  PauseCircle,
  PlayCircle,
  CreditCard,
  Smartphone,
  Banknote,
  Milk,
  ShoppingBag,
  Sparkles,
  Calendar,
  Flame,
  Star,
  LayoutGrid,
  SlidersHorizontal,
  X
} from 'lucide-react';

interface PosSalesProps {
  currentUser: User;
  onInvoiceCreated: (invoice: SalesInvoice, shouldPrint?: boolean) => void;
  onOpenCustomerModal: () => void;
  editingInvoice?: SalesInvoice | null;
  onCancelEdit?: () => void;
}

export const PosSales: React.FC<PosSalesProps> = ({
  currentUser,
  onInvoiceCreated,
  onOpenCustomerModal,
  editingInvoice,
  onCancelEdit,
}) => {
  const isAdmin = currentUser.role === 'ADMIN' || currentUser.permissions?.canViewProfits;

  // Safe default walk-in customer fallback
  const DEFAULT_WALKIN_CUSTOMER: Customer = {
    id: 'cust-walkin',
    name: 'زبون المحل المباشر (كاش)',
    phone: '01000000000',
    area: 'مبيعات المحل القطاعي',
    code: 'CUST-001',
    priceTier: 'RETAIL',
    isCreditAllowed: false,
    creditLimit: 0,
    currentBalance: 0
  };

  const [products, setProducts] = useState<Product[]>(() => storage.getProducts());
  const [customers, setCustomers] = useState<Customer[]>(() => {
    const list = storage.getCustomers();
    return list.length > 0 ? list : [DEFAULT_WALKIN_CUSTOMER];
  });
  const [parkedCarts, setParkedCarts] = useState<ParkedCart[]>(() => storage.getParkedCarts());
  
  // Invoice Customer & Customer Search State
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(() => {
    const custs = storage.getCustomers();
    const cashCust = custs.find(c => c.priceTier === 'RETAIL' || c.name.includes('نقدي')) || custs[0];
    return cashCust ? cashCust.id : DEFAULT_WALKIN_CUSTOMER.id;
  });
  const [customerSearchQuery, setCustomerSearchQuery] = useState<string>('');
  const [isCustomerDropdownOpen, setIsCustomerDropdownOpen] = useState<boolean>(false);

  // Invoice Items
  const [items, setItems] = useState<InvoiceLineItem[]>([]);
  
  // Discount: Amount or Percent
  const [discountType, setDiscountType] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [discountValue, setDiscountValue] = useState<number>(0);
  
  // Payment: CASH, CARD, WALLET, CREDIT, SPLIT
  const [paymentType, setPaymentType] = useState<'CASH' | 'CARD' | 'WALLET' | 'CREDIT' | 'SPLIT'>('CASH');
  const [paymentMethodDetails, setPaymentMethodDetails] = useState<string>('');
  const [customPaidAmount, setCustomPaidAmount] = useState<number>(0);
  const [tenderCashGiven, setTenderCashGiven] = useState<number | ''>(''); // نقدية الزبون لحساب الباقي
  const [notes, setNotes] = useState<string>('');
  
  // Catalog Search & Category Filter
  const [catalogSearchQuery, setCatalogSearchQuery] = useState<string>('');
  const [catalogCategory, setCatalogCategory] = useState<string>('ALL');

  // Grid Capacity & Column Sizing Control (3, 4, 5, 6, 7 columns)
  const [gridColumns, setGridColumns] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('sm_pos_grid_cols');
      return saved ? parseInt(saved, 10) : 5;
    } catch {
      return 5;
    }
  });

  // Individual Product Card Size Control ('COMPACT' | 'MEDIUM' | 'LARGE')
  const [cardSize, setCardSize] = useState<'COMPACT' | 'MEDIUM' | 'LARGE'>(() => {
    try {
      const saved = localStorage.getItem('sm_pos_card_size');
      return (saved === 'COMPACT' || saved === 'LARGE') ? saved : 'MEDIUM';
    } catch {
      return 'MEDIUM';
    }
  });

  const handleSetGridColumns = (cols: number) => {
    const clamped = Math.max(3, Math.min(7, cols));
    setGridColumns(clamped);
    try {
      localStorage.setItem('sm_pos_grid_cols', clamped.toString());
    } catch {}
  };

  const handleSetCardSize = (size: 'COMPACT' | 'MEDIUM' | 'LARGE') => {
    setCardSize(size);
    try {
      localStorage.setItem('sm_pos_card_size', size);
    } catch {}
  };

  // Barcode & Alerts
  const [barcodeInput, setBarcodeInput] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [negativeStockWarning, setNegativeStockWarning] = useState<string | null>(null);

  // Profit Masking State (Admin only)
  const [showProfitNumber, setShowProfitNumber] = useState<boolean>(false);

  // Mobile / Tablet Tab View: 'INVOICE' vs 'CATALOG'
  const [mobileView, setMobileView] = useState<'INVOICE' | 'CATALOG'>('INVOICE');
  const [itemAddedToast, setItemAddedToast] = useState<string | null>(null);

  // Weighing Scale Modal State (لأصناف الألبان والأجبان بالميزان)
  const [weighingProduct, setWeighingProduct] = useState<Product | null>(null);
  const [weighingGrams, setWeighingGrams] = useState<number>(250);
  const [includeTare, setIncludeTare] = useState<boolean>(true);

  // Parked Carts Modal
  const [isParkedModalOpen, setIsParkedModalOpen] = useState<boolean>(false);

  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const loadData = () => {
    const prods = storage.getProducts();
    const custs = storage.getCustomers();
    const parked = storage.getParkedCarts();
    setProducts(prods);
    setCustomers(custs.length > 0 ? custs : [DEFAULT_WALKIN_CUSTOMER]);
    setParkedCarts(parked);
    if (!selectedCustomerId && custs.length > 0) {
      const cashCust = custs.find(c => c.priceTier === 'RETAIL' || c.name.includes('نقدي')) || custs[0];
      setSelectedCustomerId(cashCust.id);
    }
  };

  useEffect(() => {
    loadData();
    barcodeInputRef.current?.focus();

    if (editingInvoice) {
      setSelectedCustomerId(editingInvoice.customerId);
      setItems(editingInvoice.items);
      setDiscountType(editingInvoice.discountType || 'AMOUNT');
      setDiscountValue(editingInvoice.discountValue || 0);
      setPaymentType(editingInvoice.paymentType);
      setPaymentMethodDetails(editingInvoice.paymentMethodDetails || '');
      setCustomPaidAmount(editingInvoice.paidAmount);
      setTenderCashGiven(editingInvoice.paidAmount);
      setNotes(editingInvoice.notes || '');
    }
  }, [editingInvoice]);

  // Global Keyboard Shortcuts (F8 -> Park, F9 -> Save, F10 -> Save & Print)
  useEffect(() => {
    const handlePosKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F9') {
        e.preventDefault();
        handleSaveInvoice(false);
      } else if (e.key === 'F10') {
        e.preventDefault();
        handleSaveInvoice(true);
      } else if (e.key === 'F8') {
        e.preventDefault();
        handleParkCurrentCart();
      }
    };
    window.addEventListener('keydown', handlePosKeyDown);
    return () => window.removeEventListener('keydown', handlePosKeyDown);
  }, [items, selectedCustomerId, discountType, discountValue, paymentType, customPaidAmount, notes, tenderCashGiven]);

  const selectedCustomer: Customer = (customers && customers.length > 0)
    ? (customers.find(c => c.id === selectedCustomerId) || customers[0] || DEFAULT_WALKIN_CUSTOMER)
    : DEFAULT_WALKIN_CUSTOMER;

  const isDirectStoreCustomer = Boolean(
    selectedCustomer && 
    (selectedCustomer.priceTier === 'RETAIL' || 
     (selectedCustomer.name && selectedCustomer.name.includes('نقدي')) || 
     (selectedCustomer.name && selectedCustomer.name.includes('المحل')) ||
     !selectedCustomer.isCreditAllowed)
  );

  const filteredCustomers = customers.filter(c => {
    if (!customerSearchQuery.trim()) return true;
    const q = customerSearchQuery.toLowerCase().trim();
    return c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.area.toLowerCase().includes(q) || c.code.toLowerCase().includes(q);
  });

  // Categories list tailored for supermarket & retail
  const SUPERMARKET_CATEGORIES = [
    { id: 'ALL', label: 'الكل', icon: ShoppingBag, color: 'text-slate-600' },
    { id: 'منتجات الألبان والأجبان', label: 'الألبان والأجبان', icon: Milk, color: 'text-blue-600' },
    { id: 'بقالة ومواد غذائية جافة', label: 'البقالة والتموين', icon: Package, color: 'text-amber-600' },
    { id: 'سناكس وبسكويت وحلويات', label: 'سناكس وحلويات', icon: Sparkles, color: 'text-rose-600' },
    { id: 'مشروبات وعصائر ومياه', label: 'مشروبات وعصائر', icon: Coins, color: 'text-cyan-600' },
    { id: 'مخبوزات وتوست', label: 'مخبوزات وتوست', icon: Store, color: 'text-orange-600' },
    { id: 'منظفات وعناية منزلية', label: 'منظفات وعناية', icon: Tag, color: 'text-emerald-600' },
  ];

  // Helper to calculate price per customer tier
  const getDefaultPrice = (product: Product, unit: 'CARTON' | 'PIECE' | 'KG', customer?: Customer) => {
    const tier = customer?.priceTier || 'RETAIL';
    if (unit === 'KG') {
      return product.retailPricePerBase; // price per KG
    }
    if (unit === 'CARTON') {
      if (tier === 'HALF_WHOLESALE') return product.halfWholesalePricePerCarton;
      if (tier === 'WHOLESALE') return product.wholesalePricePerCarton;
      return (product.retailPricePerBase * (product.piecesPerWholesaleUnit || 1));
    } else {
      if (tier === 'WHOLESALE') return Math.round((product.wholesalePricePerCarton / (product.piecesPerWholesaleUnit || 1)) * 100) / 100;
      if (tier === 'HALF_WHOLESALE') return Math.round((product.halfWholesalePricePerCarton / (product.piecesPerWholesaleUnit || 1)) * 100) / 100;
      return product.retailPricePerBase;
    }
  };

  // Add Item to Invoice (piece/carton/kg)
  const addItemToInvoice = (
    product: Product, 
    unit: 'CARTON' | 'PIECE' | 'KG' = 'PIECE', 
    qty: number = 1,
    customPrice?: number,
    weighedGrams?: number
  ) => {
    setErrorMessage(null);

    // If item requires weighing and grams wasn't provided, trigger weighing modal
    if (product.isWeighing && unit === 'KG' && !weighedGrams) {
      setWeighingProduct(product);
      setWeighingGrams(250);
      return;
    }

    const defaultPrice = getDefaultPrice(product, unit, selectedCustomer);
    const finalUnitPrice = customPrice !== undefined && customPrice !== null ? customPrice : defaultPrice;
    
    // Pieces or KG count for stock deduction
    const piecesPerUnit = unit === 'CARTON' ? (product.piecesPerWholesaleUnit || 1) : 1;
    const requiredStockAmount = unit === 'KG' ? qty : (qty * piecesPerUnit);

    const currentInCart = items
      .filter(it => it.productId === product.id)
      .reduce((sum, it) => sum + (it.unit === 'KG' ? it.quantity : it.piecesCount), 0);

    const resultingStock = product.stockPieces - (currentInCart + requiredStockAmount);
    if (resultingStock < 0) {
      setNegativeStockWarning(
        `تنبيه صرف بالسالب: رصيد الصنف (${product.name}) حالياً ${product.stockPieces}، وسيصبح بالسالب (${resultingStock.toFixed(2)}).`
      );
    }

    const unitCost = unit === 'CARTON' ? product.costPricePerCarton : product.costPricePerBase;

    // Check if item already in basket (for weighted items, add as separate line or combine)
    const existingIndex = items.findIndex(it => it.productId === product.id && it.unit === unit);

    if (existingIndex >= 0 && unit !== 'KG') {
      const updated = [...items];
      const newQty = updated[existingIndex].quantity + qty;
      const newPieces = newQty * piecesPerUnit;
      const lineTotal = Math.round(newQty * updated[existingIndex].unitPrice * 100) / 100;
      const lineCost = newPieces * product.costPricePerBase;

      updated[existingIndex].quantity = newQty;
      updated[existingIndex].piecesCount = newPieces;
      updated[existingIndex].totalPrice = lineTotal;
      updated[existingIndex].lineProfit = lineTotal - lineCost;
      setItems(updated);
    } else {
      const lineTotal = Math.round(qty * finalUnitPrice * 100) / 100;
      const lineCost = requiredStockAmount * product.costPricePerBase;

      const unitLabel = unit === 'KG'
        ? `${qty.toFixed(3)} كجم (${weighedGrams || Math.round(qty * 1000)} جم)`
        : unit === 'CARTON'
        ? `${product.wholesaleUnit || 'كرتونة'}`
        : (product.baseUnit || 'قطعة');

      const newItem: InvoiceLineItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        unit,
        unitLabel,
        quantity: qty,
        piecesCount: unit === 'KG' ? 1 : requiredStockAmount,
        unitPrice: finalUnitPrice,
        defaultUnitPrice: defaultPrice,
        costPrice: unitCost,
        totalPrice: lineTotal,
        discount: 0,
        lineProfit: lineTotal - lineCost,
        isWeighed: unit === 'KG',
        weightGrams: weighedGrams,
        storageType: product.storageType,
      };
      setItems([...items, newItem]);
    }

    setItemAddedToast(`تمت إضافة ${product.name} (${unit === 'KG' ? `${qty} كجم` : unit === 'CARTON' ? 'كرتونة' : 'قطعة'}) ✓`);
    setTimeout(() => {
      setItemAddedToast(null);
    }, 2000);
  };

  // Barcode Scanner & Scale Barcode Parser
  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawBarcode = barcodeInput.trim();
    if (!rawBarcode) return;

    // 1. Check electronic scale barcode format: 20XXXXXWWWWWC or 21XXXXXPPPPPPC
    if ((rawBarcode.startsWith('20') || rawBarcode.startsWith('21')) && rawBarcode.length >= 12) {
      const codeDigits = rawBarcode.slice(2, 6); // 4 digits product code
      const weightDigits = rawBarcode.slice(6, 11); // 5 digits weight in grams (e.g. 00250 = 250g)
      const grams = parseInt(weightDigits, 10);

      // Find matching weighing product
      const foundWeighingProduct = products.find(
        p => p.isWeighing && (p.code.includes(codeDigits) || p.barcode.includes(codeDigits))
      );

      if (foundWeighingProduct && !isNaN(grams) && grams > 0) {
        const kg = grams / 1000;
        addItemToInvoice(foundWeighingProduct, 'KG', kg, undefined, grams);
        setBarcodeInput('');
        return;
      }
    }

    // 2. Standard Product lookup by barcode, cartonBarcode, or item code
    const foundProduct = products.find(
      p => p.barcode === rawBarcode || p.cartonBarcode === rawBarcode || p.code === rawBarcode
    );

    if (foundProduct) {
      if (foundProduct.isWeighing) {
        // Open weighing scale modal for cashier to enter/confirm grams
        setWeighingProduct(foundProduct);
        setWeighingGrams(250);
      } else {
        const isCarton = foundProduct.cartonBarcode === rawBarcode;
        addItemToInvoice(foundProduct, isCarton ? 'CARTON' : 'PIECE', 1);
      }
      setBarcodeInput('');
    } else {
      setErrorMessage(`الباركود (${rawBarcode}) غير مسجل في بطاقة الأصناف.`);
    }
  };

  // Confirm weighing item from modal
  const handleConfirmWeighing = () => {
    if (!weighingProduct) return;
    const tare = (includeTare && weighingProduct.tareGrams) ? weighingProduct.tareGrams : 0;
    const netGrams = Math.max(10, weighingGrams - tare);
    const kg = Math.round((netGrams / 1000) * 1000) / 1000;

    addItemToInvoice(weighingProduct, 'KG', kg, undefined, netGrams);
    setWeighingProduct(null);
    barcodeInputRef.current?.focus();
  };

  // Modify Item Price
  const updateItemPrice = (index: number, newPrice: number) => {
    const updated = [...items];
    const item = updated[index];
    const product = products.find(p => p.id === item.productId);
    const costPerBase = product ? product.costPricePerBase : 0;
    const totalLineCost = (item.unit === 'KG' ? item.quantity : item.piecesCount) * costPerBase;

    item.unitPrice = Math.max(0, newPrice);
    item.totalPrice = Math.round(item.quantity * item.unitPrice * 100) / 100;
    item.lineProfit = item.totalPrice - totalLineCost;
    setItems(updated);
  };

  // Modify Item Quantity
  const updateItemQuantity = (index: number, newQty: number) => {
    const safeQty = Math.max(itemIsWeighed(items[index]) ? 0.05 : 1, newQty);
    const updated = [...items];
    const item = updated[index];
    const product = products.find(p => p.id === item.productId);
    const piecesPerUnit = item.unit === 'CARTON' ? (product?.piecesPerWholesaleUnit || 1) : 1;
    const newPieces = item.unit === 'KG' ? 1 : (safeQty * piecesPerUnit);
    const costPerBase = product ? product.costPricePerBase : 0;
    const totalLineCost = (item.unit === 'KG' ? safeQty : newPieces) * costPerBase;

    item.quantity = Math.round(safeQty * 1000) / 1000;
    item.piecesCount = newPieces;
    item.totalPrice = Math.round(safeQty * item.unitPrice * 100) / 100;
    item.lineProfit = item.totalPrice - totalLineCost;

    setItems(updated);
  };

  const itemIsWeighed = (item: InvoiceLineItem) => item.unit === 'KG';

  const removeItem = (index: number) => {
    setItems(items.filter((_, idx) => idx !== index));
  };

  // Calculations
  const subtotal = Math.round(items.reduce((sum, it) => sum + it.totalPrice, 0) * 100) / 100;

  let discountAmount = 0;
  if (discountType === 'PERCENT') {
    discountAmount = Math.round(((subtotal * discountValue) / 100) * 100) / 100;
  } else {
    discountAmount = Math.min(subtotal, Math.max(0, discountValue));
  }

  const total = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);

  // Profit calculation (Operator screen only)
  const totalCost = items.reduce((sum, it) => {
    const prod = products.find(p => p.id === it.productId);
    const factor = it.unit === 'KG' ? it.quantity : it.piecesCount;
    return sum + (factor * (prod?.costPricePerBase || 0));
  }, 0);

  const totalProfit = Math.round((total - totalCost) * 100) / 100;

  // Tender & Change calculation
  let paidAmount = total;
  let remainingAmount = 0;

  if (paymentType === 'CREDIT') {
    paidAmount = 0;
    remainingAmount = total;
  } else if (paymentType === 'SPLIT') {
    paidAmount = Math.min(customPaidAmount, total);
    remainingAmount = Math.max(0, total - paidAmount);
  }

  // Cash change due (الباقي للعميل)
  const numericTender = typeof tenderCashGiven === 'number' ? tenderCashGiven : 0;
  const changeDue = (paymentType === 'CASH' && numericTender > total) 
    ? Math.round((numericTender - total) * 100) / 100 
    : 0;

  const previousCustomerBalance = selectedCustomer?.currentBalance || 0;
  const newCustomerBalance = previousCustomerBalance + remainingAmount;

  // Park (Hold) Current Cart
  const handleParkCurrentCart = () => {
    if (items.length === 0) {
      setErrorMessage('لا يمكن تعليق سلة فارغة.');
      return;
    }
    const cart: ParkedCart = {
      id: `park-${Date.now()}`,
      parkedAt: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      customerName: selectedCustomer?.name || DEFAULT_WALKIN_CUSTOMER.name,
      items,
      discountType,
      discountValue,
      notes,
    };
    storage.saveParkedCart(cart);
    setParkedCarts(storage.getParkedCarts());
    setItems([]);
    setDiscountValue(0);
    setNotes('');
    setTenderCashGiven('');
    setItemAddedToast('تم تعليق الفاتورة بنجاح. يمكنك استرجاعها في أي وقت ✓');
  };

  // Resume Parked Cart
  const handleResumeParkedCart = (cart: ParkedCart) => {
    setItems(cart.items);
    setDiscountType(cart.discountType);
    setDiscountValue(cart.discountValue);
    setNotes(cart.notes || '');
    storage.removeParkedCart(cart.id);
    setParkedCarts(storage.getParkedCarts());
    setIsParkedModalOpen(false);
    setItemAddedToast(`تم استرجاع فاتورة (${cart.customerName}) بنجاح ✓`);
  };

  // Save / Post Invoice
  const handleSaveInvoice = async (shouldPrint: boolean) => {
    if (items.length === 0) {
      setErrorMessage('لا يمكن حفظ فاتورة فارغة. يرجى إضافة أصناف أولاً.');
      return;
    }

    if (!selectedCustomer) {
      setErrorMessage('يرجى تحديد العميل المستلم للفاتورة.');
      return;
    }

    const now = new Date();
    const invoiceNum = editingInvoice ? editingInvoice.invoiceNumber : `INV-${now.getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const invoiceData: SalesInvoice = {
      id: editingInvoice ? editingInvoice.id : `inv-${Date.now()}`,
      invoiceNumber: invoiceNum,
      date: editingInvoice ? editingInvoice.date : now.toISOString().split('T')[0],
      time: editingInvoice ? editingInvoice.time : now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      customerId: selectedCustomer?.id || DEFAULT_WALKIN_CUSTOMER.id,
      customerName: selectedCustomer?.name || DEFAULT_WALKIN_CUSTOMER.name,
      customerPhone: selectedCustomer?.phone || DEFAULT_WALKIN_CUSTOMER.phone,
      salespersonId: currentUser.id,
      salespersonName: currentUser.fullName,
      items,
      subtotal,
      discountType,
      discountValue,
      discountAmount,
      total,
      paidAmount,
      changeDue,
      remainingAmount,
      paymentType,
      paymentMethodDetails,
      previousCustomerBalance,
      newCustomerBalance,
      totalCost,
      totalProfit,
      notes,
      hasNegativeStockItem: items.some(it => {
        const prod = products.find(p => p.id === it.productId);
        const req = it.unit === 'KG' ? it.quantity : it.piecesCount;
        return prod && prod.stockPieces < req;
      }),
      status: editingInvoice ? 'MODIFIED' : 'POSTED',
    };

    if (editingInvoice) {
      const res = storage.updateSalesInvoice(invoiceData);
      if (!res.success) {
        setErrorMessage(res.error || 'حدث خطأ أثناء تعديل الفاتورة');
        return;
      }
    } else {
      const res = storage.postSalesInvoice(invoiceData);
      if (!res.success) {
        setErrorMessage(res.error || 'حدث خطأ أثناء حفظ الفاتورة');
        return;
      }
    }

    // Requirement 3: Immediate flush to persistent storage before showing success/printing
    try {
      await storage.flush();
      if (storage.getWriteError()) {
        setErrorMessage(`تعذر تأكيد حفظ الفاتورة في التخزين الدائم: ${storage.getWriteError()}`);
        return;
      }
    } catch (flushErr: any) {
      setErrorMessage(`تعذر تأكيد حفظ الفاتورة في التخزين الدائم: ${flushErr?.message || 'خطأ في التخزين'}`);
      return;
    }

    onInvoiceCreated(invoiceData, shouldPrint);

    // Reset Form
    setItems([]);
    setDiscountValue(0);
    setPaymentType('CASH');
    setCustomPaidAmount(0);
    setTenderCashGiven('');
    setNotes('');
    setNegativeStockWarning(null);
    setSalesUpdateTick(prev => prev + 1);
    loadData();
    barcodeInputRef.current?.focus();
  };

  // Dynamic sales popularity score: counts how many times each item was sold
  const [salesUpdateTick, setSalesUpdateTick] = useState<number>(0);

  const productUsageScores = useMemo(() => {
    try {
      const invoices = storage.getSalesInvoices();
      const scores: Record<string, number> = {};

      // Seed core supermarket staples with baseline popular weight
      const defaultStapleWeights: Record<string, number> = {
        'sm-d1': 50,  // حليب جهينة كامل الدسم
        'sm-d3': 48,  // جبنة رومي قديم بطارخ
        'sm-d4': 45,  // جبنة براميلي فلاحي
        'sm-d6': 42,  // جبنة دومتي بلس فيتا
        'sm-d7': 40,  // جبنة عبور لاند تتراباك
        'sm-d8': 38,  // زبادي جهينة طبيعي
        'sm-d2': 36,  // حليب المراعي خالي الدسم
        'sm-d5': 35,  // قشطة فلاحي بلدي
        'sm-d9': 34,  // زبادي المراعي يوناني
        'sm-d10': 32, // جبنة كيري مربعات
        'sm-d11': 30, // حليب جهينة شوكولاتة
        'sm-g1': 28,  // سكر أبيض بلدي
        'sm-g2': 26,  // أرز مصري فاخر
        'sm-g3': 25,  // مكرونة الملكة
        'sm-s1': 24,  // شيبسي عائلي بالجبنة
        'sm-b1': 22,  // بيبسي كانز
        'sm-bk1': 20, // توست ريتش بيك
        'sm-c1': 18,  // مسحوق إريال
      };

      Object.entries(defaultStapleWeights).forEach(([id, weight]) => {
        scores[id] = weight;
      });

      // Aggregate all actual sales quantities
      invoices.forEach(inv => {
        if (Array.isArray(inv.items)) {
          inv.items.forEach(it => {
            scores[it.productId] = (scores[it.productId] || 0) + (it.quantity || 1) * 8;
          });
        }
      });

      return scores;
    } catch {
      return {};
    }
  }, [salesUpdateTick, products]);

  // Filter Catalog Products and automatically sort the most used/sold items to the top
  const filteredCatalogProducts = useMemo(() => {
    const list = products.filter(p => {
      if (!p.isActive) return false;
      if (catalogCategory !== 'ALL' && p.category !== catalogCategory) return false;
      if (!catalogSearchQuery.trim()) return true;
      const q = catalogSearchQuery.toLowerCase().trim();
      return (
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.brand && p.brand.toLowerCase().includes(q)) ||
        (p.barcode && p.barcode.includes(q))
      );
    });

    // Automatic sorting: highest sales usage score to the top!
    return list.sort((a, b) => {
      const scoreA = productUsageScores[a.id] || 0;
      const scoreB = productUsageScores[b.id] || 0;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      // If equal, prioritize fresh dairy items
      if (a.category === 'منتجات الألبان والأجبان' && b.category !== 'منتجات الألبان والأجبان') return -1;
      if (b.category === 'منتجات الألبان والأجبان' && a.category !== 'منتجات الألبان والأجبان') return 1;
      return a.name.localeCompare(b.name, 'ar');
    });
  }, [products, catalogCategory, catalogSearchQuery, productUsageScores]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4" dir="rtl">
      {/* Toast Alert */}
      {itemAddedToast && (
        <div className="lg:col-span-12 fixed top-16 left-4 right-4 z-50 flex justify-center pointer-events-none">
          <div className="bg-emerald-700 text-white font-bold text-xs sm:text-sm px-4 py-2.5 rounded-2xl shadow-2xl flex items-center gap-2 border border-emerald-500 animate-in fade-in slide-in-from-top-2 duration-200">
            <CheckCircle2 className="w-5 h-5 text-emerald-300 shrink-0" />
            <span>{itemAddedToast}</span>
          </div>
        </div>
      )}

      {/* Editing Banner */}
      {editingInvoice && (
        <div className="lg:col-span-12 bg-amber-50 dark:bg-amber-950/80 border-2 border-amber-500 p-3.5 rounded-2xl flex items-center justify-between text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2.5 text-xs sm:text-sm font-black">
            <RotateCcw className="w-5 h-5 animate-spin shrink-0" />
            <span>تعديل فاتورة رقم ({editingInvoice.invoiceNumber}) — العميل: {editingInvoice.customerName}</span>
          </div>
          {onCancelEdit && (
            <button
              onClick={onCancelEdit}
              className="bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 text-slate-800 dark:text-white text-xs font-bold px-3 py-1.5 rounded-xl cursor-pointer"
            >
              إلغاء التعديل
            </button>
          )}
        </div>
      )}

      {/* TOP RETAIL CASHIER BAR: Barcode Scanner, Parked Carts Button, and Scale Weighing Quick Action */}
      <div className="lg:col-span-12 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-3 sm:p-4 rounded-2xl shadow-sm flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Fast Barcode Input (Scanner Trigger) */}
        <form onSubmit={handleBarcodeSubmit} className="flex-1 w-full flex items-center gap-2">
          <div className="relative flex-1">
            <Barcode className="w-5 h-5 text-emerald-600 dark:text-emerald-400 absolute right-3.5 top-3 pointer-events-none" />
            <input
              ref={barcodeInputRef}
              type="text"
              value={barcodeInput}
              onChange={(e) => setBarcodeInput(e.target.value)}
              placeholder="امسح باركود الصنف أو باركود الميزان أو اكتب الكود ثم اضغط Enter..."
              className="w-full min-h-[46px] bg-slate-50 dark:bg-slate-950 border-2 border-emerald-500/80 text-slate-900 dark:text-white rounded-xl pr-11 pl-4 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-inner"
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="min-h-[46px] px-5 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-xl text-xs sm:text-sm cursor-pointer shadow-md flex items-center gap-1.5 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة</span>
          </button>
        </form>

        {/* Quick Toolbar: Parked Carts, Dairy Weighing Scale, Customer Mode */}
        <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end">
          {/* Parked / Suspended Invoices Button */}
          <button
            type="button"
            onClick={() => setIsParkedModalOpen(true)}
            className={`min-h-[46px] px-3.5 rounded-xl text-xs font-bold flex items-center justify-center flex-1 md:flex-initial gap-2 cursor-pointer transition-all border ${
              parkedCarts.length > 0 
                ? 'bg-amber-100 dark:bg-amber-950/70 border-amber-400 text-amber-900 dark:text-amber-200' 
                : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
            }`}
          >
            <PauseCircle className="w-4 h-4 text-amber-600" />
            <span>فواتير معلقة</span>
            {parkedCarts.length > 0 && (
              <span className="w-5 h-5 bg-amber-600 text-white rounded-full text-[11px] font-black flex items-center justify-center">
                {parkedCarts.length}
              </span>
            )}
          </button>

          {/* Quick Weighing Scale Modal Trigger */}
          <button
            type="button"
            onClick={() => {
              const firstWeighing = products.find(p => p.isWeighing) || null;
              if (firstWeighing) {
                setWeighingProduct(firstWeighing);
                setWeighingGrams(250);
              }
            }}
            className="min-h-[46px] px-3.5 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900 border border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-300 rounded-xl text-xs font-black flex items-center justify-center flex-1 md:flex-initial gap-1.5 cursor-pointer shadow-xs"
          >
            <Scale className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>ميزان الألبان والجبن</span>
          </button>
        </div>
      </div>

      {/* Negative stock or error alert */}
      {errorMessage && (
        <div className="lg:col-span-12 bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 p-3 rounded-xl text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {negativeStockWarning && (
        <div className="lg:col-span-12 bg-amber-50 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 p-2.5 rounded-xl text-xs font-medium flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
          <span>{negativeStockWarning}</span>
        </div>
      )}

      {/* MOBILE SCREEN SWITCHER (< 1024px, Sticky on phone/tablet) */}
      <div className="lg:hidden lg:col-span-12 sticky top-0 z-30 flex items-center p-1 bg-slate-200/95 dark:bg-slate-800/95 backdrop-blur-md rounded-xl shadow-xs">
        <button
          type="button"
          onClick={() => setMobileView('CATALOG')}
          className={`flex-1 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
            mobileView === 'CATALOG' ? 'bg-emerald-600 text-white font-black shadow-sm' : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          <Package className="w-4 h-4" />
          <span>أصناف الماركت</span>
          <span className="text-[10px] bg-white/20 px-1.5 py-0.2 rounded-full font-mono">{filteredCatalogProducts.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setMobileView('INVOICE')}
          className={`flex-1 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
            mobileView === 'INVOICE' ? 'bg-emerald-600 text-white font-black shadow-sm' : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          <Receipt className="w-4 h-4" />
          <span>الفاتورة والحساب</span>
          <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
            items.length > 0 ? 'bg-amber-400 text-amber-950' : 'bg-slate-300 dark:bg-slate-700 text-slate-800 dark:text-slate-200'
          }`}>
            {items.length} | {total.toFixed(2)} ج
          </span>
        </button>
      </div>

      {/* FLOATING QUICK CHECKOUT BAR FOR MOBILE & TABLET (Active when browsing Catalog) */}
      {items.length > 0 && mobileView === 'CATALOG' && (
        <div className="lg:hidden fixed bottom-16 sm:bottom-20 left-3 right-3 z-40 bg-emerald-700/95 dark:bg-emerald-800/95 text-white p-3 rounded-2xl shadow-2xl border border-emerald-400/50 flex items-center justify-between backdrop-blur-md animate-in slide-in-from-bottom-3 duration-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-white text-emerald-800 rounded-xl font-black text-xs flex items-center justify-center shadow-xs">
              {items.length}
            </div>
            <div>
              <span className="text-[11px] text-emerald-100 block font-medium">إجمالي السلة:</span>
              <span className="font-mono font-black text-sm sm:text-base">{total.toFixed(2)} ج.م</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMobileView('INVOICE')}
            className="px-4 py-2 bg-white text-emerald-800 hover:bg-emerald-50 active:scale-95 font-black text-xs sm:text-sm rounded-xl flex items-center gap-1.5 shadow-md cursor-pointer transition-all"
          >
            <span>إتمام الدفع والفاتورة</span>
            <Receipt className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 1. RIGHT SIDE IN RTL: SEARCH & 5x5 PRODUCT SQUARES GRID (7 cols desktop) */}
      <div className={`lg:col-span-7 xl:col-span-7 space-y-3 ${mobileView === 'CATALOG' ? 'block' : 'hidden lg:block'}`}>
        <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-2.5 sm:p-4 shadow-sm flex flex-col min-h-[500px] h-[calc(100vh-230px)] lg:h-[760px]">
          {/* Catalog Top Filter */}
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-3 pointer-events-none" />
              <input
                type="text"
                value={catalogSearchQuery}
                onChange={(e) => setCatalogSearchQuery(e.target.value)}
                placeholder="ابحث باسم الصنف، الباركود، أو الماركة..."
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 text-xs sm:text-sm rounded-xl pr-10 pl-9 py-2.5 font-bold focus:outline-none focus:border-emerald-500 shadow-inner"
              />
              {catalogSearchQuery && (
                <button
                  type="button"
                  onClick={() => setCatalogSearchQuery('')}
                  className="absolute left-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer p-0.5"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Department Categories Pills with Dairy prominently styled */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
              {SUPERMARKET_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCatalogCategory(cat.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-black shrink-0 flex items-center gap-1.5 cursor-pointer transition-all border ${
                    catalogCategory === cat.id
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm scale-102'
                      : cat.id === 'منتجات الألبان والأجبان'
                      ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700 hover:bg-blue-100'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <cat.icon className="w-3.5 h-3.5" />
                  <span>{cat.label}</span>
                </button>
              ))}
            </div>

            {/* Interactive Grid & Square Size Controls (التحكم في سعة العرض وحجم مربع الصنف) */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 p-2 bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-xl">
              {/* Columns control (أصناف أكثر أو أقل) */}
              <div className="flex items-center justify-between sm:justify-start gap-1.5">
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1 shrink-0">
                  <LayoutGrid className="w-3.5 h-3.5 text-emerald-600" />
                  <span>الأعمدة:</span>
                </span>
                <div className="flex items-center bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-0.5 shadow-2xs">
                  {[3, 4, 5, 6, 7].map(cols => (
                    <button
                      key={cols}
                      type="button"
                      onClick={() => handleSetGridColumns(cols)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-black cursor-pointer transition-all ${
                        gridColumns === cols
                          ? 'bg-emerald-600 text-white shadow-xs scale-105'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                      title={`عرض ${cols} أعمدة في السطر`}
                    >
                      {cols}
                    </button>
                  ))}
                </div>
              </div>

              {/* Individual Square Size control (التحكم في حجم مربع الصنف) */}
              <div className="flex items-center justify-between sm:justify-start gap-1.5">
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1 shrink-0">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-blue-600" />
                  <span>حجم المربع:</span>
                </span>
                <div className="flex items-center bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-0.5 shadow-2xs">
                  {(['COMPACT', 'MEDIUM', 'LARGE'] as const).map(size => {
                    const label = size === 'COMPACT' ? 'صغير' : size === 'MEDIUM' ? 'متوسط' : 'كبير';
                    return (
                      <button
                        key={size}
                        type="button"
                        onClick={() => handleSetCardSize(size)}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-bold cursor-pointer transition-all ${
                          cardSize === size
                            ? 'bg-blue-600 text-white shadow-xs scale-105'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                        }`}
                        title={
                          size === 'COMPACT' 
                            ? 'مربع صنف صغير لعرض أصناف أكثر' 
                            : size === 'MEDIUM' 
                            ? 'مربع صنف متوسط قياسي' 
                            : 'مربع صنف كبير ومريح للمس'
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Sort & Quick info banner */}
            <div className="flex items-center justify-between text-[11px] px-1 text-slate-500 border-b border-slate-100 dark:border-slate-800 pb-1.5">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-bold truncate">
                <Flame className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>
                  أصناف مرتبة تلقائياً حسب الأكثر استخداماً • شبكة {gridColumns} أعمدة • مربع {cardSize === 'COMPACT' ? 'صغير' : cardSize === 'LARGE' ? 'كبير' : 'متوسط'}
                </span>
              </div>
              <span className="font-mono font-bold bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md text-slate-700 dark:text-slate-300 shrink-0">
                {filteredCatalogProducts.length} صنف
              </span>
            </div>
          </div>

          {/* Configurable Product Squares Grid */}
          <div className="mt-2.5 flex-1 overflow-y-auto pr-1 pl-0.5 custom-scrollbar">
            {filteredCatalogProducts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-400 text-xs font-medium">
                <Store className="w-10 h-10 mb-2 text-slate-300 dark:text-slate-700" />
                <p className="font-bold text-slate-600 dark:text-slate-400">لا توجد أصناف مطابقة للبحث أو التصنيف</p>
                <p className="text-[11px] mt-1">جرّب تغيير كلمة البحث أو اختيار تصنيف آخر</p>
              </div>
            ) : (
              <div className={`grid gap-2 sm:gap-2.5 ${
                gridColumns === 3
                  ? 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-3'
                  : gridColumns === 4
                  ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4'
                  : gridColumns === 6
                  ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-6'
                  : gridColumns === 7
                  ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-7'
                  : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5'
              }`}>
                {filteredCatalogProducts.map((prod, index) => {
                  const isDairy = prod.category === 'منتجات الألبان والأجبان';
                  const isWeighed = prod.isWeighing;
                  const unitPrice = getDefaultPrice(prod, isWeighed ? 'KG' : 'PIECE', selectedCustomer);
                  const isPopular = index < 10 || (productUsageScores[prod.id] || 0) >= 30;

                  return (
                    <div
                      key={prod.id}
                      onClick={() => {
                        if (isWeighed) {
                          setWeighingProduct(prod);
                          setWeighingGrams(250);
                        } else {
                          addItemToInvoice(prod, 'PIECE', 1);
                        }
                      }}
                      className={`group relative rounded-2xl border-2 transition-all cursor-pointer flex flex-col justify-between select-none aspect-square text-right shadow-2xs hover:shadow-md active:scale-95 ${
                        cardSize === 'COMPACT'
                          ? 'p-2 min-h-[95px] sm:min-h-[105px]'
                          : cardSize === 'LARGE'
                          ? 'p-3.5 min-h-[145px] sm:min-h-[160px]'
                          : 'p-2.5 min-h-[115px] sm:min-h-[120px]'
                      } ${
                        isDairy 
                          ? 'bg-blue-50/70 hover:bg-blue-100/90 dark:bg-blue-950/40 dark:hover:bg-blue-900/60 border-blue-200 dark:border-blue-800/80 hover:border-blue-500' 
                          : 'bg-white hover:bg-emerald-50/80 dark:bg-slate-900/90 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-800 hover:border-emerald-500'
                      }`}
                    >
                      {/* Top Badges inside square */}
                      <div className="flex items-center justify-between gap-1 w-full">
                        <div className="flex items-center gap-1 flex-wrap">
                          {isPopular ? (
                            <span className={`${cardSize === 'COMPACT' ? 'text-[8px] px-1 py-0.2' : 'text-[9px] px-1.5 py-0.5'} bg-amber-500 text-white font-black rounded-md flex items-center gap-0.5 shadow-2xs`}>
                              <Star className="w-2.5 h-2.5 fill-white" />
                              <span>شائع</span>
                            </span>
                          ) : isDairy ? (
                            <span className={`${cardSize === 'COMPACT' ? 'text-[8px] px-1 py-0.2' : 'text-[9px] px-1.5 py-0.5'} bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 font-bold rounded-md`}>
                              ❄️ ألبان
                            </span>
                          ) : null}

                          {isWeighed && (
                            <span className={`${cardSize === 'COMPACT' ? 'text-[8px] px-1 py-0.2' : 'text-[9px] px-1.5 py-0.5'} bg-indigo-600 text-white rounded-md font-bold flex items-center gap-0.5`}>
                              <Scale className="w-2.5 h-2.5" />
                              <span>ميزان</span>
                            </span>
                          )}
                        </div>

                        <span className={`${cardSize === 'COMPACT' ? 'text-[8px]' : 'text-[9px]'} text-slate-400 dark:text-slate-500 font-mono font-bold truncate max-w-[65px]`}>
                          {prod.stockPieces} {isWeighed ? 'كجم' : prod.baseUnit}
                        </span>
                      </div>

                      {/* Middle: Bold, Clear Item Name */}
                      <div className="my-auto py-0.5 text-center">
                        <h4 className={`font-black text-slate-900 dark:text-white line-clamp-2 leading-tight group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors ${
                          cardSize === 'COMPACT'
                            ? 'text-[11px] sm:text-xs'
                            : cardSize === 'LARGE'
                            ? 'text-sm sm:text-base font-black'
                            : 'text-xs sm:text-[13px]'
                        }`}>
                          {prod.name}
                        </h4>
                        <span className={`text-slate-500 dark:text-slate-400 font-bold block truncate mt-0.5 ${
                          cardSize === 'COMPACT' ? 'text-[9px]' : 'text-[10px]'
                        }`}>
                          {prod.brand || 'عام'}
                        </span>
                      </div>

                      {/* Bottom: Clear Large Price & Quick action hint */}
                      <div className="pt-1 border-t border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between w-full">
                        <div className={`font-mono font-black text-emerald-700 dark:text-emerald-400 ${
                          cardSize === 'COMPACT'
                            ? 'text-xs'
                            : cardSize === 'LARGE'
                            ? 'text-sm sm:text-base'
                            : 'text-xs sm:text-sm'
                        }`}>
                          {unitPrice.toFixed(2)} <span className="text-[9px] font-sans font-normal">{isWeighed ? 'ج/كجم' : 'ج'}</span>
                        </div>

                        <span className={`font-bold rounded-lg bg-emerald-100 group-hover:bg-emerald-600 group-hover:text-white dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 transition-colors ${
                          cardSize === 'COMPACT' ? 'text-[9px] px-1 py-0.5' : cardSize === 'LARGE' ? 'text-xs px-2 py-1' : 'text-[10px] px-1.5 py-0.5'
                        }`}>
                          {isWeighed ? 'وزن' : '+ إضافة'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2. LEFT SIDE IN RTL: INVOICE BASKET, DISCOUNT, TENDER, & TOTALS (5 cols desktop) */}
      <div className={`lg:col-span-5 xl:col-span-5 space-y-3.5 ${mobileView === 'INVOICE' ? 'block' : 'hidden lg:block'}`}>
        {/* Customer Select / Walk-in Header */}
        <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-3 sm:p-3.5 shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <span>نوع الحساب / العميل:</span>
              <span className="text-[11px] bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 px-2.5 py-0.5 rounded-full font-black border border-emerald-300 dark:border-emerald-700">
                {selectedCustomer?.name || DEFAULT_WALKIN_CUSTOMER.name}
              </span>
            </label>

            {/* Quick Customer Switch to Cash Walk-in */}
            <button
              type="button"
              onClick={() => {
                const cashCust = customers.find(c => c.priceTier === 'RETAIL' || c.name.includes('نقدي')) || customers[0] || DEFAULT_WALKIN_CUSTOMER;
                if (cashCust) {
                  setSelectedCustomerId(cashCust.id);
                  setCustomerSearchQuery('');
                  setIsCustomerDropdownOpen(false);
                }
              }}
              className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700 rounded-xl text-[11px] font-black cursor-pointer shrink-0"
            >
              زبون كاش مباشر
            </button>
          </div>

          {/* Customer Selector Dropdown */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                value={customerSearchQuery}
                onChange={(e) => {
                  setCustomerSearchQuery(e.target.value);
                  setIsCustomerDropdownOpen(true);
                }}
                onFocus={() => setIsCustomerDropdownOpen(true)}
                placeholder="ابحث عن عميل دليفري أو حساب نوتة..."
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 text-xs rounded-xl pr-9 pl-3 py-2 font-bold focus:outline-none focus:border-emerald-500"
              />
              {isCustomerDropdownOpen && (
                <div className="absolute top-full right-0 left-0 mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl shadow-xl max-h-48 overflow-y-auto z-40 divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredCustomers.map(c => (
                    <div
                      key={c.id}
                      onClick={() => {
                        setSelectedCustomerId(c.id);
                        setCustomerSearchQuery(c.name);
                        setIsCustomerDropdownOpen(false);
                      }}
                      className={`p-2 text-xs text-right cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-950/40 flex justify-between items-center ${
                        selectedCustomerId === c.id ? 'bg-emerald-50/80 dark:bg-emerald-950/60 font-black' : ''
                      }`}
                    >
                      <div>
                        <span className="font-bold text-slate-900 dark:text-white">{c.name}</span>
                        <span className="text-[10px] text-slate-500 block">{c.phone} • {c.area}</span>
                      </div>
                      {c.currentBalance > 0 && (
                        <span className="text-[10px] text-rose-600 font-mono font-bold">مديونية: {c.currentBalance} ج</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onOpenCustomerModal}
              className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 px-3 rounded-xl text-xs font-bold flex items-center gap-1 cursor-pointer shrink-0 border border-slate-300 dark:border-slate-700"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>+ دليفري</span>
            </button>
          </div>
        </div>

        {/* Items Basket Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs sm:text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-4 h-4 text-emerald-600" />
              <span>أصناف الفاتورة ({items.length})</span>
            </span>

            {items.length > 0 && (
              <button
                type="button"
                onClick={() => setItems([])}
                className="text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400 font-bold flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>مسح الكل</span>
              </button>
            )}
          </div>

          <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
            {items.length === 0 ? (
              <div className="p-8 text-center text-slate-400 dark:text-slate-500 text-xs">
                <Store className="w-8 h-8 mx-auto mb-2 text-slate-300 dark:text-slate-700 animate-pulse" />
                <p className="font-bold text-slate-600 dark:text-slate-400">السلة فارغة</p>
                <p className="text-[11px] mt-1">اضغط على أي صنف من مربعات الأصناف على اليمين للإضافة فوراً</p>
              </div>
            ) : (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
                  <tr>
                    <th className="p-2">الصنف</th>
                    <th className="p-2 text-center">الكمية</th>
                    <th className="p-2 text-center">السعر</th>
                    <th className="p-2 text-left">الإجمالي</th>
                    <th className="p-2 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((it, idx) => (
                    <tr key={it.id || idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="p-2">
                        <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                          <span className="truncate max-w-[130px]">{it.productName}</span>
                          {it.isWeighed && (
                            <span className="text-[9px] bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 px-1 rounded font-mono font-bold">
                              ميزان
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono block">{it.unitLabel}</span>
                      </td>

                      {/* Quantity & Weight Controls */}
                      <td className="p-2 text-center">
                        <div className="inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-300 dark:border-slate-700">
                          <button
                            type="button"
                            onClick={() => updateItemQuantity(idx, it.quantity - (it.isWeighed ? 0.05 : 1))}
                            className="w-7 h-7 sm:w-6 sm:h-6 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 rounded-lg cursor-pointer transition-colors"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <input
                            type="number"
                            step={it.isWeighed ? '0.025' : '1'}
                            value={it.quantity}
                            onChange={(e) => updateItemQuantity(idx, parseFloat(e.target.value) || 0)}
                            className="w-12 sm:w-10 text-center bg-transparent font-black font-mono text-xs focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => updateItemQuantity(idx, it.quantity + (it.isWeighed ? 0.05 : 1))}
                            className="w-7 h-7 sm:w-6 sm:h-6 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 rounded-lg cursor-pointer transition-colors"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </td>

                      {/* Unit Price */}
                      <td className="p-2 text-center font-mono font-bold text-xs">
                        {it.unitPrice.toFixed(2)}
                      </td>

                      {/* Line Total */}
                      <td className="p-2 text-left font-mono font-black text-slate-900 dark:text-white text-xs sm:text-sm">
                        {it.totalPrice.toFixed(2)} ج
                      </td>

                      {/* Delete */}
                      <td className="p-2 text-center">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="text-slate-400 hover:text-rose-600 active:text-rose-700 p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/60 cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* TENDER & PAYMENT PANEL */}
        <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-3.5 shadow-sm space-y-3">
          {/* Discount Bar */}
          <div className="flex items-center justify-between text-xs gap-2">
            <span className="font-bold text-slate-700 dark:text-slate-300">الخصم الإضافي:</span>
            <div className="flex items-center gap-1.5">
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as 'AMOUNT' | 'PERCENT')}
                className="bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-xs font-bold"
              >
                <option value="AMOUNT">جنيه (مبلغ)</option>
                <option value="PERCENT">نسبة %</option>
              </select>
              <input
                type="number"
                min="0"
                value={discountValue || ''}
                onChange={(e) => setDiscountValue(parseFloat(e.target.value) || 0)}
                placeholder="0"
                className="w-16 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-center font-mono font-bold"
              />
              {discountAmount > 0 && (
                <span className="text-emerald-600 font-bold text-xs">-{discountAmount} ج</span>
              )}
            </div>
          </div>

          {/* Payment Method Selector (2 cols on mobile, 4 cols on tablet/desktop) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setPaymentType('CASH')}
              className={`py-2 px-1.5 rounded-xl text-xs font-black flex flex-col items-center gap-1 cursor-pointer transition-all border ${
                paymentType === 'CASH'
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
              }`}
            >
              <Banknote className="w-4 h-4" />
              <span>نقدي (كاش)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setPaymentType('CARD');
                setPaymentMethodDetails('فيزا / ماستركارد');
              }}
              className={`py-2 px-1.5 rounded-xl text-xs font-black flex flex-col items-center gap-1 cursor-pointer transition-all border ${
                paymentType === 'CARD'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
              }`}
            >
              <CreditCard className="w-4 h-4" />
              <span>بطاقة / فيزا</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setPaymentType('WALLET');
                setPaymentMethodDetails('إنستاباي / فودافون كاش');
              }}
              className={`py-2 px-1.5 rounded-xl text-xs font-black flex flex-col items-center gap-1 cursor-pointer transition-all border ${
                paymentType === 'WALLET'
                  ? 'bg-purple-600 text-white border-purple-600 shadow-sm'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
              }`}
            >
              <Smartphone className="w-4 h-4" />
              <span>محفظة ذكية</span>
            </button>

            <button
              type="button"
              onClick={() => setPaymentType('CREDIT')}
              disabled={isDirectStoreCustomer}
              className={`py-2 px-1.5 rounded-xl text-xs font-black flex flex-col items-center gap-1 cursor-pointer transition-all border ${
                paymentType === 'CREDIT'
                  ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
              } ${isDirectStoreCustomer ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <Clock className="w-4 h-4" />
              <span>نوتة / آجل</span>
            </button>
          </div>

          {/* Quick Cash Buttons & Change Due Calculator */}
          {paymentType === 'CASH' && (
            <div className="bg-slate-50 dark:bg-slate-950 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700 dark:text-slate-300">نقدية الزبون المستلمة:</span>
                <input
                  type="number"
                  value={tenderCashGiven}
                  onChange={(e) => setTenderCashGiven(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)}
                  placeholder="المبلغ المستلم بالجنيه..."
                  className="w-28 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-center font-mono font-black text-sm"
                />
              </div>

              {/* Fast Denomination Buttons (Responsive Keypad Grid on Phone/Tablet) */}
              <div className="flex gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setTenderCashGiven(total)}
                  className="flex-1 min-w-[120px] px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-[11px] font-bold cursor-pointer hover:bg-slate-100 text-center"
                >
                  المطلوب بالضبط ({total.toFixed(2)} ج)
                </button>
                {[50, 100, 200, 500].map(amt => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setTenderCashGiven(amt)}
                    className="flex-1 min-w-[55px] px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-[11px] font-bold cursor-pointer hover:bg-slate-100 text-center font-mono"
                  >
                    {amt} ج
                  </button>
                ))}
              </div>

              {/* Live Change Due (الباقي للعميل) */}
              {changeDue > 0 && (
                <div className="flex items-center justify-between p-2 bg-emerald-100 dark:bg-emerald-950/80 border border-emerald-400 rounded-xl text-emerald-900 dark:text-emerald-200">
                  <span className="font-black text-xs">الباقي للعميل:</span>
                  <span className="font-mono font-black text-base">{changeDue.toFixed(2)} ج.م</span>
                </div>
              )}
            </div>
          )}

          {/* Grand Total Highlight */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center">
            <div>
              <span className="text-xs text-slate-500 block">إجمالي الفاتورة:</span>
              <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400 font-mono">
                {total.toFixed(2)} <span className="text-xs font-sans">ج.م</span>
              </span>
            </div>

            {/* Profit peek for admin */}
            {isAdmin && (
              <div className="text-left font-mono">
                <span className="text-[10px] text-slate-500 block font-sans">ربح الفاتورة:</span>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  {showProfitNumber ? `${totalProfit.toFixed(2)} ج` : '•••••'}
                </span>
                <button
                  type="button"
                  onClick={() => setShowProfitNumber(!showProfitNumber)}
                  className="p-0.5 text-slate-400 hover:text-slate-600 cursor-pointer ml-1"
                >
                  {showProfitNumber ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                </button>
              </div>
            )}
          </div>

          {/* Primary Action Buttons: Print F10, Save F9, Park F8 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => handleSaveInvoice(true)}
              className="min-h-[46px] bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-xl text-xs sm:text-sm flex items-center justify-center gap-1.5 cursor-pointer shadow-lg shadow-emerald-900/30 active:scale-95 transition-all"
            >
              <Printer className="w-4 h-4" />
              <span>حفظ وطباعة (F10)</span>
            </button>

            <button
              type="button"
              onClick={() => handleSaveInvoice(false)}
              className="min-h-[46px] bg-slate-800 hover:bg-slate-700 text-white font-black rounded-xl text-xs sm:text-sm flex items-center justify-center gap-1.5 cursor-pointer shadow-md active:scale-95 transition-all"
            >
              <Save className="w-4 h-4" />
              <span>حفظ فقط (F9)</span>
            </button>

            <button
              type="button"
              onClick={handleParkCurrentCart}
              className="min-h-[46px] bg-amber-500 hover:bg-amber-400 text-white font-black rounded-xl text-xs sm:text-sm flex items-center justify-center gap-1.5 cursor-pointer shadow-md active:scale-95 transition-all"
            >
              <PauseCircle className="w-4 h-4" />
              <span>تعليق (F8)</span>
            </button>
          </div>
        </div>
      </div>

      {/* WEIGHING SCALE MODAL (ميزان الألبان والأجبان السريع) */}
      {weighingProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto" dir="rtl">
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-2xl max-w-md w-full shadow-2xl p-5 text-right space-y-4">
            <div className="flex justify-between items-start border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <span className="text-xs bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                  <Scale className="w-3 h-3" />
                  ميزان قسم الألبان والأجبان
                </span>
                <h3 className="text-base font-black text-slate-900 dark:text-white mt-1">
                  {weighingProduct.name}
                </h3>
                <p className="text-xs text-slate-500">
                  سعر الكيلو: <span className="font-mono font-bold text-slate-900 dark:text-white">{weighingProduct.retailPricePerBase} ج.م</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWeighingProduct(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Weight Presets Buttons (Responsive grid for mobile & tablet) */}
            <div>
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                أوزان سريعة شائعة:
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { label: 'ثمن كجم (125 جم)', grams: 125 },
                  { label: 'ربع كجم (250 جم)', grams: 250 },
                  { label: 'نصف كجم (500 جم)', grams: 500 },
                  { label: 'إلا ربع (750 جم)', grams: 750 },
                  { label: 'واحد كجم (1000 جم)', grams: 1000 },
                  { label: 'كيلو ونصف (1500 جم)', grams: 1500 },
                ].map(p => (
                  <button
                    key={p.grams}
                    type="button"
                    onClick={() => setWeighingGrams(p.grams)}
                    className={`py-2.5 px-2 rounded-xl text-xs font-black cursor-pointer border transition-all ${
                      weighingGrams === p.grams
                        ? 'bg-blue-600 text-white border-blue-600 shadow-md scale-102'
                        : 'bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Weight in Grams Input */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  أو اكتب الوزن بالجرام مباشرة:
                </label>
                {weighingProduct.tareGrams && (
                  <label className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeTare}
                      onChange={(e) => setIncludeTare(e.target.checked)}
                      className="rounded"
                    />
                    <span>خصم الفارغ ({weighingProduct.tareGrams} جم)</span>
                  </label>
                )}
              </div>
              <div className="relative">
                <input
                  type="number"
                  min="10"
                  step="5"
                  value={weighingGrams}
                  onChange={(e) => setWeighingGrams(parseInt(e.target.value, 10) || 0)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border-2 border-blue-500 rounded-xl px-4 py-2.5 text-center font-mono font-black text-lg focus:outline-none"
                  autoFocus
                />
                <span className="absolute left-3 top-3 text-xs text-slate-400 font-bold">جرام</span>
              </div>
            </div>

            {/* Price Preview */}
            <div className="bg-blue-50 dark:bg-blue-950/60 border border-blue-300 dark:border-blue-800 p-3.5 rounded-xl flex items-center justify-between">
              <div>
                <span className="text-[11px] text-blue-700 dark:text-blue-300 block">إجمالي سعر هذا الوزن:</span>
                <span className="text-xl font-black text-blue-900 dark:text-blue-100 font-mono">
                  {Math.round(((weighingGrams / 1000) * weighingProduct.retailPricePerBase) * 100) / 100} ج.م
                </span>
              </div>
              <span className="text-xs text-slate-600 dark:text-slate-400 font-mono font-bold">
                = {(weighingGrams / 1000).toFixed(3)} كجم
              </span>
            </div>

            {/* Modal Actions */}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmWeighing}
                className="py-3 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-xl text-sm cursor-pointer shadow-md flex items-center justify-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>إدراج في الفاتورة</span>
              </button>
              <button
                type="button"
                onClick={() => setWeighingProduct(null)}
                className="py-3 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-white font-bold rounded-xl text-sm cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PARKED CARTS MODAL (الفواتير المعلقة) */}
      {isParkedModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50" dir="rtl">
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-2xl max-w-lg w-full shadow-2xl p-5 text-right space-y-4">
            <div className="flex justify-between items-center border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <PauseCircle className="w-5 h-5 text-amber-600" />
                <h3 className="text-base font-black text-slate-900 dark:text-white">الفواتير المعلقة بالكاشير</h3>
              </div>
              <button onClick={() => setIsParkedModalOpen(false)} className="text-slate-400 p-1 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2.5 max-h-72 overflow-y-auto">
              {parkedCarts.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  لا توجد فواتير معلقة حالياً
                </div>
              ) : (
                parkedCarts.map(cart => {
                  const cartTotal = cart.items.reduce((s, it) => s + it.totalPrice, 0);
                  return (
                    <div
                      key={cart.id}
                      className="p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3"
                    >
                      <div>
                        <h4 className="font-bold text-slate-900 dark:text-white text-xs">{cart.customerName}</h4>
                        <span className="text-[10px] text-slate-500 block">
                          معلقة الساعة {cart.parkedAt} • {cart.items.length} أصناف
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-sm text-slate-900 dark:text-white">
                          {cartTotal.toFixed(2)} ج
                        </span>
                        <button
                          type="button"
                          onClick={() => handleResumeParkedCart(cart)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-black cursor-pointer flex items-center gap-1 shadow-xs"
                        >
                          <PlayCircle className="w-3.5 h-3.5" />
                          <span>استئناف</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            storage.removeParkedCart(cart.id);
                            setParkedCarts(storage.getParkedCarts());
                          }}
                          className="p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
