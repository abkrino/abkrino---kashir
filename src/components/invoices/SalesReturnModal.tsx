import React, { useState, useMemo } from 'react';
import {
  SalesInvoice,
  SalesReturn,
  SalesReturnReason,
  SalesReturnRefundMethod,
  SALES_RETURN_REASON_LABELS,
  CashMovementFunding,
  User,
} from '../../types';
import { storage } from '../../services/storageService';
import { FundingSourceModal } from '../common/FundingSourceModal';
import {
  RotateCcw,
  X,
  AlertTriangle,
  CheckCircle2,
  PackageCheck,
  PackageX,
  Wallet,
  CreditCard,
} from 'lucide-react';

interface SalesReturnModalProps {
  invoice: SalesInvoice;
  currentUser: User;
  onClose: () => void;
  onSuccess: (salesReturn: SalesReturn) => void;
}

export const SalesReturnModal: React.FC<SalesReturnModalProps> = ({
  invoice,
  currentUser,
  onClose,
  onSuccess,
}) => {
  const summary = useMemo(() => storage.getInvoiceReturnSummary(invoice), [invoice]);
  const creditCheck = useMemo(() => storage.canInvoiceRefundToCustomerCredit(invoice), [invoice]);

  // Build returnable quantities state keyed by invoice line key
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const item of invoice.items) {
      const key = storage.getInvoiceLineKey(item);
      initial[key] = 0;
    }
    return initial;
  });

  const [reason, setReason] = useState<SalesReturnReason>('CUSTOMER_CHANGED_MIND');
  const [reasonNote, setReasonNote] = useState<string>('');
  const [refundMethod, setRefundMethod] = useState<SalesReturnRefundMethod>('CASH');
  const [returnToStock, setReturnToStock] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [showFundingModal, setShowFundingModal] = useState<boolean>(false);

  const canNegativeCash =
    currentUser.role === 'ADMIN' || Boolean(currentUser.permissions?.canWithdrawNegativeCash);

  const lineRows = useMemo(() => {
    return invoice.items.map((item) => {
      const key = storage.getInvoiceLineKey(item);
      const fallbackKey = `${item.productId}::${item.unit}`;
      const previouslyReturned =
        summary.returnedQtyByKey[key] !== undefined
          ? summary.returnedQtyByKey[key]
          : (summary.returnedQtyByKey[fallbackKey] || 0);
      const maxReturnable = Math.max(0, Math.round((item.quantity - previouslyReturned) * 1000) / 1000);
      const selectedQty = Math.min(maxReturnable, Math.max(0, returnQuantities[key] || 0));
      return {
        item,
        key,
        previouslyReturned,
        maxReturnable,
        selectedQty,
      };
    });
  }, [invoice.items, summary, returnQuantities]);

  const previewTotals = useMemo(() => {
    const subtotal = Math.round(
      lineRows.reduce((s, r) => s + r.selectedQty * r.item.unitPrice, 0) * 100
    ) / 100;
    let discountShare = 0;
    if (invoice.discountAmount > 0 && invoice.subtotal > 0) {
      const ratio = Math.max(0, Math.min(1, invoice.discountAmount / invoice.subtotal));
      discountShare = Math.round(subtotal * ratio * 100) / 100;
    }
    let totalAmount = Math.max(0, Math.round((subtotal - discountShare) * 100) / 100);
    const maxRemAmount = Math.max(0, Math.round((invoice.total - summary.totalReturnedAmount) * 100) / 100);
    if (totalAmount > maxRemAmount) {
      totalAmount = maxRemAmount;
    }
    return { subtotal, discountShare, totalAmount };
  }, [lineRows, invoice, summary.totalReturnedAmount]);

  const cashEval = useMemo(() => {
    if (refundMethod !== 'CASH' || previewTotals.totalAmount <= 0) {
      return { allowed: true, requiresFundingSource: false, available: storage.calculateCurrentCashInDrawer(), mode: storage.getAccountingMode() };
    }
    return storage.evaluateCashOut(previewTotals.totalAmount, {
      user: currentUser,
      operation: 'SALES_REFUND',
    });
  }, [refundMethod, previewTotals.totalAmount, currentUser]);

  const handleQtyChange = (key: string, maxReturnable: number, rawVal: string, isWeighed: boolean) => {
    const parsed = parseFloat(rawVal);
    if (isNaN(parsed) || parsed <= 0) {
      setReturnQuantities(prev => ({ ...prev, [key]: 0 }));
      return;
    }
    const clamped = Math.min(maxReturnable, parsed);
    const normalized = isWeighed ? Math.round(clamped * 1000) / 1000 : Math.floor(clamped);
    setReturnQuantities(prev => ({ ...prev, [key]: normalized }));
  };

  const handleSelectAllRemaining = () => {
    const next: Record<string, number> = {};
    for (const row of lineRows) {
      next[row.key] = row.maxReturnable;
    }
    setReturnQuantities(next);
  };

  const executeSubmit = async (allowNegativeCash: boolean = false, fundingDetails?: CashMovementFunding) => {
    setError(null);

    const selectedItems = lineRows
      .filter(r => r.selectedQty > 0)
      .map(r => ({
        invoiceItemId: r.item.id,
        productId: r.item.productId,
        unit: r.item.unit,
        quantity: r.selectedQty,
      }));

    if (selectedItems.length === 0) {
      setError('يرجى تحديد كمية مرتجعة لصنف واحد على الأقل.');
      return;
    }

    if (reason === 'OTHER' && !reasonNote.trim()) {
      setError('عند اختيار سبب "أخرى" يجب كتابة توضيح سبب المرتجع في مربع النص الإلزامي.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = storage.processSalesReturn({
        invoiceId: invoice.id,
        items: selectedItems,
        reason,
        reasonNote: reasonNote.trim() || undefined,
        refundMethod,
        returnToStock,
        user: currentUser,
        allowNegativeCash,
        fundingDetails,
      });

      if (!res.success || !res.salesReturn) {
        setError(res.error || 'تعذر تنفيذ عملية المرتجع');
        return;
      }

      await storage.flush();
      if (storage.getWriteError()) {
        setError(`تعذر تأكيد حفظ المرتجع في التخزين الدائم: ${storage.getWriteError()}`);
        return;
      }

      setShowFundingModal(false);
      onSuccess(res.salesReturn);
    } catch (err: any) {
      setError(err?.message || 'حدث خطأ أثناء تنفيذ المرتجع');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (refundMethod === 'CASH' && previewTotals.totalAmount > 0 && !cashEval.allowed) {
      if (canNegativeCash) {
        setShowFundingModal(true);
      } else {
        setError(cashEval.reason || 'رصيد الدرج لا يكفي للرد النقدي.');
      }
      return;
    }
    executeSubmit(false);
  };

  const anyReturnable = lineRows.some(r => r.maxReturnable > 0);

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" dir="rtl">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-3xl w-full shadow-2xl text-right my-6 overflow-hidden transition-colors">
        {/* Header */}
        <div className="p-4 bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 rounded-xl">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-sm text-slate-900 dark:text-white">
                تسجيل مرتجع مبيعات — الفاتورة ({invoice.invoiceNumber})
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                العميل: <strong>{invoice.customerName}</strong> • التاريخ: {invoice.date} • إجمالي الفاتورة: {invoice.total.toFixed(2)} ج.م
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 font-bold flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {summary.returnedCount > 0 && (
            <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 flex items-center justify-between">
              <span className="font-bold">
                توجد ({summary.returnedCount}) مرتجعات سابقة على هذه الفاتورة بإجمالي {summary.totalReturnedAmount.toFixed(2)} ج.م
              </span>
              <span className="font-mono text-[11px]">
                المتبقي القابل للاسترجاع: {(invoice.total - summary.totalReturnedAmount).toFixed(2)} ج.م
              </span>
            </div>
          )}

          {/* Items Selection Table */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className="bg-slate-100 dark:bg-slate-800/80 px-3 py-2 flex items-center justify-between border-b border-slate-200 dark:border-slate-700">
              <span className="font-bold text-slate-800 dark:text-slate-200">اختر الأصناف والكميات المطلوب إرجاعها:</span>
              {anyReturnable && (
                <button
                  type="button"
                  onClick={handleSelectAllRemaining}
                  className="text-[11px] bg-amber-100 hover:bg-amber-200 dark:bg-amber-950 dark:hover:bg-amber-900 text-amber-800 dark:text-amber-300 px-2.5 py-1 rounded-lg font-bold cursor-pointer"
                >
                  تحديد كل الكمية المتبقية
                </button>
              )}
            </div>

            <div className="overflow-x-auto max-h-60">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 dark:bg-slate-900/80 text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 text-[11px]">
                  <tr>
                    <th className="py-2 px-3">الصنف</th>
                    <th className="py-2 px-2 text-center">الوحدة</th>
                    <th className="py-2 px-2 text-center">المباع</th>
                    <th className="py-2 px-2 text-center">سابق إرجاعه</th>
                    <th className="py-2 px-2 text-center">المتاح</th>
                    <th className="py-2 px-2 text-center">سعر البيع</th>
                    <th className="py-2 px-3 text-center">الكمية المرتجعة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {lineRows.map((row) => {
                    const isWeighed = row.item.unit === 'KG';
                    return (
                      <tr key={row.key} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                        <td className="py-2 px-3 font-bold text-slate-900 dark:text-white">
                          <div>{row.item.productName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{row.item.productCode}</div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          {row.item.unit === 'KG' ? 'كجم' : row.item.unit === 'CARTON' ? 'كرتونة' : 'قطعة'}
                        </td>
                        <td className="py-2 px-2 text-center font-mono">{row.item.quantity}</td>
                        <td className="py-2 px-2 text-center font-mono text-amber-600 dark:text-amber-400">
                          {row.previouslyReturned}
                        </td>
                        <td className="py-2 px-2 text-center font-mono font-bold text-emerald-600 dark:text-emerald-400">
                          {row.maxReturnable}
                        </td>
                        <td className="py-2 px-2 text-center font-mono">{row.item.unitPrice.toFixed(2)}</td>
                        <td className="py-2 px-3 text-center">
                          <input
                            type="number"
                            min="0"
                            max={row.maxReturnable}
                            step={isWeighed ? '0.05' : '1'}
                            disabled={row.maxReturnable <= 0}
                            value={row.selectedQty || ''}
                            placeholder="0"
                            onChange={(e) => handleQtyChange(row.key, row.maxReturnable, e.target.value, isWeighed)}
                            className="w-20 text-center bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg py-1 px-2 font-mono font-bold text-slate-900 dark:text-white disabled:opacity-40"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reason + Stock + Refund Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Reason Section */}
            <div className="space-y-2.5 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
              <div>
                <label className="block font-bold text-slate-800 dark:text-slate-200 mb-1">
                  سبب المرتجع (إلزامي):
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as SalesReturnReason)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-2 font-bold text-slate-900 dark:text-white"
                >
                  {(Object.entries(SALES_RETURN_REASON_LABELS) as [SalesReturnReason, string][]).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  {reason === 'OTHER' ? 'توضيح سبب المرتجع (إلزامي عند اختيار أخرى):' : 'ملاحظات إضافية (اختياري):'}
                </label>
                <input
                  type="text"
                  required={reason === 'OTHER'}
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  placeholder={reason === 'OTHER' ? 'اكتب سبب المرتجع بالتفصيل...' : 'ملاحظة أو تفاصيل إضافية...'}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-2 text-slate-900 dark:text-white"
                />
              </div>

              {/* Return To Stock Toggle */}
              <div>
                <span className="block font-bold text-slate-800 dark:text-slate-200 mb-1.5">مصير البضاعة المرتجعة:</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setReturnToStock(true)}
                    className={`p-2 rounded-lg border font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      returnToStock
                        ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    <PackageCheck className="w-4 h-4" />
                    <span>تعود للمخزون</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setReturnToStock(false)}
                    className={`p-2 rounded-lg border font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      !returnToStock
                        ? 'bg-rose-600 text-white border-rose-500 shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    <PackageX className="w-4 h-4" />
                    <span>تالف (لا تعود)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Refund Method & Totals */}
            <div className="space-y-3 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col justify-between">
              <div className="space-y-2">
                <span className="block font-bold text-slate-800 dark:text-slate-200">طريقة رد قيمة المرتجع:</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRefundMethod('CASH')}
                    className={`p-2.5 rounded-lg border font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                      refundMethod === 'CASH'
                        ? 'bg-amber-600 text-white border-amber-500 shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    <Wallet className="w-4 h-4" />
                    <span>نقدي من الدرج</span>
                  </button>
                  <button
                    type="button"
                    disabled={!creditCheck.eligible}
                    onClick={() => setRefundMethod('CUSTOMER_CREDIT')}
                    title={creditCheck.reason || 'إضافة قيمة المرتجع كرصيد في حساب العميل'}
                    className={`p-2.5 rounded-lg border font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all disabled:opacity-45 disabled:cursor-not-allowed ${
                      refundMethod === 'CUSTOMER_CREDIT'
                        ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>رصيد للعميل</span>
                  </button>
                </div>

                {!creditCheck.eligible && (
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                    * {creditCheck.reason}
                  </p>
                )}

                {refundMethod === 'CASH' && previewTotals.totalAmount > 0 && !cashEval.allowed && (
                  <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 text-[11px] font-bold space-y-1">
                    <div>
                      رصيد الدرج الحالي ({cashEval.available.toFixed(2)} ج.م) لا يكفي للرد النقدي.
                    </div>
                    {creditCheck.eligible && (
                      <button
                        type="button"
                        onClick={() => setRefundMethod('CUSTOMER_CREDIT')}
                        className="underline text-blue-700 dark:text-blue-300 cursor-pointer"
                      >
                        التحويل إلى "رصيد للعميل" بدلاً من الدرج
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-700 space-y-1">
                {previewTotals.discountShare > 0 && (
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>تسوية خصم الفاتورة النسبي:</span>
                    <span className="font-mono">- {previewTotals.discountShare.toFixed(2)} ج.م</span>
                  </div>
                )}
                <div className="flex justify-between items-center font-black text-sm text-slate-900 dark:text-white">
                  <span>صافي قيمة المرتجع:</span>
                  <span className="font-mono text-base text-amber-600 dark:text-amber-400">
                    {previewTotals.totalAmount.toFixed(2)} ج.م
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Actions Footer */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !anyReturnable || previewTotals.totalAmount <= 0}
              className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center gap-1.5 cursor-pointer shadow-md disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{isSubmitting ? 'جاري التنفيذ...' : 'اعتماد المرتجع وطباعة الإيصال'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Funding Source Override for authorized admin/negative cash user */}
      <FundingSourceModal
        isOpen={showFundingModal}
        amount={previewTotals.totalAmount}
        available={cashEval.available}
        mode={cashEval.mode}
        operationLabel="مرتجع مبيعات نقدي"
        onCancel={() => setShowFundingModal(false)}
        onConfirm={(funding) => executeSubmit(true, funding)}
      />
    </div>
  );
};
