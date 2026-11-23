import React from 'react';
import { AlertTriangle, AlertCircle, Info, X, Loader2 } from 'lucide-react';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'تأكيد العملية',
  cancelLabel = 'إلغاء',
  variant = 'danger',
  onConfirm,
  onCancel,
  isLoading = false,
}) => {
  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      iconBg: 'bg-rose-100 dark:bg-rose-950/70 border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400',
      icon: AlertTriangle,
      buttonBg: 'bg-rose-600 hover:bg-rose-500 text-white',
    },
    warning: {
      iconBg: 'bg-amber-100 dark:bg-amber-950/70 border-amber-300 dark:border-amber-800 text-amber-600 dark:text-amber-400',
      icon: AlertCircle,
      buttonBg: 'bg-amber-600 hover:bg-amber-500 text-white',
    },
    primary: {
      iconBg: 'bg-emerald-100 dark:bg-emerald-950/70 border-emerald-300 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400',
      icon: Info,
      buttonBg: 'bg-emerald-600 hover:bg-emerald-500 text-white',
    },
  }[variant];

  const Icon = variantStyles.icon;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs select-none"
      dir="rtl"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-2xl transition-all animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center shrink-0 shadow-xs ${variantStyles.iconBg}`}>
              <Icon className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-slate-100 leading-snug">
                {title}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition"
            aria-label="إغلاق النافذة"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
          {message}
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs sm:text-sm font-bold transition cursor-pointer disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-black shadow-sm transition cursor-pointer active:scale-95 disabled:opacity-50 ${variantStyles.buttonBg}`}
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
