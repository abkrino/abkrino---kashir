import React, { useState, useEffect, useRef } from 'react';
import { User, StoreProfile } from '../types';
import { storage } from '../services/storageService';
import { themeService, ThemeMode } from '../services/themeService';
import { checkUserPermission } from '../services/authSecurityService';
import { cloudService } from '../services/cloudService';
import { licenseService, LicenseStateResult } from '../services/licenseService';
import { 
  ShieldCheck, 
  UserCheck, 
  Coins, 
  Lock, 
  Sun, 
  Moon, 
  Menu, 
  Store, 
  Cloud,
  LogOut,
  ChevronDown,
  Wifi,
  WifiOff,
  Sliders,
  Settings,
  Clock
} from 'lucide-react';

interface NavbarProps {
  currentUser: User;
  onSwitchUser?: (userId: string) => void;
  users?: User[];
  currentCash: number;
  onOpenBackupModal?: () => void;
  onOpenSettingsModal?: () => void;
  onOpenLicenseModal?: () => void;
  onNavigateCloud?: () => void;
  onLockScreen: () => void;
  onOpenLogin: () => void;
  onToggleMobileMenu?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentUser,
  currentCash,
  onOpenSettingsModal,
  onOpenLicenseModal,
  onNavigateCloud,
  onLockScreen,
  onOpenLogin,
  onToggleMobileMenu,
}) => {
  const [storeProfile, setStoreProfile] = useState<StoreProfile>(() => storage.getStoreProfile());
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [isSyncing, setIsSyncing] = useState<boolean>(cloudService.isSyncing());
  const [licenseState, setLicenseState] = useState<LicenseStateResult>(() => licenseService.getLicenseState());
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubStorage = storage.onAction(() => {
      setStoreProfile(storage.getStoreProfile());
    });

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsubCloud = cloudService.subscribe(() => {
      setIsSyncing(cloudService.isSyncing());
    });

    const unsubLicense = licenseService.subscribe(() => {
      setLicenseState(licenseService.getLicenseState());
    });

    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      unsubStorage();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubCloud();
      unsubLicense();
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const isDark = themeService.isDarkMode();

  const handleToggleTheme = () => {
    const nextTheme: ThemeMode = isDark ? 'light' : 'dark';
    themeService.updateSetting('theme', nextTheme);
  };

  const isAdmin = currentUser.role === 'ADMIN';
  const canViewCash = isAdmin || checkUserPermission(currentUser, 'manage_cash');

  return (
    <header className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white border-b border-slate-200 dark:border-slate-800 shadow-xs sticky top-0 z-40 select-none transition-colors" dir="rtl">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2 sm:py-2.5 flex items-center justify-between gap-3">
        {/* Right Section: Brand & Mobile Menu Toggle */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {/* Mobile & Tablet Hamburger Toggle */}
          {onToggleMobileMenu && (
            <button
              type="button"
              onClick={onToggleMobileMenu}
              className="lg:hidden p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer transition shadow-xs"
              aria-label="فتح القائمة الرئيسية"
              title="فتح القائمة الرئيسية"
            >
              <Menu className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </button>
          )}

          {/* Store Logo or Icon */}
          {storeProfile.logo ? (
            <div className="h-9 sm:h-10 w-9 sm:w-10 rounded-xl bg-white dark:bg-slate-800 p-0.5 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0 overflow-hidden shadow-xs">
              <img src={storeProfile.logo} alt="شعار المحل" className="max-h-full max-w-full object-contain" />
            </div>
          ) : (
            <div className="bg-emerald-600 text-white p-2 rounded-xl font-bold shadow-xs flex items-center justify-center shrink-0">
              <Store className="w-5 h-5" />
            </div>
          )}

          {/* Store Name & Branch */}
          <div className="min-w-0">
            <h1 className="font-black text-sm sm:text-base text-slate-900 dark:text-slate-100 flex items-center gap-1.5 leading-tight truncate">
              <span className="truncate">{storeProfile.name || 'اسم المحل'}</span>
              {storeProfile.branchName && (
                <span className="text-xs font-bold text-slate-400 dark:text-slate-500 shrink-0">
                  — {storeProfile.branchName}
                </span>
              )}
            </h1>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate hidden sm:block">
              {storeProfile.receiptHeader || 'نظام إدارة المبيعات ونقاط البيع المتكامل'}
            </p>
          </div>
          {/* Abkrino product identity — kept separate from the customer's store logo */}
          <div className="hidden md:flex items-center justify-center h-9 sm:h-10 w-28 shrink-0 px-1">
            <img
              src="/assets/aistudio/logo.png"
              alt="ABKRINO — SEARCH, DEVELOP, RUN"
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </div>
        </div>

        {/* Left Section: Status, Cash, and User Menu */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Permanent EXPIRING Subscription Countdown Badge */}
          {licenseState.subscriptionPhase === 'EXPIRING' && (
            <button
              type="button"
              onClick={onOpenLicenseModal}
              className="h-9 px-2.5 sm:px-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/60 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-amber-800 dark:text-amber-300 flex items-center gap-1.5 text-xs font-black transition-all shadow-xs cursor-pointer"
              title="اشتراكك قريب من الانتهاء — اضغط لإدخال كود التجديد"
            >
              <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>متبقي {licenseState.daysToExpiry} يوم</span>
            </button>
          )}

          {/* Connection & Cloud Sync Status Indicator */}
          <button
            type="button"
            onClick={onNavigateCloud}
            className={`h-9 px-2.5 sm:px-3 rounded-xl border flex items-center gap-1.5 text-xs font-bold transition-all shadow-xs cursor-pointer ${
              !cloudService.isConfigured()
                ? 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                : isOnline
                ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
                : 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50'
            }`}
            title={
              !cloudService.isConfigured()
                ? 'السحابة غير مُعدّة بعد — يعمل النظام محلياً'
                : isOnline
                ? (isSyncing ? 'جاري المزامنة السحابية...' : 'متصل بالسحابة وتعمل المزامنة التلقائية')
                : 'الوضع المحلي (أوفلاين) - البيانات محفوظة محلياً بأمان'
            }
          >
            {isOnline && cloudService.isConfigured() ? (
              <Cloud className={`w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 ${isSyncing ? 'animate-bounce' : ''}`} />
            ) : !cloudService.isConfigured() ? (
              <Cloud className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            )}
            <span className="hidden sm:inline font-bold">
              {!cloudService.isConfigured()
                ? 'السحابة غير مُعدّة'
                : isOnline
                ? (isSyncing ? 'مزامنة...' : 'السحابة متصلة')
                : 'محلي (أوفلاين)'}
            </span>
          </button>

          {/* Cash Drawer Widget (Restricted by Permission) */}
          {canViewCash && (
            <div
              className="bg-amber-50 dark:bg-slate-800/90 border border-amber-200 dark:border-slate-700 rounded-xl px-2.5 sm:px-3 py-1 flex items-center gap-2 shadow-xs"
              title="رصيد النقدية الحالي في الدرج"
            >
              <div className="w-6 h-6 rounded-lg bg-amber-100 dark:bg-amber-950/80 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                <Coins className="w-3.5 h-3.5" />
              </div>
              <div>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-bold leading-none hidden sm:block">
                  رصيد الدرج:
                </span>
                <span className="text-xs sm:text-sm font-black text-amber-800 dark:text-amber-300 font-mono leading-none">
                  {currentCash.toLocaleString('ar-EG', { minimumFractionDigits: 0 })}{' '}
                  <span className="text-[10px] font-sans font-bold">ج.م</span>
                </span>
              </div>
            </div>
          )}

          {/* User Menu Dropdown Container */}
          <div className="relative" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setIsUserMenuOpen(prev => !prev)}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer transition shadow-xs text-right"
              aria-expanded={isUserMenuOpen}
              aria-haspopup="true"
            >
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center text-white shrink-0 ${
                  isAdmin ? 'bg-emerald-600' : 'bg-blue-600'
                }`}
              >
                {isAdmin ? <ShieldCheck className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
              </div>
              <div className="hidden sm:block text-right">
                <span className="font-black block text-xs text-slate-900 dark:text-slate-100 leading-tight truncate max-w-[100px]">
                  {currentUser.fullName}
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-400 font-bold block leading-none">
                  {isAdmin ? 'مدير النظام' : 'كاشير'}
                </span>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
            </button>

            {/* Dropdown Menu */}
            {isUserMenuOpen && (
              <div
                className="absolute left-0 mt-2 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-2 z-50 text-right animate-in fade-in zoom-in-95 duration-100"
                dir="rtl"
              >
                {/* User info in dropdown */}
                <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 mb-1">
                  <p className="text-xs font-black text-slate-900 dark:text-slate-100 truncate">
                    {currentUser.fullName}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold">
                    @{currentUser.username} • {isAdmin ? 'مدير عام' : 'كاشير مبيعات'}
                  </p>
                </div>

                {/* Dark / Light Mode Toggle */}
                <button
                  type="button"
                  onClick={() => {
                    handleToggleTheme();
                    setIsUserMenuOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition"
                >
                  <div className="flex items-center gap-2">
                    {isDark ? (
                      <Sun className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Moon className="w-4 h-4 text-indigo-600" />
                    )}
                    <span>مظهر الواجهة:</span>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">
                    {isDark ? 'الوضع الداكن' : 'الوضع الفاتح'}
                  </span>
                </button>

                {/* Lock Screen */}
                <button
                  type="button"
                  onClick={() => {
                    setIsUserMenuOpen(false);
                    onLockScreen();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition"
                >
                  <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <span>قفل الشاشة والأمان</span>
                </button>

                {/* Settings (if admin) */}
                {isAdmin && onOpenSettingsModal && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      onOpenSettingsModal();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition"
                  >
                    <Settings className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>إعدادات النظام</span>
                  </button>
                )}

                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />

                {/* Switch User / Logout */}
                <button
                  type="button"
                  onClick={() => {
                    setIsUserMenuOpen(false);
                    onOpenLogin();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-black text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 cursor-pointer transition"
                >
                  <LogOut className="w-4 h-4" />
                  <span>تبديل المستخدم</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
