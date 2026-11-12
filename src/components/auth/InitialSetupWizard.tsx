import React, { useState } from 'react';
import { User, StoreProfile, DEFAULT_STORE_PROFILE } from '../../types';
import { storage } from '../../services/storageService';
import { authSecurityService, isKnownDefaultPin } from '../../services/authSecurityService';
import { 
  Store, 
  ShieldCheck, 
  CheckCircle2, 
  Lock, 
  UserCheck, 
  Phone, 
  KeyRound, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  Sparkles,
  MapPin,
  Upload,
  Coins,
  Receipt,
  Scale,
  Truck,
  ArrowRight,
  ArrowLeft,
  Boxes,
  HelpCircle
} from 'lucide-react';

interface InitialSetupWizardProps {
  onComplete: (admin: User) => void;
}

export const InitialSetupWizard: React.FC<InitialSetupWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1: Store Profile
  const [profile, setProfile] = useState<StoreProfile>(() => ({
    ...DEFAULT_STORE_PROFILE,
    name: '',
    phone: '',
    address: '',
    modules: {
      dairy: false,
      weighingScale: false,
      delivery: false,
    },
  }));

  // Step 2: Admin Account
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('admin');
  const [adminPhone, setAdminPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Step 3: Completion & Demo Data
  const [loadDemoData, setLoadDemoData] = useState(false);
  const [demoConfirmed, setDemoConfirmed] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Logo Handler
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('يرجى اختيار ملف صورة صالح (PNG, JPEG, WebP, SVG).');
      return;
    }

    if (file.size > 100 * 1024) {
      setError('حجم اللوجو كبير جداً (' + Math.round(file.size / 1024) + ' ك.ب). الحد الأقصى 100 كيلوبايت.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setProfile(prev => ({ ...prev, logo: result }));
    };
    reader.readAsDataURL(file);
  };

  const handleNextFromStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!profile.name.trim()) {
      setError('يرجى كتابة اسم المحل التجاري للمتابعة');
      return;
    }
    if (!profile.phone.trim()) {
      setError('يرجى كتابة رقم هاتف المحل للعملاء');
      return;
    }
    if (!profile.address.trim()) {
      setError('يرجى كتابة عنوان المحل');
      return;
    }
    setStep(2);
  };

  const handleNextFromStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanName = fullName.trim();
    const cleanUsername = username.toLowerCase().trim();
    const cleanPassword = password.trim();
    const cleanConfirm = confirmPassword.trim();

    if (!cleanName) {
      setError('يرجى كتابة الاسم بالكامل للمدير المسؤول');
      return;
    }
    if (!cleanUsername) {
      setError('يرجى كتابة اسم المستخدم للدخول');
      return;
    }
    if (cleanPassword.length < 6) {
      setError('كلمة مرور المدير يجب ألا تقل عن 6 خانات');
      return;
    }
    if (cleanPassword !== cleanConfirm) {
      setError('كلمة المرور وتأكيدها غير متطابقين');
      return;
    }
    if (isKnownDefaultPin(cleanPassword)) {
      setError('لا يمكن استخدام كلمة مرور افتراضية شائعة (مثل 123456 أو 1234). اختر كلمة مرور قوية.');
      return;
    }

    setStep(3);
  };

  const handleFinalSubmit = async () => {
    setError(null);
    setIsLoading(true);

    try {
      // 1. Save Store Profile
      const saveRes = storage.saveStoreProfile(profile);
      if (!saveRes.success) {
        throw new Error(saveRes.error || 'فشل حفظ بيانات المحل');
      }

      // 2. Setup Initial Admin
      const admin = await authSecurityService.setupInitialAdmin({
        fullName: fullName.trim(),
        username: username.toLowerCase().trim(),
        password: password.trim(),
        phone: adminPhone.trim() || profile.phone.trim(),
      });

      // 3. Optional Demo Data
      if (loadDemoData && demoConfirmed) {
        storage.loadDemoData();
      }

      await storage.flush();

      if (storage.getWriteError()) {
        setError(`تعذر تأكيد حفظ البيانات في التخزين الدائم: ${storage.getWriteError()}`);
        setIsLoading(false);
        return;
      }

      onComplete(admin);
    } catch (err: any) {
      setError(err?.message || 'حدث خطأ أثناء إتمام الإعداد');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-4 z-50 overflow-y-auto select-none" dir="rtl">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-2xl w-full shadow-2xl p-6 md:p-8 text-right my-8 text-white">
        
        {/* Step Indicator Header */}
        <div className="pb-6 border-b border-slate-800">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-bold text-emerald-400">معالج الإعداد والتشغيل الأولي</span>
            <span className="text-xs font-mono text-slate-400">الخطوة {step} من 3</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className={`h-2 rounded-full transition-all ${step >= 1 ? 'bg-emerald-500' : 'bg-slate-800'}`}></div>
            <div className={`h-2 rounded-full transition-all ${step >= 2 ? 'bg-emerald-500' : 'bg-slate-800'}`}></div>
            <div className={`h-2 rounded-full transition-all ${step >= 3 ? 'bg-emerald-500' : 'bg-slate-800'}`}></div>
          </div>

          <div className="flex justify-between text-[11px] font-bold text-slate-400 mt-2">
            <span className={step === 1 ? 'text-white' : ''}>1. بيانات ونشاط المحل</span>
            <span className={step === 2 ? 'text-white' : ''}>2. حساب المدير المسؤول</span>
            <span className={step === 3 ? 'text-white' : ''}>3. إتمام التثبيت</span>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mt-4 bg-rose-950/80 border border-rose-600/70 p-3.5 rounded-xl flex items-center gap-2 text-rose-200 text-xs md:text-sm font-bold animate-shake">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* STEP 1: STORE PROFILE */}
        {step === 1 && (
          <form onSubmit={handleNextFromStep1} className="mt-6 space-y-4">
            <div className="text-center pb-2">
              <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto mb-2 text-emerald-400">
                <Store className="w-7 h-7" />
              </div>
              <h2 className="text-lg md:text-xl font-black text-white">بيانات ونشاط المحل التجاري</h2>
              <p className="text-xs text-slate-400 mt-1">
                حدد هوية محلك لتظهر على بونات الكاشير والفواتير والتقارير.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-xs">
              <div>
                <label className="block font-bold text-slate-300 mb-1">اسم المحل *</label>
                <input
                  type="text"
                  required
                  value={profile.name}
                  onChange={e => setProfile({ ...profile, name: e.target.value })}
                  placeholder="مثال: سوبر ماركت النور"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">اسم الفرع (اختياري)</label>
                <input
                  type="text"
                  value={profile.branchName || ''}
                  onChange={e => setProfile({ ...profile, branchName: e.target.value })}
                  placeholder="مثال: الفرع الرئيسي"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">رقم هاتف المحل *</label>
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={profile.phone}
                  onChange={e => setProfile({ ...profile, phone: e.target.value })}
                  placeholder="01xxxxxxxxx"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">عنوان المحل *</label>
                <input
                  type="text"
                  required
                  value={profile.address}
                  onChange={e => setProfile({ ...profile, address: e.target.value })}
                  placeholder="الشارع، المنطقة"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Modules Checkboxes */}
            <div className="pt-2">
              <label className="block font-bold text-slate-300 mb-2 text-xs">أقسام وموديولات العمل المتاحة بمحلك:</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <label className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
                  profile.modules.dairy ? 'bg-blue-950/60 border-blue-500 text-blue-200' : 'bg-slate-800/60 border-slate-700 text-slate-400'
                }`}>
                  <div className="flex items-center gap-2">
                    <span>🧀</span>
                    <span className="font-bold">قسم الألبان والجبن</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={profile.modules.dairy}
                    onChange={e => setProfile({ ...profile, modules: { ...profile.modules, dairy: e.target.checked } })}
                    className="w-4 h-4 rounded text-blue-500 cursor-pointer"
                  />
                </label>

                <label className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
                  profile.modules.weighingScale ? 'bg-indigo-950/60 border-indigo-500 text-indigo-200' : 'bg-slate-800/60 border-slate-700 text-slate-400'
                }`}>
                  <div className="flex items-center gap-2">
                    <span>⚖️</span>
                    <span className="font-bold">الميزان والباركود الوزني</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={profile.modules.weighingScale}
                    onChange={e => setProfile({ ...profile, modules: { ...profile.modules, weighingScale: e.target.checked } })}
                    className="w-4 h-4 rounded text-indigo-500 cursor-pointer"
                  />
                </label>

                <label className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
                  profile.modules.delivery ? 'bg-amber-950/60 border-amber-500 text-amber-200' : 'bg-slate-800/60 border-slate-700 text-slate-400'
                }`}>
                  <div className="flex items-center gap-2">
                    <span>🛵</span>
                    <span className="font-bold">خدمة الدليفري</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={profile.modules.delivery}
                    onChange={e => setProfile({ ...profile, modules: { ...profile.modules, delivery: e.target.checked } })}
                    className="w-4 h-4 rounded text-amber-500 cursor-pointer"
                  />
                </label>
              </div>
            </div>

            <div className="pt-4 flex justify-end">
              <button
                type="submit"
                className="btn-primary-accessible bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm px-6 py-2.5 rounded-xl flex items-center gap-2 cursor-pointer"
              >
                <span>متابعة لإعداد حساب المدير</span>
                <ArrowLeft className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}

        {/* STEP 2: ADMIN SETUP */}
        {step === 2 && (
          <form onSubmit={handleNextFromStep2} className="mt-6 space-y-4">
            <div className="text-center pb-2">
              <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto mb-2 text-emerald-400">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <h2 className="text-lg md:text-xl font-black text-white">إعداد حساب المدير العام المسؤول</h2>
              <p className="text-xs text-slate-400 mt-1">
                بيانات الدخول الإدارية لتأمين الخزينة وحسابات الكاشيرية.
              </p>
            </div>

            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block font-bold text-slate-300 mb-1">الاسم بالكامل للمدير *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="مثال: محمود منصور"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">اسم المستخدم للدخول *</label>
                  <input
                    type="text"
                    required
                    dir="ltr"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">رقم هاتف المدير (اختياري)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={adminPhone}
                    onChange={e => setAdminPhone(e.target.value)}
                    placeholder="01xxxxxxxxx"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">كلمة المرور (6 خانات فأكثر) *</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      dir="ltr"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute left-2.5 top-2.5 text-slate-400 hover:text-white"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">تأكيد كلمة المرور *</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    dir="ltr"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowRight className="w-4 h-4" />
                <span>العودة لبيانات المحل</span>
              </button>

              <button
                type="submit"
                className="btn-primary-accessible bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm px-6 py-2.5 rounded-xl flex items-center gap-2 cursor-pointer"
              >
                <span>متابعة للخطوة النهائية</span>
                <ArrowLeft className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}

        {/* STEP 3: COMPLETION & DEMO DATA OPTION */}
        {step === 3 && (
          <div className="mt-6 space-y-5">
            <div className="text-center pb-2">
              <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto mb-2 text-emerald-400">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-lg md:text-xl font-black text-white">إتمام الإعداد والجاهزية للعمل</h2>
              <p className="text-xs text-slate-400 mt-1">
                أنت على وشك الانتهاء وبدء العمل على النظام.
              </p>
            </div>

            {/* Summary card */}
            <div className="bg-slate-800/80 border border-slate-700 rounded-2xl p-4 text-xs space-y-2">
              <div className="flex justify-between border-b border-slate-700/60 pb-2">
                <span className="text-slate-400">اسم المحل:</span>
                <span className="font-black text-white">{profile.name} {profile.branchName ? `(${profile.branchName})` : ''}</span>
              </div>
              <div className="flex justify-between border-b border-slate-700/60 pb-2">
                <span className="text-slate-400">المدير العام:</span>
                <span className="font-bold text-emerald-400">{fullName} ({username})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">الأقسام المفعلة:</span>
                <span className="font-bold text-slate-200">
                  {[
                    profile.modules.dairy && 'الألبان',
                    profile.modules.weighingScale && 'الميزان',
                    profile.modules.delivery && 'الدليفري'
                  ].filter(Boolean).join(' • ') || 'نشاط تجاري قياسي'}
                </span>
              </div>
            </div>

            {/* Demo Data Option (Requirement 4: off by default, requires clear confirmation) */}
            <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={loadDemoData}
                  onChange={e => {
                    setLoadDemoData(e.target.checked);
                    if (!e.target.checked) setDemoConfirmed(false);
                  }}
                  className="w-5 h-5 mt-0.5 rounded text-amber-500 cursor-pointer"
                />
                <div>
                  <div className="font-black text-sm text-slate-200 flex items-center gap-2">
                    <Boxes className="w-4 h-4 text-amber-400" />
                    <span>تحميل بيانات تجريبية (أصناف، عملاء، موردين)</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    النظام يبدأ فارغاً تماماً للعمل الفعلي. إذا كنت ترغب في تجربة الشاشات والتقارير أولاً يمكنك تفعيل هذا الخيار.
                  </p>
                </div>
              </label>

              {loadDemoData && (
                <div className="bg-amber-950/70 border border-amber-600/60 p-3 rounded-xl space-y-2 mt-2">
                  <div className="text-xs text-amber-200 font-bold">
                    ⚠️ تأكيد استيراد البيانات التجريبية:
                  </div>
                  <p className="text-[11px] text-amber-300 leading-normal">
                    سيتم إدراج منتجات وعملاء وموردين وهميين في قاعدة البيانات للتجربة. يمكنك تعديلها أو حذفها لاحقاً من الشاشات.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer pt-1 text-xs text-white font-bold">
                    <input
                      type="checkbox"
                      checked={demoConfirmed}
                      onChange={e => setDemoConfirmed(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 cursor-pointer"
                    />
                    <span>أؤكد رغبتي في تحميل البيانات التجريبية للتعلم</span>
                  </label>
                </div>
              )}
            </div>

            <div className="pt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowRight className="w-4 h-4" />
                <span>العودة لحساب المدير</span>
              </button>

              <button
                type="button"
                onClick={handleFinalSubmit}
                disabled={isLoading || (loadDemoData && !demoConfirmed)}
                className="btn-primary-accessible bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm px-7 py-3 rounded-xl flex items-center gap-2 cursor-pointer shadow-lg shadow-emerald-900/40 disabled:opacity-50"
              >
                <span>{isLoading ? 'جاري تهيئة النظام...' : 'إنهاء الإعداد وبدء الاستخدام'}</span>
                <CheckCircle2 className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
