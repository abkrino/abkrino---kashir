import React, { useState } from 'react';
import {
  AccountingMode,
  FundingSource,
  FundingSourceType,
  User,
} from '../../types';
import { storage } from '../../services/storageService';
import {
  Calculator,
  CheckCircle2,
  Lock,
  AlertTriangle,
  Plus,
  Power,
  ShieldCheck,
  Wallet,
  CalendarRange,
  Landmark,
  X,
} from 'lucide-react';

interface AccountingSettingsProps {
  currentUser: User;
  onUpdated: () => void;
}

const ACCOUNTING_MODE_CARDS: {
  mode: AccountingMode;
  title: string;
  subtitle: string;
  description: string;
  example: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    mode: 'DAILY_DRAWER',
    title: 'الدرج اليومي الفعلي (الافتراضي)',
    subtitle: 'فحص لحظي لرصيد الدرج',
    description: 'المتاح للصرف = رصيد الدرج النقدي الفعلي لحظة العملية.',
    example:
      'مثال: إذا كان في الدرج 1,500 ج.م، يُصرف حتى 1,500 ج.م مباشرة، وأي مبلغ أكبر يتطلب إذن المدير وتحديد مصدر التمويل.',
    icon: Wallet,
  },
  {
    mode: 'MONTHLY_POOL',
    title: 'الوعاء الشهري التراكمي',
    subtitle: 'فحص تراكمي منذ أول الشهر',
    description:
      'المتاح للصرف = صافي النقدية الداخلة للدرج منذ أول الشهر الحالي (مبيعات نقدية وتحصيلات وإيداعات ناقص مدفوعات ومصروفات)، لا رصيد اللحظة.',
    example:
      'مثال: مبيعات الشهر المحصلة 60,000 ج.م ومصروفاته 20,000 ج.م (المتاح = 40,000 ج.م) حتى لو تم توريد كاش اليوم للبنك.',
    icon: CalendarRange,
  },
  {
    mode: 'CAPITAL',
    title: 'التمويل من رأس المال',
    subtitle: 'مفصول عن درج الكاشير',
    description:
      'لا فحص تغطية على الدرج؛ تُسجّل المشتريات والمصروفات كمدفوعة من رأس المال دون الخصم من الدرج، وإيداعات المالك تُسجّل كحركة رأس مال منفصلة غير إيرادية.',
    example:
      'مثال: سداد فاتورة شراء بـ 25,000 ج.م أو إيجار لا يخصم من درج الكاشير، وضخ 50,000 ج.م من المالك لا يدخل في الأرباح.',
    icon: Landmark,
  },
];

const FUNDING_TYPE_LABELS: { value: FundingSourceType; label: string }[] = [
  { value: 'OWNER_LOAN', label: 'سلفة / تمويل شخصي' },
  { value: 'CUSTODY', label: 'عهدة نقدية خارجية' },
  { value: 'EXTERNAL_FUNDING', label: 'تمويل خارجي مستقل' },
  { value: 'DRAWER_NEGATIVE', label: 'سحب بالسالب من الدرج' },
  { value: 'OTHER', label: 'أخرى — يتطلب كتابة مصدر نصي' },
];

export const AccountingSettings: React.FC<AccountingSettingsProps> = ({
  currentUser,
  onUpdated,
}) => {
  const [activeMode, setActiveMode] = useState<AccountingMode>(
    storage.getAccountingMode()
  );
  const [monthlyPoolCapInj, setMonthlyPoolCapInj] = useState<boolean>(
    storage.getMonthlyPoolIncludesCapitalInjection()
  );
  const [fundingSources, setFundingSources] = useState<FundingSource[]>(
    storage.getFundingSources()
  );
  const currentShift = storage.getCurrentShift();
  const isShiftOpen = Boolean(currentShift && currentShift.status === 'OPEN');
  const isAdmin = currentUser.role === 'ADMIN';

  // Switch Mode Password Verification Modal
  const [pendingMode, setPendingMode] = useState<AccountingMode | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchSuccess, setSwitchSuccess] = useState<string | null>(null);
  const [isSubmittingSwitch, setIsSubmittingSwitch] = useState(false);

  // Toggle monthlyPoolIncludesCapitalInjection Modal State
  const [pendingCapInjSetting, setPendingCapInjSetting] = useState<boolean | null>(null);
  const [capInjPassword, setCapInjPassword] = useState('');
  const [capInjError, setCapInjError] = useState<string | null>(null);
  const [capInjSuccess, setCapInjSuccess] = useState<string | null>(null);
  const [isSubmittingCapInj, setIsSubmittingCapInj] = useState(false);

  // Add Funding Source Form
  const [newSourceType, setNewSourceType] =
    useState<FundingSourceType>('EXTERNAL_FUNDING');
  const [newSourceLabel, setNewSourceLabel] = useState('');
  const [newSourceNote, setNewSourceNote] = useState('');
  const [sourceMsg, setSourceMsg] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const handleSelectModeCard = (mode: AccountingMode) => {
    setSwitchError(null);
    setSwitchSuccess(null);
    if (mode === activeMode) return;
    if (!isAdmin) {
      setSwitchError('غير مصرح: تبديل نظام المحاسبة مقتصر على المدير العام فقط.');
      return;
    }
    if (isShiftOpen) {
      setSwitchError(
        'لا يمكن تبديل نظام المحاسبة أثناء وجود وردية مفتوحة. يجب إغلاق الوردية الحالية أولاً من شاشة الخزينة والدرج.'
      );
      return;
    }
    setAdminPassword('');
    setPendingMode(mode);
  };

  const handleConfirmModeSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingMode) return;
    setSwitchError(null);
    setIsSubmittingSwitch(true);

    try {
      const res = await storage.setAccountingMode(
        pendingMode,
        currentUser,
        adminPassword
      );
      if (!res.success) {
        setSwitchError(res.error || 'تعذر تبديل النظام المحاسبي');
        return;
      }

      await storage.flush();
      setActiveMode(storage.getAccountingMode());
      setPendingMode(null);
      setAdminPassword('');
      setSwitchSuccess(
        'تم تبديل النظام المحاسبي بنجاح وتسجيله في سجل المراجعة. يسري من الآن على العمليات الجديدة فقط دون المساس بالحركات السابقة.'
      );
      onUpdated();
    } finally {
      setIsSubmittingSwitch(false);
    }
  };

  const handleAddFundingSource = async (e: React.FormEvent) => {
    e.preventDefault();
    setSourceMsg(null);
    const res = storage.addFundingSource(currentUser, {
      type: newSourceType,
      label: newSourceLabel,
      note: newSourceNote,
    });
    if (!res.success) {
      setSourceMsg({ type: 'error', text: res.error || 'تعذر إضافة المصدر' });
      return;
    }
    try {
      await storage.flush();
    } catch {}
    setFundingSources(storage.getFundingSources());
    setNewSourceLabel('');
    setNewSourceNote('');
    setSourceMsg({ type: 'success', text: 'تمت إضافة مصدر التمويل بنجاح' });
    onUpdated();
  };

  const handleRequestToggleCapInj = () => {
    setCapInjError(null);
    setCapInjSuccess(null);
    if (!isAdmin) {
      setCapInjError('غير مصرح: تعديل هذا الإعداد مقتصر على المدير العام فقط.');
      return;
    }
    setCapInjPassword('');
    setPendingCapInjSetting(!monthlyPoolCapInj);
  };

  const handleConfirmToggleCapInj = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingCapInjSetting === null) return;
    setCapInjError(null);
    setIsSubmittingCapInj(true);
    try {
      const res = await storage.setMonthlyPoolIncludesCapitalInjection(
        pendingCapInjSetting,
        currentUser,
        capInjPassword
      );
      if (!res.success) {
        setCapInjError(res.error || 'تعذر تحديث الإعداد');
        return;
      }
      await storage.flush();
      const updated = storage.getMonthlyPoolIncludesCapitalInjection();
      setMonthlyPoolCapInj(updated);
      setPendingCapInjSetting(null);
      setCapInjPassword('');
      setCapInjSuccess(
        updated
          ? 'تم تفعيل احتساب إيداعات رأس المال المودعة بالدرج ضمن رصيد الشهر وتسجيله في سجل المراجعة. يسري على العمليات الجديدة فقط.'
          : 'تم إيقاف احتساب إيداعات رأس المال ضمن رصيد الشهر وتسجيله في سجل المراجعة. يسري على العمليات الجديدة فقط.'
      );
      onUpdated();
    } finally {
      setIsSubmittingCapInj(false);
    }
  };

  const handleToggleFundingSource = async (sourceId: string) => {
    setSourceMsg(null);
    const res = storage.toggleFundingSource(currentUser, sourceId);
    if (!res.success) {
      setSourceMsg({ type: 'error', text: res.error || 'تعذر تعديل حالة المصدر' });
      return;
    }
    try {
      await storage.flush();
    } catch {}
    setFundingSources(storage.getFundingSources());
    onUpdated();
  };

  return (
    <div className="space-y-6" dir="rtl">
      {/* 1. Accounting Mode Selection */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
              <Calculator className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-slate-100">
                النظام المحاسبي وفحص تغطية الصرف
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                اختر آلية احتساب السيولة المتاحة للمشتريات والمصروفات وسندات الصرف. يسري التبديل مستقبلاً فقط دون تعديل السجلات السابقة.
              </p>
            </div>
          </div>

          <div
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border ${
              isShiftOpen
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
            }`}
          >
            {isShiftOpen ? (
              <>
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>الوردية مفتوحة — أغلقها أولاً للتبديل</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>الوردية مغلقة — جاهز للتبديل</span>
              </>
            )}
          </div>
        </div>

        {switchError && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/70 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{switchError}</span>
          </div>
        )}

        {switchSuccess && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs font-bold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{switchSuccess}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ACCOUNTING_MODE_CARDS.map((card) => {
            const Icon = card.icon;
            const isSelected = activeMode === card.mode;
            return (
              <div
                key={card.mode}
                className={`rounded-2xl border p-4 flex flex-col justify-between transition-all ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30 ring-1 ring-emerald-500/40'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="font-black text-xs text-slate-900 dark:text-white">
                          {card.title}
                        </h4>
                        <span className="font-mono text-[10px] text-slate-400">
                          {card.subtitle}
                        </span>
                      </div>
                    </div>

                    {isSelected && (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-black shrink-0">
                        مفعّل
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                    {card.description}
                  </p>

                  <div className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {card.example}
                  </div>
                </div>

                <div className="pt-4 mt-3 border-t border-slate-200/70 dark:border-slate-800/70">
                  <button
                    type="button"
                    disabled={isSelected}
                    onClick={() => handleSelectModeCard(card.mode)}
                    className={`w-full py-2 rounded-xl text-xs font-black transition-colors flex items-center justify-center gap-1.5 ${
                      isSelected
                        ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 cursor-default'
                        : 'bg-slate-900 hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 text-white cursor-pointer'
                    }`}
                  >
                    {isSelected ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>النظام النشط حالياً</span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-3.5 h-3.5" />
                        <span>التحويل إلى هذا النظام</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 1b. Optional Setting for MONTHLY_POOL: monthlyPoolIncludesCapitalInjection */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1.5 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm sm:text-base font-black text-slate-900 dark:text-slate-100">
                احتساب إيداعات رأس المال في رصيد الوعاء الشهري
              </h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                خاص بوضع الوعاء الشهري التراكمي
              </span>
              {activeMode !== 'MONTHLY_POOL' && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  الوضع الحالي ليس الوعاء الشهري
                </span>
              )}
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              عند التفعيل: النقدية التي يضخّها المالك في الدرج تُحسب ضمن المتاح لتغطية المشتريات والمصروفات هذا الشهر. عند الإيقاف: تُستبعد ويُسأل عن مصدر التمويل.
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              مثال: إذا كانت مبيعات الشهر 5,000 ج.م وضخّ المالك 10,000 ج.م في الدرج، فعند الإيقاف المتاح الشهري 5,000 ج.م فقط، وعند التفعيل يصبح المتاح 15,000 ج.م (وتظل إيداعات رأس المال منفصلة ولا تدخل الأرباح أو المبيعات في أي حال).
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span
              className={`text-xs font-black px-2.5 py-1 rounded-lg border ${
                monthlyPoolCapInj
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700'
              }`}
            >
              {monthlyPoolCapInj ? 'مفعّل' : 'معطل (الافتراضي)'}
            </span>
            <button
              type="button"
              onClick={handleRequestToggleCapInj}
              className={`px-4 py-2 rounded-xl text-xs font-black cursor-pointer transition-colors flex items-center gap-1.5 ${
                monthlyPoolCapInj
                  ? 'bg-amber-600 hover:bg-amber-500 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>{monthlyPoolCapInj ? 'إيقاف الاحتساب' : 'تفعيل الاحتساب'}</span>
            </button>
          </div>
        </div>

        {capInjError && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/70 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{capInjError}</span>
          </div>
        )}

        {capInjSuccess && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs font-bold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{capInjSuccess}</span>
          </div>
        )}
      </div>

      {/* 2. Structured Funding Sources Management */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-5">
        <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-base font-black text-slate-900 dark:text-slate-100">
            قائمة مصادر التمويل المنظّمة
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            تظهر هذه المصادر عند تجاوز الصرف للرصيد المتاح لتوثيق مصدر السداد في الخزينة والتقارير. يمكن للمدير إضافة مصادر أو إيقافها.
          </p>
        </div>

        {sourceMsg && (
          <div
            className={`p-3 rounded-xl text-xs font-bold border ${
              sourceMsg.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
            }`}
          >
            {sourceMsg.text}
          </div>
        )}

        <div className="space-y-2">
          {fundingSources.map((src) => (
            <div
              key={src.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 text-xs"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 dark:text-white">
                    {src.label}
                  </span>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    {src.type}
                  </span>
                  {!src.isActive && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-bold">
                      موقوف
                    </span>
                  )}
                </div>
                {src.note && (
                  <p className="text-[11px] text-slate-500 mt-0.5">{src.note}</p>
                )}
              </div>

              {isAdmin && src.id !== 'fs-drawer' && (
                <button
                  type="button"
                  onClick={() => handleToggleFundingSource(src.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors ${
                    src.isActive
                      ? 'bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                      : 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  }`}
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>{src.isActive ? 'إيقاف' : 'تفعيل'}</span>
                </button>
              )}
            </div>
          ))}
        </div>

        {isAdmin && (
          <form
            onSubmit={handleAddFundingSource}
            className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 space-y-3 text-xs"
          >
            <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Plus className="w-4 h-4 text-emerald-600" />
              <span>إضافة مصدر تمويل جديد</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                  التصنيف القياسي:
                </label>
                <select
                  value={newSourceType}
                  onChange={(e) =>
                    setNewSourceType(e.target.value as FundingSourceType)
                  }
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 font-bold text-slate-900 dark:text-white"
                >
                  {FUNDING_TYPE_LABELS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                  اسم المصدر الظاهر:
                </label>
                <input
                  type="text"
                  required
                  value={newSourceLabel}
                  onChange={(e) => setNewSourceLabel(e.target.value)}
                  placeholder="مثال: حساب فودافون كاش الإدارة"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                  ملاحظة افتراضية (اختياري):
                </label>
                <input
                  type="text"
                  value={newSourceNote}
                  onChange={(e) => setNewSourceNote(e.target.value)}
                  placeholder="تفاصيل إضافية..."
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs cursor-pointer flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>إضافة للقائمة</span>
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Password Re-verification Modal for Switching Accounting Mode */}
      {pendingMode && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white">
                <Lock className="w-4 h-4 text-emerald-600" />
                <h4 className="font-black text-sm">
                  تأكيد كلمة مرور المدير لتبديل النظام المحاسبي
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setPendingMode(null)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmModeSwitch} className="mt-4 space-y-3.5 text-xs">
              <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                أنت على وشك تحويل نظام المحاسبة إلى:{' '}
                <strong className="text-emerald-700 dark:text-emerald-400">
                  {ACCOUNTING_MODE_CARDS.find((c) => c.mode === pendingMode)?.title}
                </strong>
                . يسري التغيير من الآن فصاعداً دون تعديل الحركات السابقة.
              </p>

              {switchError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold">
                  {switchError}
                </div>
              )}

              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  أعد إدخال كلمة مرور / الرقم السري للمدير ({currentUser.fullName}):
                </label>
                <input
                  type="password"
                  required
                  autoFocus
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="أدخل كلمة المرور..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl p-2.5 text-slate-900 dark:text-white font-mono"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setPendingMode(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingSwitch}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold cursor-pointer"
                >
                  {isSubmittingSwitch ? 'جاري التحقق...' : 'اعتماد وتبديل النظام'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Password Re-verification Modal for monthlyPoolIncludesCapitalInjection */}
      {pendingCapInjSetting !== null && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white">
                <Lock className="w-4 h-4 text-emerald-600" />
                <h4 className="font-black text-sm">
                  تأكيد كلمة مرور المدير لتعديل إعداد الوعاء الشهري
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setPendingCapInjSetting(null)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmToggleCapInj} className="mt-4 space-y-3.5 text-xs">
              <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                أنت على وشك{' '}
                <strong className="text-emerald-700 dark:text-emerald-400">
                  {pendingCapInjSetting
                    ? 'تفعيل احتساب إيداعات رأس المال بالدرج ضمن رصيد الشهر'
                    : 'إيقاف احتساب إيداعات رأس المال ضمن رصيد الشهر'}
                </strong>
                . يسري التعديل على العمليات الجديدة فقط ولا يعدّل أو يحذف الحركات السابقة.
              </p>

              {capInjError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold">
                  {capInjError}
                </div>
              )}

              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  أعد إدخال كلمة مرور / الرقم السري للمدير ({currentUser.fullName}):
                </label>
                <input
                  type="password"
                  required
                  autoFocus
                  value={capInjPassword}
                  onChange={(e) => setCapInjPassword(e.target.value)}
                  placeholder="أدخل كلمة المرور..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl p-2.5 text-slate-900 dark:text-white font-mono"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setPendingCapInjSetting(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingCapInj}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold cursor-pointer"
                >
                  {isSubmittingCapInj ? 'جاري التحقق...' : 'اعتماد التغيير'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
