import React, { useRef, useState } from 'react';
import {
  Upload,
  Download,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  X,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { User } from '../../types';
import { storage } from '../../services/storageService';
import {
  ExecuteImportResult,
  ImportDuplicateMode,
  ProductImportPreview,
  executeProductImport,
  generateImportTemplateCsv,
  generateImportTemplateXlsx,
  parseAndPreviewProductImport,
} from '../../services/productImportService';

interface ProductImportModalProps {
  isOpen: boolean;
  currentUser: User;
  onClose: () => void;
  onImportComplete: () => void;
}

export const ProductImportModal: React.FC<ProductImportModalProps> = ({
  isOpen,
  currentUser,
  onClose,
  onImportComplete,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const storeProfile = storage.getStoreProfile();

  const [duplicateMode, setDuplicateMode] = useState<ImportDuplicateMode>('SKIP');
  const [preview, setPreview] = useState<ProductImportPreview | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ExecuteImportResult | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  if (!isOpen) return null;

  const canManageProducts =
    currentUser.role === 'ADMIN' || Boolean(currentUser.permissions?.canManageProducts);

  const handleDownloadXlsxTemplate = async () => {
    setUiError(null);
    try {
      const blob = await generateImportTemplateXlsx(storeProfile);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'قالب_استيراد_الأصناف.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setUiError(`تعذر توليد قالب Excel: ${err?.message || 'خطأ غير متوقع'}`);
    }
  };

  const handleDownloadCsvTemplate = () => {
    setUiError(null);
    try {
      const csv = generateImportTemplateCsv(storeProfile);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'قالب_استيراد_الأصناف.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setUiError(`تعذر توليد قالب CSV: ${err?.message || 'خطأ غير متوقع'}`);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUiError(null);
    setExecutionResult(null);
    setIsParsing(true);

    try {
      const buffer = await file.arrayBuffer();
      const result = await parseAndPreviewProductImport({
        fileName: file.name,
        buffer,
        existingProducts: storage.getProducts(),
        storeProfile,
      });
      setPreview(result);
    } catch (err: any) {
      setUiError(`تعذر قراءة الملف المحدد: ${err?.message || 'خطأ غير معروف'}`);
      setPreview(null);
    } finally {
      setIsParsing(false);
    }
  };

  const handleExecuteImport = async () => {
    if (!preview || !preview.ok || isExecuting) return;
    setUiError(null);
    setIsExecuting(true);
    try {
      const res = await executeProductImport({
        preview,
        duplicateMode,
        user: currentUser,
      });
      setExecutionResult(res);
      if (res.success) {
        onImportComplete();
      } else {
        setUiError(res.error || 'فشل تنفيذ عملية الاستيراد.');
      }
    } finally {
      setIsExecuting(false);
    }
  };

  const handleResetAndClose = () => {
    setPreview(null);
    setExecutionResult(null);
    setUiError(null);
    setDuplicateMode('SKIP');
    onClose();
  };

  const invalidRowNumbers = new Set((preview?.errors || []).map(err => err.rowNumber));
  const hasActionableRows = Boolean(
    preview &&
      preview.ok &&
      (preview.newRows > 0 || (duplicateMode === 'UPDATE' && preview.duplicateExistingRows > 0))
  );

  return (
    <div
      className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50 overflow-y-auto"
      dir="rtl"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-2xl max-w-5xl w-full shadow-2xl p-6 text-right relative flex flex-col my-6 max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            <div>
              <h3 className="font-black text-lg text-slate-900 dark:text-white">
                استيراد الأصناف من ملف
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                رفع ملف Excel أو CSV بحد أقصى 5000 صف — مع معاينة كاملة ولقطة أمان قبل أي حفظ
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetAndClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1.5 rounded-lg cursor-pointer"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 py-4 space-y-4">
          {!canManageProducts ? (
            <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded-xl p-4 text-xs font-bold text-rose-800 dark:text-rose-200">
              غير مصرح: استيراد الأصناف متاح للمدير أو لمن يملك صلاحية إدارة الأصناف فقط.
            </div>
          ) : (
            <>
              {/* Step 1: Template Download & Upload */}
              <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <h4 className="font-black text-sm text-slate-900 dark:text-white">
                      1. تحميل ملف القالب وتجهيز البيانات
                    </h4>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                      يحتوي القالب على العناوين العربية المعتمدة وصفين كمثال، ويُكيَّف تلقائياً مع موديولات المحل المفعّلة
                      {storeProfile.modules.dairy ? ' (يشمل نوع التخزين للألبان)' : ''}
                      {storeProfile.modules.weighingScale ? ' (يشمل حقول الميزان)' : ''}.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap shrink-0">
                    <button
                      type="button"
                      onClick={handleDownloadXlsxTemplate}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3.5 py-2 rounded-xl flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      <span>تحميل ملف القالب</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadCsvTemplate}
                      className="bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-bold px-3 py-2 rounded-xl flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>قالب CSV</span>
                    </button>
                  </div>
                </div>

                {/* Duplicate Mode Option */}
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                  <span className="block text-xs font-black text-slate-800 dark:text-slate-200 mb-2">
                    2. عند تطابق الباركود أو الاسم مع صنف موجود بالمخزن:
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
                    <label
                      className={`border rounded-xl p-3 cursor-pointer flex items-start gap-2.5 transition-colors ${
                        duplicateMode === 'SKIP'
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-slate-900 dark:text-white'
                          : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="duplicateMode"
                        checked={duplicateMode === 'SKIP'}
                        onChange={() => setDuplicateMode('SKIP')}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="font-black block">تخطّي الموجود (الافتراضي)</span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          إضافة الأصناف الجديدة فقط وعدم تعديل الأصناف المسجلة مسبقاً.
                        </span>
                      </div>
                    </label>

                    <label
                      className={`border rounded-xl p-3 cursor-pointer flex items-start gap-2.5 transition-colors ${
                        duplicateMode === 'UPDATE'
                          ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-500 text-slate-900 dark:text-white'
                          : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="duplicateMode"
                        checked={duplicateMode === 'UPDATE'}
                        onChange={() => setDuplicateMode('UPDATE')}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="font-black block">تحديث الموجود (الأسعار والبيانات فقط)</span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          يعدّل الأسعار والبيانات للأصناف المطابقة فقط ولا يلمس الرصيد المخزني نهائياً.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>

                {/* File Picker */}
                <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={isParsing || isExecuting}
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full sm:w-auto bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-black px-5 py-2.5 rounded-xl flex items-center justify-center gap-2 cursor-pointer shadow-sm transition-colors"
                  >
                    {isParsing ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    <span>{isParsing ? 'جاري فحص الملف...' : 'اختيار ملف Excel أو CSV للمعاينة'}</span>
                  </button>
                  {preview && (
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      الملف المحدد: <span className="font-mono text-emerald-700 dark:text-emerald-400">{preview.fileName}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Error Message */}
              {(uiError || preview?.fatalError) && (
                <div className="bg-rose-50 dark:bg-rose-950/50 border border-rose-300 dark:border-rose-800 rounded-xl p-3.5 text-xs font-bold text-rose-800 dark:text-rose-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{uiError || preview?.fatalError}</span>
                </div>
              )}

              {/* Success Message */}
              {executionResult?.success && (
                <div className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-400 dark:border-emerald-700 rounded-xl p-4 text-xs text-emerald-900 dark:text-emerald-100 space-y-1">
                  <div className="font-black text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    <span>تم استيراد الأصناف بنجاح وحفظ الدفعة في التخزين الدائم!</span>
                  </div>
                  <p>
                    أصناف جديدة: <strong className="font-mono">{executionResult.addedCount}</strong> •
                    أصناف محدّثة: <strong className="font-mono">{executionResult.updatedCount}</strong> •
                    أصناف متخطاة: <strong className="font-mono">{executionResult.skippedCount}</strong> •
                    تسويات رصيد افتتاحي مسجّلة: <strong className="font-mono">{executionResult.openingAdjustmentsCount}</strong>
                  </p>
                </div>
              )}

              {/* Preview Section */}
              {preview && !preview.fatalError && (
                <div className="space-y-4">
                  {/* Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
                      <span className="text-slate-500 dark:text-slate-400 block font-bold">إجمالي الصفوف</span>
                      <span className="text-xl font-black text-slate-900 dark:text-white font-mono">
                        {preview.totalRows}
                      </span>
                    </div>
                    <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3">
                      <span className="text-emerald-700 dark:text-emerald-400 block font-bold">أصناف جديدة</span>
                      <span className="text-xl font-black text-emerald-700 dark:text-emerald-300 font-mono">
                        {preview.newRows}
                      </span>
                    </div>
                    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-3">
                      <span className="text-amber-800 dark:text-amber-300 block font-bold">
                        مكرر بالمخزن ({duplicateMode === 'UPDATE' ? 'سيُحدَّث' : 'سيُتخطى'})
                      </span>
                      <span className="text-xl font-black text-amber-700 dark:text-amber-300 font-mono">
                        {preview.duplicateExistingRows}
                      </span>
                    </div>
                    <div
                      className={`border rounded-xl p-3 ${
                        preview.invalidRows > 0
                          ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800'
                          : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
                      }`}
                    >
                      <span
                        className={`block font-bold ${
                          preview.invalidRows > 0
                            ? 'text-rose-700 dark:text-rose-300'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        صفوف خاطئة
                      </span>
                      <span
                        className={`text-xl font-black font-mono ${
                          preview.invalidRows > 0
                            ? 'text-rose-700 dark:text-rose-300'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {preview.invalidRows}
                      </span>
                    </div>
                  </div>

                  {/* Errors Table */}
                  {preview.errors.length > 0 && (
                    <div className="border border-rose-300 dark:border-rose-800 rounded-xl overflow-hidden">
                      <div className="bg-rose-100 dark:bg-rose-950/80 px-4 py-2.5 text-xs font-black text-rose-900 dark:text-rose-200 flex items-center justify-between">
                        <span>جدول أخطاء الملف ({preview.errors.length} خطأ) — يجب تصحيحها قبل التنفيذ</span>
                      </div>
                      <div className="max-h-56 overflow-y-auto bg-white dark:bg-slate-900">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-rose-50 dark:bg-slate-950 text-rose-800 dark:text-rose-300 border-b border-rose-200 dark:border-slate-800">
                            <tr>
                              <th className="py-2 px-3 w-24">رقم الصف</th>
                              <th className="py-2 px-3 w-44">العمود</th>
                              <th className="py-2 px-3">السبب</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-rose-100 dark:divide-slate-800">
                            {preview.errors.map((err, idx) => (
                              <tr key={`${err.rowNumber}-${err.column}-${idx}`}>
                                <td className="py-2 px-3 font-mono font-bold text-rose-700 dark:text-rose-300">
                                  {err.rowNumber}
                                </td>
                                <td className="py-2 px-3 font-bold text-slate-800 dark:text-slate-200">
                                  {err.column}
                                </td>
                                <td className="py-2 px-3 text-rose-700 dark:text-rose-300">
                                  {err.reason}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Data Preview Table */}
                  {preview.rows.length > 0 && (
                    <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      <div className="bg-slate-100 dark:bg-slate-950 px-4 py-2 text-xs font-black text-slate-700 dark:text-slate-300 flex items-center justify-between">
                        <span>
                          معاينة البيانات قبل الحفظ
                          {preview.rows.length > 100 ? ' (عرض أول 100 صف)' : ''}
                        </span>
                        <span className="text-[11px] font-normal text-slate-500">
                          الرصيد الافتتاحي للأصناف الجديدة يُسجَّل تلقائياً كتسوية مخزون «رصيد افتتاحي»
                        </span>
                      </div>
                      <div className="max-h-60 overflow-auto">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400">
                            <tr>
                              <th className="py-2 px-2.5">الصف</th>
                              <th className="py-2 px-2.5">الحالة</th>
                              <th className="py-2 px-2.5">اسم الصنف</th>
                              <th className="py-2 px-2.5">الباركود</th>
                              <th className="py-2 px-2.5">الوحدة</th>
                              <th className="py-2 px-2.5">سعر البيع</th>
                              <th className="py-2 px-2.5">سعر الشراء</th>
                              <th className="py-2 px-2.5">الرصيد الافتتاحي</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                            {preview.rows.slice(0, 100).map((r) => {
                              const isErr = invalidRowNumbers.has(r.rowNumber);
                              return (
                                <tr
                                  key={r.rowNumber}
                                  className={
                                    isErr
                                      ? 'bg-rose-50/60 dark:bg-rose-950/20'
                                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                                  }
                                >
                                  <td className="py-1.5 px-2.5 font-mono">{r.rowNumber}</td>
                                  <td className="py-1.5 px-2.5">
                                    {isErr ? (
                                      <span className="bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200 px-2 py-0.5 rounded font-bold text-[10px]">
                                        خطأ
                                      </span>
                                    ) : r.matchType === 'EXISTING' ? (
                                      <span className="bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200 px-2 py-0.5 rounded font-bold text-[10px]">
                                        {duplicateMode === 'UPDATE' ? 'تحديث' : 'تخطّي'}
                                      </span>
                                    ) : (
                                      <span className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 px-2 py-0.5 rounded font-bold text-[10px]">
                                        جديد
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-2.5 font-bold text-slate-900 dark:text-white">
                                    {r.name || '—'}
                                  </td>
                                  <td className="py-1.5 px-2.5 font-mono">{r.barcode || '—'}</td>
                                  <td className="py-1.5 px-2.5">{r.baseUnit || '—'}</td>
                                  <td className="py-1.5 px-2.5 font-mono">{r.retailPricePerBase}</td>
                                  <td className="py-1.5 px-2.5 font-mono">{r.costPricePerBase}</td>
                                  <td className="py-1.5 px-2.5 font-mono">
                                    {r.matchType === 'EXISTING' && duplicateMode === 'UPDATE'
                                      ? 'لا يتغير'
                                      : r.openingBalance}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>تنفيذ ذري: تُؤخذ لقطة أمان تلقائية قبل الحفظ ولا يُطبَّق أي تغيير عند حدوث خطأ.</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleResetAndClose}
              className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              إغلاق
            </button>
            {canManageProducts && !executionResult?.success && (
              <button
                type="button"
                disabled={!hasActionableRows || isExecuting || isParsing}
                onClick={handleExecuteImport}
                className="px-5 py-2 rounded-xl text-xs font-black bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer flex items-center gap-1.5 shadow-sm transition-colors"
              >
                {isExecuting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{isExecuting ? 'جاري الحفظ والتثبيت...' : 'تأكيد وتنفيذ الاستيراد'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
