import React, { useState } from 'react';
import { SalesReturn } from '../../types';
import { storage } from '../../services/storageService';
import { Printer, X, RotateCcw } from 'lucide-react';

interface PrintableReturnProps {
  salesReturn: SalesReturn;
  onClose: () => void;
}

export const PrintableReturn: React.FC<PrintableReturnProps> = ({
  salesReturn,
  onClose,
}) => {
  const [format, setFormat] = useState<'THERMAL' | 'A4'>('THERMAL');

  const storeProfile = storage.getStoreProfile();
  const storeName = storeProfile.name || 'اسم المحل';
  const storeBranch = storeProfile.branchName;
  const storePhone = storeProfile.phone;
  const storeAddress = storeProfile.address;
  const storeHeader = storeProfile.receiptHeader;
  const storeFooter = storeProfile.receiptFooter || `شكراً لزيارتكم ${storeName}`;
  const storeTax = storeProfile.taxNumber;
  const storeLogo = storeProfile.logo;
  const currencySymbol = storeProfile.currency === 'EGP' ? 'ج.م' : (storeProfile.currency || 'ج.م');

  const customers = storage.getCustomers();
  const customer = customers.find(c => c.id === salesReturn.customerId);
  const customerPhone = customer?.phone || '-';

  const handlePrint = () => {
    window.print();
  };

  const refundMethodLabel =
    salesReturn.refundMethod === 'CASH'
      ? 'رد نقدي من الدرج (كاش)'
      : 'إضافة كرصيد في حساب العميل';

  const stockLabel = salesReturn.returnToStock
    ? 'تمت إعادة الأصناف للمخزون'
    : 'تالف / هالك (لم يُعد للمخزون)';

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" dir="rtl">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full shadow-2xl overflow-hidden text-right flex flex-col my-6 max-h-[95vh]">
        {/* Modal Top Bar (Screen only - hidden in print) */}
        <div className="p-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between print:hidden">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-bold text-white">معاينة وطباعة إيصال المرتجع</span>
            <div className="bg-slate-900 rounded-lg p-0.5 border border-slate-700 flex text-xs">
              <button
                type="button"
                onClick={() => setFormat('THERMAL')}
                className={`px-3 py-1 rounded-md text-[11px] font-bold cursor-pointer transition-all ${
                  format === 'THERMAL' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                بون كاشير 80 مم
              </button>
              <button
                type="button"
                onClick={() => setFormat('A4')}
                className={`px-3 py-1 rounded-md text-[11px] font-bold cursor-pointer transition-all ${
                  format === 'A4' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                إيصال A4
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-1.5 rounded-lg flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-950/60"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>طباعة فورية</span>
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white p-1 cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Printable Paper Area (ZERO profit printed anywhere!) */}
        <div className="p-4 overflow-y-auto bg-slate-950 flex justify-center">
          {format === 'THERMAL' ? (
            <div className="bg-white text-black p-4 w-[330px] font-mono text-xs shadow-xl rounded border border-slate-300 leading-relaxed select-text print:shadow-none print:border-none print:w-full">
              <div className="text-center pb-2 border-b-2 border-dashed border-black">
                {storeLogo && (
                  <img
                    src={storeLogo}
                    alt="Store Logo"
                    className="h-10 mx-auto object-contain mb-1 filter grayscale"
                  />
                )}
                <h2 className="font-black text-sm text-slate-900">{storeName}</h2>
                {storeBranch && <p className="text-[10px] font-bold text-slate-800">{storeBranch}</p>}
                {storeHeader && <p className="text-[10px] font-bold text-slate-800">{storeHeader}</p>}
                {storePhone && (
                  <p className="text-[10px]">
                    هاتف المحل: <span dir="ltr">{storePhone}</span>
                  </p>
                )}
                {storeAddress && <p className="text-[9px] text-gray-700">{storeAddress}</p>}
                {storeTax && <p className="text-[8px] text-gray-600">الرقم الضريبي: {storeTax}</p>}
                <div className="mt-1.5 inline-block border border-black px-2 py-0.5 font-black text-[11px] bg-gray-100">
                  إيصال مرتجع مبيعات
                </div>
              </div>

              <div className="py-2 border-b border-dashed border-black text-[10px] space-y-1">
                <div className="flex justify-between font-bold">
                  <span>رقم إيصال المرتجع:</span>
                  <span className="font-mono text-xs">{salesReturn.returnNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span>رقم الفاتورة الأصلية:</span>
                  <span className="font-mono font-bold">{salesReturn.originalInvoiceNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span>التاريخ والوقت:</span>
                  <span>{salesReturn.date} — {salesReturn.time}</span>
                </div>
                <div className="flex justify-between font-bold border-t border-dotted border-gray-400 pt-1">
                  <span>العميل / الحساب:</span>
                  <span className="font-sans font-black">{salesReturn.customerName}</span>
                </div>
                {customerPhone && customerPhone !== '-' && (
                  <div className="flex justify-between">
                    <span>تليفون العميل:</span>
                    <span className="font-mono font-bold">{customerPhone}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>سبب المرتجع:</span>
                  <span className="font-sans font-bold">
                    {salesReturn.reasonLabelArabic}
                    {salesReturn.reasonNote ? ` (${salesReturn.reasonNote})` : ''}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>طريقة الرد:</span>
                  <span className="font-sans font-bold">{refundMethodLabel}</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span>حالة المخزن:</span>
                  <span className="font-sans">{stockLabel}</span>
                </div>
                <div className="flex justify-between text-[9px]">
                  <span>الكاشير المنفذ:</span>
                  <span className="font-sans">{salesReturn.performedBy}</span>
                </div>
              </div>

              {/* Returned Items Table */}
              <div className="py-2 border-b border-dashed border-black">
                <table className="w-full text-right text-[10px]">
                  <thead>
                    <tr className="border-b border-black font-bold">
                      <th className="py-1">الصنف</th>
                      <th className="py-1 text-center">الوحدة</th>
                      <th className="py-1 text-center">الكمية</th>
                      <th className="py-1 text-center">السعر</th>
                      <th className="py-1 text-left">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesReturn.items.map((it, idx) => (
                      <tr key={idx} className="border-b border-dotted border-gray-300">
                        <td className="py-1 font-sans font-bold">{it.productName}</td>
                        <td className="py-1 text-center font-sans text-[9px]">
                          {it.unit === 'KG' ? 'كجم' : it.unit === 'CARTON' ? 'كرتونة' : 'قطعة'}
                        </td>
                        <td className="py-1 text-center font-bold font-mono">
                          {it.unit === 'KG' ? Number(it.quantity).toFixed(3) : it.quantity}
                        </td>
                        <td className="py-1 text-center font-mono">{Number(it.unitSellingPrice).toFixed(2)}</td>
                        <td className="py-1 text-left font-bold font-mono">{Number(it.subtotal).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="py-2 space-y-1 text-[11px]">
                {salesReturn.discountAdjustedAmount > 0 && (
                  <>
                    <div className="flex justify-between">
                      <span>مجموع الأصناف المرتجعة:</span>
                      <span>{salesReturn.subtotal.toFixed(2)} {currencySymbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>تسوية خصم الفاتورة النسبي:</span>
                      <span>- {salesReturn.discountAdjustedAmount.toFixed(2)} {currencySymbol}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between text-sm border-t border-b-2 border-black py-1 font-black bg-gray-50 px-1">
                  <span>إجمالي قيمة المرتجع:</span>
                  <span>{salesReturn.totalAmount.toFixed(2)} {currencySymbol}</span>
                </div>
              </div>

              <div className="text-center pt-2 border-t-2 border-dashed border-black text-[9px] leading-tight space-y-0.5">
                <p className="font-bold">{storeFooter}</p>
              </div>
            </div>
          ) : (
            /* A4 Format */
            <div className="bg-white text-black p-6 w-[520px] text-xs shadow-xl rounded border border-slate-300 leading-normal select-text print:shadow-none print:border-none print:w-full">
              <div className="flex justify-between items-start pb-3 border-b-2 border-slate-900">
                <div className="flex items-start gap-3">
                  {storeLogo && (
                    <img
                      src={storeLogo}
                      alt="Store Logo"
                      className="h-14 max-w-[120px] object-contain filter grayscale"
                    />
                  )}
                  <div>
                    <h2 className="font-black text-base text-slate-900">{storeName}</h2>
                    {storeBranch && <p className="text-xs font-bold text-slate-800">{storeBranch}</p>}
                    {storeHeader && <p className="text-[11px] text-slate-700">{storeHeader}</p>}
                    {storePhone && (
                      <p className="text-[10px] font-bold text-slate-800">
                        هاتف المحل: <span dir="ltr">{storePhone}</span>
                      </p>
                    )}
                    {storeAddress && <p className="text-[10px] text-slate-500">{storeAddress}</p>}
                    {storeTax && <p className="text-[9px] text-slate-600">الرقم الضريبي: {storeTax}</p>}
                  </div>
                </div>
                <div className="text-left font-mono">
                  <span className="bg-amber-100 border border-slate-400 px-2.5 py-1 text-xs font-black block mb-1">
                    إشعار مرتجع مبيعات
                  </span>
                  <span className="text-[11px] font-bold block">رقم: {salesReturn.returnNumber}</span>
                  <span className="text-[10px] text-slate-600 block">الفاتورة الأصلية: {salesReturn.originalInvoiceNumber}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 my-3 bg-slate-100 p-2.5 rounded border border-slate-300 text-[11px]">
                <div>
                  <span className="text-slate-600 block">العميل / الحساب:</span>
                  <span className="font-bold text-slate-900 text-sm">{salesReturn.customerName}</span>
                </div>
                <div>
                  <span className="text-slate-600 block">التاريخ والوقت:</span>
                  <span className="font-mono">{salesReturn.date} — {salesReturn.time}</span>
                </div>
                <div>
                  <span className="text-slate-600 block">سبب المرتجع:</span>
                  <span className="font-bold">
                    {salesReturn.reasonLabelArabic}
                    {salesReturn.reasonNote ? ` (${salesReturn.reasonNote})` : ''}
                  </span>
                </div>
                <div>
                  <span className="text-slate-600 block">طريقة الرد:</span>
                  <span className="font-bold">{refundMethodLabel}</span>
                </div>
                <div>
                  <span className="text-slate-600 block">حالة المخزون:</span>
                  <span className="font-bold">{stockLabel}</span>
                </div>
                <div>
                  <span className="text-slate-600 block">المستخدم المنفذ:</span>
                  <span>{salesReturn.performedBy}</span>
                </div>
              </div>

              <table className="w-full text-right text-[11px] my-3 border border-slate-400">
                <thead className="bg-slate-200 border-b border-slate-400 font-bold">
                  <tr>
                    <th className="p-1.5">م</th>
                    <th className="p-1.5">الصنف</th>
                    <th className="p-1.5 text-center">الوحدة</th>
                    <th className="p-1.5 text-center">الكمية المرتجعة</th>
                    <th className="p-1.5 text-center">سعر البيع</th>
                    <th className="p-1.5 text-left">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-300">
                  {salesReturn.items.map((it, idx) => (
                    <tr key={idx}>
                      <td className="p-1.5 font-mono text-slate-600">{idx + 1}</td>
                      <td className="p-1.5 font-bold">{it.productName}</td>
                      <td className="p-1.5 text-center">
                        {it.unit === 'KG' ? 'كجم' : it.unit === 'CARTON' ? 'كرتونة' : 'قطعة'}
                      </td>
                      <td className="p-1.5 text-center font-mono font-bold">
                        {it.unit === 'KG' ? Number(it.quantity).toFixed(3) : it.quantity}
                      </td>
                      <td className="p-1.5 text-center font-mono">{Number(it.unitSellingPrice).toFixed(2)}</td>
                      <td className="p-1.5 text-left font-mono font-bold">{Number(it.subtotal).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex justify-end my-3">
                <div className="w-1/2 space-y-1 text-[11px] bg-slate-50 p-2.5 rounded border border-slate-300 font-mono">
                  {salesReturn.discountAdjustedAmount > 0 && (
                    <>
                      <div className="flex justify-between">
                        <span className="font-sans">مجموع المرتجع قبل الخصم:</span>
                        <span>{salesReturn.subtotal.toFixed(2)} {currencySymbol}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-sans">خصم الفاتورة النسبي:</span>
                        <span>- {salesReturn.discountAdjustedAmount.toFixed(2)} {currencySymbol}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between font-black border-t border-slate-400 pt-1 text-xs text-slate-950">
                    <span className="font-sans">صافي قيمة المرتجع:</span>
                    <span>{salesReturn.totalAmount.toFixed(2)} {currencySymbol}</span>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-400 flex justify-between text-[10px] text-slate-600 mt-4">
                <div>توقيع العميل / المستلم: ...............................</div>
                <div>توقيع المسؤول: ...............................</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
