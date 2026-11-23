import React, { useState, useEffect } from 'react';
import { detectEnvironment } from '../../services/environmentService';
import { Wifi, Laptop, X, AlertTriangle } from 'lucide-react';

const DISMISS_STORAGE_KEY = 'env_desktop_banner_dismissed_until';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const EnvironmentBanner: React.FC = () => {
  const [envInfo] = useState(() => detectEnvironment());
  const [isDismissed, setIsDismissed] = useState<boolean>(() => {
    try {
      const dismissedUntil = localStorage.getItem(DISMISS_STORAGE_KEY);
      if (dismissedUntil && Number(dismissedUntil) > Date.now()) {
        return true;
      }
    } catch {
      // Ignore localStorage read errors
    }
    return false;
  });

  // If in Electron, never show anything
  if (envInfo.isElectron) {
    return null;
  }

  // Windows 7, 8, 8.1
  const isLegacyWindows = ['7', '8', '8.1'].includes(envInfo.windowsVersion);
  if (isLegacyWindows) {
    return (
      <aside aria-label="تنبيه حالة النظام" className="bg-amber-500/15 border-b border-amber-500/30 text-amber-900 dark:text-amber-200 px-4 py-2 text-xs sm:text-sm font-semibold flex items-center justify-between gap-3 transition-all z-20">
        <div className="flex items-center gap-2 mx-auto">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span>هذا الجهاز يعمل بوضع الاتصال الإلزامي. يلزم اتصال بالإنترنت للتحقق من الترخيص.</span>
        </div>
      </aside>
    );
  }

  // Windows 10/11 in browser (non-Electron)
  const isWindowsModernBrowser = envInfo.windowsVersion === '10+' && !envInfo.isElectron;
  if (isWindowsModernBrowser && !isDismissed) {
    const handleDismiss = () => {
      try {
        localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now() + SEVEN_DAYS_MS));
      } catch {
        // Ignore localStorage write errors
      }
      setIsDismissed(true);
    };

    return (
      <aside aria-label="تنبيه نسخة سطح المكتب" className="bg-blue-500/15 border-b border-blue-500/30 text-blue-900 dark:text-blue-200 px-4 py-2 text-xs sm:text-sm font-semibold flex items-center justify-between gap-3 transition-all z-20">
        <div className="flex items-center gap-2 mx-auto">
          <Laptop className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span>يمكنك العمل بدون إنترنت بتثبيت نسخة سطح المكتب.</span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs px-2.5 py-1 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-900 dark:text-blue-100 font-bold cursor-pointer transition-colors shrink-0 flex items-center gap-1"
          title="إخفاء التنبيه لمدة 7 أيام"
        >
          <span>إخفاء</span>
          <X className="w-3.5 h-3.5" />
        </button>
      </aside>
    );
  }

  return null;
};
