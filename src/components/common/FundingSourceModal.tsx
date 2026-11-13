import React, { useState } from 'react';
import { AccountingMode, CashMovementFunding, FundingSource } from '../../types';
import { storage } from '../../services/storageService';
import { AlertTriangle, X } from 'lucide-react';

interface FundingSourceModalProps {
  isOpen: boolean;
  amount: number;
  available: number;
  mode: AccountingMode;
  operationLabel: string;
  onCancel: () => void;
  onConfirm: (funding: CashMovementFunding) => void;
}

export const FundingSourceModal: React.FC<FundingSourceModalProps> = ({
  isOpen,
  amount,
  available,
  mode,
  operationLabel,
  onCancel,
  onConfirm,
}) => {
  const activeSources = storage
    .getActiveFundingSources()
    .filter((s) => s.type !== 'DRAWER');

  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    activeSources[0]?.id || 'fs-owner-loan'
  );
  const [otherNote, setOtherNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedSource: FundingSource | undefined =
    activeSources.find((s) => s.id === selectedSourceId) || activeSources[0];

  const handleConfirm = () => {
    setError(null);
    if (!selectedSource) {
      setError('يرجى اختيار مصدر التمويل أولاً');
      return;
    }

    if (selectedSource.type === 'OTHER' && !otherNote.trim()) {
      setError('عند اختيار "أخرى" يجب كتابة توضيح مصدر التمويل في مربع النص الإلزامي');
      return;
    }

    onConfirm({
      type: selectedSource.type,
      label: selectedSource.label,
      note: selectedSource.type === 'OTHER' ? otherNote.trim() : selectedSource.note,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50" dir="rtl">
      <div className="bg-white dark:bg-slate-900 border border-amber-400/80 dark:border-amber-600/80 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-5 h-5" />
            <h3 className="font-black text-sm">تحديد مصدر التمويل المنظّم — {operationLabel}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-700 dark:text-slate-300 mt-3 leading-relaxed">
          المبلغ المطلوب صرفه (<strong>{amount.toLocaleString('ar-EG')} ج.م</strong>) يتجاوز{' '}
          {mode === 'MONTHLY_POOL' ? 'صافي الوعاء الشهري المتاح' : 'النقدية المتاحة بالدرج'} (
          <strong>{available.toLocaleString('ar-EG')} ج.م</strong>).
          <br />
          <strong>يرجى تحديد مصدر التمويل لتوثيقه في كشف الخزينة والتقارير:</strong>
        </p>

        {error && (
          <div className="mt-3 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs font-bold">
            {error}
          </div>
        )}

        <div className="space-y-2 text-xs mt-4 mb-4 max-h-60 overflow-y-auto">
          {activeSources.length === 0 ? (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs font-bold">
              لا توجد مصادر تمويل بديلة مفعّلة حالياً. يرجى تفعيل مصدر واحد على الأقل من إعدادات المحاسبة.
            </div>
          ) : (
            activeSources.map((src) => {
              const isSelected = selectedSource?.id === src.id;
              return (
                <div key={src.id} className="space-y-2">
                  <label
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors font-medium ${
                      isSelected
                        ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/40 text-slate-900 dark:text-white font-bold'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="structuredFundingSource"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedSourceId(src.id);
                        setError(null);
                      }}
                      className="w-4 h-4 text-amber-600"
                    />
                    <span className="flex-1">{src.label}</span>
                  </label>

                  {isSelected && src.type === 'OTHER' && (
                    <div className="mr-6">
                      <label className="block text-[11px] font-bold text-amber-700 dark:text-amber-300 mb-1">
                        اكتب تفاصيل مصدر التمويل (إلزامي) *:
                      </label>
                      <input
                        type="text"
                        value={otherNote}
                        onChange={(e) => {
                          setOtherNote(e.target.value);
                          if (error) setError(null);
                        }}
                        placeholder="مثال: سحب من محفظة المحل / شريك خارجي..."
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-amber-400 dark:border-amber-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white font-bold"
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold text-xs cursor-pointer"
          >
            تراجع
          </button>
          <button
            type="button"
            disabled={activeSources.length === 0}
            onClick={handleConfirm}
            className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold text-xs cursor-pointer shadow-md"
          >
            تأكيد الصرف وتدوين المصدر
          </button>
        </div>
      </div>
    </div>
  );
};
