import React from 'react';
import { Loader2, AlertTriangle, ShieldAlert, ArrowRight, Home, ShoppingCart } from 'lucide-react';

export interface LoadingStateProps {
  message?: string;
  subMessage?: string;
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = 'جاري تحميل البيانات...',
  subMessage,
  className = '',
}) => {
  return (
    <div
      className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center justify-center min-h-[280px] shadow-xs ${className}`}
    >
      <div className="w-14 h-14 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-4 shadow-xs">
        <Loader2 className="w-7 h-7 animate-spin" />
      </div>
      <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{message}</p>
      {subMessage && (
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 font-medium">{subMessage}</p>
      )}
    </div>
  );
};

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'حدث خطأ أثناء تحميل البيانات',
  message,
  onRetry,
  className = '',
}) => {
  return (
    <div
      className={`bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/50 rounded-2xl p-8 sm:p-10 text-center flex flex-col items-center justify-center shadow-xs ${className}`}
    >
      <div className="w-14 h-14 rounded-2xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 flex items-center justify-center text-rose-600 dark:text-rose-400 mb-4 shadow-xs">
        <AlertTriangle className="w-7 h-7" />
      </div>
      <h3 className="text-base font-black text-rose-900 dark:text-rose-200 mb-1">{title}</h3>
      <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 max-w-md mb-5 leading-relaxed">
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-xs transition cursor-pointer active:scale-95"
        >
          إعادة المحاولة
        </button>
      )}
    </div>
  );
};

export interface UnauthorizedStateProps {
  title?: string;
  message?: string;
  onNavigateHome?: () => void;
  onNavigatePos?: () => void;
  className?: string;
}

export const UnauthorizedState: React.FC<UnauthorizedStateProps> = ({
  title = 'غير مصرح بالوصول',
  message = 'ليس لديك الصلاحيات الكافية للوصول إلى هذه الشاشة أو التقرير. يرجى مراجعة مدير النظام لمنحك الصلاحية اللازمة.',
  onNavigateHome,
  onNavigatePos,
  className = '',
}) => {
  return (
    <div
      className={`bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50 rounded-2xl p-8 sm:p-12 text-center flex flex-col items-center justify-center shadow-xs max-w-2xl mx-auto my-8 ${className}`}
    >
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 flex items-center justify-center text-amber-600 dark:text-amber-400 mb-5 shadow-xs">
        <ShieldAlert className="w-8 h-8 sm:w-10 sm:h-10" />
      </div>

      <span className="text-[11px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/80 px-3 py-1 rounded-full border border-amber-300 dark:border-amber-800 mb-3">
        منطقة محمية بصلاحيات
      </span>

      <h2 className="text-lg sm:text-xl font-black text-slate-900 dark:text-slate-100 mb-2">
        {title}
      </h2>

      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-lg mb-6 leading-relaxed">
        {message}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        {onNavigatePos && (
          <button
            type="button"
            onClick={onNavigatePos}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-sm transition cursor-pointer active:scale-95"
          >
            <ShoppingCart className="w-4 h-4" />
            <span>العودة لشاشة الكاشير (F1)</span>
          </button>
        )}

        {onNavigateHome && (
          <button
            type="button"
            onClick={onNavigateHome}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-xs sm:text-sm border border-slate-200 dark:border-slate-700 transition cursor-pointer active:scale-95"
          >
            <Home className="w-4 h-4" />
            <span>لوحة التحكم الرئيسية</span>
          </button>
        )}
      </div>
    </div>
  );
};
