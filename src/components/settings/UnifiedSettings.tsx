import React, { useState, useEffect } from 'react';
import { User, TabType } from '../../types';
import { StoreProfileSettings } from './StoreProfileSettings';
import { ThemeAccessibilitySettings } from './ThemeAccessibilitySettings';
import { BackupManager } from '../backup/BackupManager';
import { CloudDashboard } from '../cloud/CloudDashboard';
import { AuditTrail } from '../audit/AuditTrail';
import { PageHeader } from '../common/PageHeader';
import { licenseService, LicenseStateResult } from '../../services/licenseService';
import { LicenseActivationModal } from '../license/LicenseActivationModal';
import {
  Settings,
  Store,
  Sliders,
  Database,
  Cloud,
  FileText,
  KeyRound,
  Calculator,
  ShieldCheck,
  Laptop,
  Calendar,
  CheckCircle2,
  Copy,
  Check,
  Clock,
  Sparkles,
  Layers,
  ChevronLeft
} from 'lucide-react';

export type SettingsSubTab =
  | 'store-profile'
  | 'accounting'
  | 'appearance'
  | 'license'
  | 'backup'
  | 'cloud'
  | 'audit';

interface UnifiedSettingsProps {
  currentUser: User;
  initialSubTab?: SettingsSubTab;
  onRefreshAll: () => void;
  onNavigateTab?: (tab: TabType) => void;
}

export const UnifiedSettings: React.FC<UnifiedSettingsProps> = ({
  currentUser,
  initialSubTab = 'store-profile',
  onRefreshAll,
  onNavigateTab,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<SettingsSubTab>(initialSubTab);
  const [isActivationModalOpen, setIsActivationModalOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [licenseState, setLicenseState] = useState<LicenseStateResult>(() => licenseService.getLicenseState());

  useEffect(() => {
    setActiveSubTab(initialSubTab);
  }, [initialSubTab]);

  useEffect(() => {
    const unsub = licenseService.subscribe(() => {
      setLicenseState(licenseService.getLicenseState());
    });
    return unsub;
  }, []);

  const subTabs = [
    {
      id: 'store-profile' as SettingsSubTab,
      label: 'بيانات المحل',
      description: 'الهوية والشعار وموديولات العمل',
      icon: Store,
    },
    {
      id: 'accounting' as SettingsSubTab,
      label: 'المحاسبة',
      description: 'دليل الحسابات وقيود اليومية (قريباً)',
      icon: Calculator,
      badge: 'مؤقت',
    },
    {
      id: 'appearance' as SettingsSubTab,
      label: 'المظهر وإمكانية الوصول',
      description: 'السمات، الألوان، وحجم الخط',
      icon: Sliders,
    },
    {
      id: 'license' as SettingsSubTab,
      label: 'الترخيص',
      description: 'معلومات الترخيص والتفعيل',
      icon: KeyRound,
    },
    {
      id: 'backup' as SettingsSubTab,
      label: 'النسخ الاحتياطي',
      description: 'اللقطات والاستعادة الآمنة',
      icon: Database,
    },
    {
      id: 'cloud' as SettingsSubTab,
      label: 'المزامنة السحابية',
      description: 'السحابة والنسخ المتزامن',
      icon: Cloud,
    },
    {
      id: 'audit' as SettingsSubTab,
      label: 'سجل العمليات',
      description: 'سجل الرقابة وتتبع الحركات',
      icon: FileText,
    },
  ];

  const handleCopyCode = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {}
  };

  return (
    <div className="space-y-5" dir="rtl">
      <PageHeader
        title="إعدادات النظام والتشغيل"
        description="إدارة هوية المحل، المظهر وإمكانية الوصول، النسخ الاحتياطي، المزامنة السحابية، والرقابة"
        icon={Settings}
        badge="الإدارة الموحدة"
      />

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* Navigation Sidebar for Settings Subtabs */}
        <aside className="w-full lg:w-72 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-2.5 shadow-xs select-none">
          <div className="px-3 py-2 mb-1 border-b border-slate-100 dark:border-slate-800/80">
            <span className="text-[11px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              أقسام الإعدادات
            </span>
          </div>

          <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-x-visible pb-1 lg:pb-0 scrollbar-none" aria-label="أقسام الإعدادات">
            {subTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeSubTab === tab.id;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl text-right transition-all cursor-pointer whitespace-nowrap lg:whitespace-normal shrink-0 lg:shrink w-auto lg:w-full ${
                    isActive
                      ? 'bg-emerald-600 text-white font-black shadow-xs'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 font-bold'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs sm:text-sm truncate">{tab.label}</span>
                        {tab.badge && (
                          <span
                            className={`text-[9px] px-1.5 py-0.2 rounded font-mono font-bold ${
                              isActive
                                ? 'bg-white/25 text-white'
                                : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                            }`}
                          >
                            {tab.badge}
                          </span>
                        )}
                      </div>
                      <p
                        className={`text-[10px] truncate hidden lg:block ${
                          isActive ? 'text-white/80' : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {tab.description}
                      </p>
                    </div>
                  </div>
                  <ChevronLeft
                    className={`w-4 h-4 hidden lg:block shrink-0 ${
                      isActive ? 'text-white/80' : 'text-slate-300 dark:text-slate-600'
                    }`}
                  />
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content Viewport of Active SubTab */}
        <section className="flex-1 w-full min-w-0">
          {/* 1. Store Profile */}
          {activeSubTab === 'store-profile' && (
            <StoreProfileSettings
              currentUser={currentUser}
              onProfileUpdated={onRefreshAll}
            />
          )}

          {/* 2. Accounting Placeholder */}
          {activeSubTab === 'accounting' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xs">
              <div className="max-w-2xl mx-auto text-center py-6">
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-3xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto mb-4 shadow-xs">
                  <Calculator className="w-8 h-8 sm:w-10 sm:h-10" />
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 text-xs font-bold border border-emerald-200 dark:border-emerald-800 mb-3">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>وحدة المحاسبة العامة — قيد التطوير والتجهيز</span>
                </div>
                <h3 className="text-lg sm:text-xl font-black text-slate-900 dark:text-slate-100 mb-2">
                  دليل الحسابات وقيود اليومية الآلية
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
                  يعمل النظام حالياً بالنظام المحاسبي التشغيلي (المبيعات، المشتريات، نقدية الدرج، المصروفات، وذمم العملاء والموردين). يجري تجهيز شجرة الحسابات العامة وميزان المراجعة وقائمة الدخل التلقائية لربط العمليات محاسبياً في التحديث القادم.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-right">
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                    <div className="flex items-center gap-2 mb-1 text-slate-800 dark:text-slate-200 font-bold text-xs">
                      <Layers className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>شجرة الحسابات</span>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                      أصول، خصوم، حقوق ملكية، إيرادات ومصروفات بتسلسل محاسبي قياسي.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                    <div className="flex items-center gap-2 mb-1 text-slate-800 dark:text-slate-200 font-bold text-xs">
                      <Clock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>قيود آلية</span>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                      توليد قيود اليومية المحاسبية تلقائياً مع كل فاتورة بيع أو شراء أو سداد.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                    <div className="flex items-center gap-2 mb-1 text-slate-800 dark:text-slate-200 font-bold text-xs">
                      <FileText className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>القوائم المالية</span>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500">
                      ميزان مراجعة بالمدة، قائمة أرباح وخسائر، وموازنة عامة بنقرة زر.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 3. Appearance & Accessibility */}
          {activeSubTab === 'appearance' && (
            <ThemeAccessibilitySettings />
          )}

          {/* 4. License Management */}
          {activeSubTab === 'license' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xs space-y-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                    <KeyRound className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-slate-100">
                      ترخيص النظام وتفعيل الجهاز
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      تفاصيل الترخيص المرتبط بهذا الجهاز وحالة التفعيل الرقمي
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setIsActivationModalOpen(true)}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-xs transition cursor-pointer"
                >
                  إدخال كود ترخيص جديد
                </button>
              </div>

              {/* Status Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                  <span className="text-[11px] font-bold text-slate-400 block mb-1">حالة الترخيص:</span>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    <span className="font-black text-slate-900 dark:text-slate-100 text-sm">
                      {licenseState.status === 'valid' || licenseState.canOperate ? 'مفعّل ونشط بالكامل' : 'يحتاج تفعيل'}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    نظام التشغيل المحلي (LICENSE_ENFORCEMENT: معطل)
                  </span>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                  <span className="text-[11px] font-bold text-slate-400 block mb-1">صلاحية الترخيص:</span>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    <span className="font-black text-slate-900 dark:text-slate-100 text-sm">
                      {licenseState.daysRemaining !== null && licenseState.daysRemaining !== undefined
                        ? `${licenseState.daysRemaining} يوماً متبقية`
                        : 'ترخيص تشغيلي دائم'}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    {licenseState.payload?.validUntil ? `ينتهي في: ${new Date(licenseState.payload.validUntil).toLocaleDateString('ar-EG')}` : 'غير محدد بتاريخ انتهاء'}
                  </span>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                  <span className="text-[11px] font-bold text-slate-400 block mb-1">معرّف الجهاز (Device ID):</span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-xs text-slate-900 dark:text-slate-100 truncate">
                      {licenseService.getDeviceId()}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyCode(licenseService.getDeviceId())}
                      className="p-1 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 cursor-pointer"
                      title="نسخ معرّف الجهاز"
                    >
                      {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 block">بصمة مشفرة للجهاز الحالي</span>
                </div>
              </div>

              {/* Request Code Box */}
              <div className="bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                  كود طلب الترخيص (أرسله للدعم الفني للحصول على كود التفعيل):
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={licenseService.getRequestCode()}
                    className="flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-mono select-all text-slate-800 dark:text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopyCode(licenseService.getRequestCode())}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 text-xs font-bold transition cursor-pointer"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedCode ? 'تم النسخ' : 'نسخ الكود'}</span>
                  </button>
                </div>
              </div>

              {isActivationModalOpen && (
                <LicenseActivationModal
                  isOpen={isActivationModalOpen}
                  onClose={() => setIsActivationModalOpen(false)}
                  onSuccess={() => {
                    setIsActivationModalOpen(false);
                    setLicenseState(licenseService.getLicenseState());
                    onRefreshAll();
                  }}
                />
              )}
            </div>
          )}

          {/* 5. Backup Manager */}
          {activeSubTab === 'backup' && (
            <BackupManager onRefreshData={onRefreshAll} />
          )}

          {/* 6. Cloud & Sync */}
          {activeSubTab === 'cloud' && (
            <CloudDashboard
              currentUser={currentUser}
              onRefreshAll={onRefreshAll}
              onNavigateTab={(tab) => {
                if (onNavigateTab) {
                  onNavigateTab(tab as TabType);
                }
              }}
            />
          )}

          {/* 7. Audit Trail */}
          {activeSubTab === 'audit' && (
            <AuditTrail />
          )}
        </section>
      </div>
    </div>
  );
};
