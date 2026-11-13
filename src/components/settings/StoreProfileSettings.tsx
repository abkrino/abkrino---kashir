import React, { useState, useEffect } from 'react';
import { StoreProfile, User } from '../../types';
import { storage } from '../../services/storageService';
import { 
  Store, 
  MapPin, 
  Phone, 
  FileText, 
  Scale, 
  Truck, 
  Save, 
  Upload, 
  Trash2, 
  AlertCircle, 
  CheckCircle2, 
  Coins, 
  Receipt,
  Sparkles
} from 'lucide-react';

interface StoreProfileSettingsProps {
  currentUser: User;
  onProfileUpdated?: (profile: StoreProfile) => void;
}

export const StoreProfileSettings: React.FC<StoreProfileSettingsProps> = ({
  currentUser,
  onProfileUpdated,
}) => {
  const [profile, setProfile] = useState<StoreProfile>(() => storage.getStoreProfile());
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setProfile(storage.getStoreProfile());
  }, []);

  if (currentUser.role !== 'ADMIN') {
    return (
      <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 p-6 rounded-2xl text-center" dir="rtl">
        <AlertCircle className="w-12 h-12 text-rose-600 dark:text-rose-400 mx-auto mb-2" />
        <h3 className="text-lg font-black text-rose-800 dark:text-rose-300">غير مصرح بالدخول</h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">تعديل بيانات المحل والموديولات مقتصر على المدير العام المسؤول فقط.</p>
      </div>
    );
  }

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('يرجى اختيار ملف صورة صالح (PNG, JPEG, WebP, SVG).');
      return;
    }

    if (file.size > 100 * 1024) {
      setError('حجم اللوجو كبير جداً (' + Math.round(file.size / 1024) + ' ك.ب). الحد الأقصى المسموح به هو 100 كيلوبايت لضمان سرعة الطباعة والنسخ الاحتياطي.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setProfile(prev => ({ ...prev, logo: result }));
    };
    reader.onerror = () => {
      setError('فشل في قراءة ملف الصورة. حاول مرة أخرى.');
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setProfile(prev => ({ ...prev, logo: undefined }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!profile.name.trim()) {
      setError('يرجى إدخال اسم المحل التجاري.');
      return;
    }
    if (!profile.phone.trim()) {
      setError('يرجى إدخال رقم هاتف المحل للعملاء والدليفري.');
      return;
    }
    if (!profile.address.trim()) {
      setError('يرجى إدخال عنوان المحل.');
      return;
    }

    setIsSaving(true);
    try {
      const res = storage.saveStoreProfile(profile);
      if (!res.success) {
        setError(res.error || 'تعذر حفظ بيانات المحل');
        setIsSaving(false);
        return;
      }
      await storage.flush();
      setSuccessMsg('تم حفظ وتحديث بيانات المحل بنجاح وتطبيقها في جميع الشاشات والفواتير.');
      if (onProfileUpdated) {
        onProfileUpdated(profile);
      }
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: any) {
      setError(err?.message || 'حدث خطأ غير متوقع أثناء الحفظ');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12 select-none" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-6 rounded-2xl shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-950/80 border border-emerald-300 dark:border-emerald-700 rounded-xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
            <Store className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white flex items-center gap-2">
              <span>بيانات المحل وهوية النشاط التجاري</span>
              <span className="text-[10px] bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 px-2.5 py-0.5 rounded-full font-bold">
                إعدادات المدير
              </span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              خصص اسم محلك، بيانات الاتصال، اللوجو، وتفعيل الأقسام المناسبة لنشاطك (ألبان، ميزان، دليفري).
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="btn-primary-accessible bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm px-5 py-2.5 rounded-xl shadow-md cursor-pointer flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          <span>{isSaving ? 'جاري الحفظ...' : 'حفظ التعديلات'}</span>
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-rose-50 dark:bg-rose-950/50 border border-rose-300 dark:border-rose-800 p-4 rounded-xl flex items-center gap-2 text-rose-800 dark:text-rose-300 text-xs md:text-sm font-bold">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-800 p-4 rounded-xl flex items-center gap-2 text-emerald-800 dark:text-emerald-300 text-xs md:text-sm font-bold">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Form (2 cols) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Store Info */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-5 rounded-2xl shadow-sm space-y-4">
            <h3 className="font-black text-base text-slate-900 dark:text-white pb-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <Store className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              <span>البيانات الأساسية للمحل</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5">
                  اسم المحل التجاري *
                </label>
                <input
                  type="text"
                  required
                  value={profile.name}
                  onChange={e => setProfile({ ...profile, name: e.target.value })}
                  placeholder="مثال: سوبر ماركت النور"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5">
                  اسم الفرع (اختياري)
                </label>
                <input
                  type="text"
                  value={profile.branchName || ''}
                  onChange={e => setProfile({ ...profile, branchName: e.target.value })}
                  placeholder="مثال: الفرع الرئيسي - المعادي"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1">
                  <Phone className="w-3.5 h-3.5 text-emerald-600" />
                  <span>رقم الهاتف / خدمة العملاء *</span>
                </label>
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={profile.phone}
                  onChange={e => setProfile({ ...profile, phone: e.target.value })}
                  placeholder="01xxxxxxxxx"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold font-mono text-slate-900 dark:text-white text-right focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-emerald-600" />
                  <span>عنوان المحل *</span>
                </label>
                <input
                  type="text"
                  required
                  value={profile.address}
                  onChange={e => setProfile({ ...profile, address: e.target.value })}
                  placeholder="الشارع، المنطقة، المحافظة"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1">
                  <Coins className="w-3.5 h-3.5 text-emerald-600" />
                  <span>رمز العملة</span>
                </label>
                <input
                  type="text"
                  value={profile.currency}
                  onChange={e => setProfile({ ...profile, currency: e.target.value || 'EGP' })}
                  placeholder="EGP أو ج.م"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5 text-emerald-600" />
                  <span>الرقم الضريبي / السجل التجاري (اختياري)</span>
                </label>
                <input
                  type="text"
                  value={profile.taxNumber || ''}
                  onChange={e => setProfile({ ...profile, taxNumber: e.target.value })}
                  placeholder="مثال: 123-456-789"
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold font-mono text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Modules Toggles */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-5 rounded-2xl shadow-sm space-y-4">
            <div className="pb-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-black text-base text-slate-900 dark:text-white flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-500" />
                <span>الموديولات وتخصيص نوع النشاط</span>
              </h3>
              <span className="text-[11px] text-slate-500">فعل فقط ما يناسب نشاطك التجاري</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Dairy Module */}
              <label className={`p-4 rounded-xl border-2 cursor-pointer transition-all flex flex-col justify-between gap-3 ${
                profile.modules.dairy 
                  ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/30 text-blue-900 dark:text-blue-100' 
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 opacity-75'
              }`}>
                <div className="flex items-start justify-between">
                  <span className="text-2xl">🧀</span>
                  <input
                    type="checkbox"
                    checked={profile.modules.dairy}
                    onChange={e => setProfile({
                      ...profile,
                      modules: { ...profile.modules, dairy: e.target.checked }
                    })}
                    className="w-5 h-5 text-blue-600 rounded cursor-pointer"
                  />
                </div>
                <div>
                  <div className="font-black text-sm">قسم الألبان والأجبان</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                    إدارة درجات التبريد، الصلاحية القصيرة، وبطاقات مؤشرات الثلاجة في لوحة التحكم.
                  </div>
                </div>
              </label>

              {/* Weighing Scale Module */}
              <label className={`p-4 rounded-xl border-2 cursor-pointer transition-all flex flex-col justify-between gap-3 ${
                profile.modules.weighingScale 
                  ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-100' 
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 opacity-75'
              }`}>
                <div className="flex items-start justify-between">
                  <span className="text-2xl">⚖️</span>
                  <input
                    type="checkbox"
                    checked={profile.modules.weighingScale}
                    onChange={e => setProfile({
                      ...profile,
                      modules: { ...profile.modules, weighingScale: e.target.checked }
                    })}
                    className="w-5 h-5 text-indigo-600 rounded cursor-pointer"
                  />
                </div>
                <div>
                  <div className="font-black text-sm">الميزان والباركود الوزني</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                    قراءة باركود موازين الباركود التلقائية (20/21)، وحساب الوزن والجرامات، وخصم الفارغ.
                  </div>
                </div>
              </label>

              {/* Delivery Module */}
              <label className={`p-4 rounded-xl border-2 cursor-pointer transition-all flex flex-col justify-between gap-3 ${
                profile.modules.delivery 
                  ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/30 text-amber-900 dark:text-amber-100' 
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 opacity-75'
              }`}>
                <div className="flex items-start justify-between">
                  <span className="text-2xl">🛵</span>
                  <input
                    type="checkbox"
                    checked={profile.modules.delivery}
                    onChange={e => setProfile({
                      ...profile,
                      modules: { ...profile.modules, delivery: e.target.checked }
                    })}
                    className="w-5 h-5 text-amber-600 rounded cursor-pointer"
                  />
                </div>
                <div>
                  <div className="font-black text-sm">خدمة التوصيل والدليفري</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                    إظهار بيانات الدليفري في الفواتير المطبوعة وسجلات حسابات عملاء التوصيل.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Receipt Customization */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-5 rounded-2xl shadow-sm space-y-4">
            <h3 className="font-black text-base text-slate-900 dark:text-white pb-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <Receipt className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              <span>نصوص وترويسة الفاتورة المطبوعة</span>
            </h3>

            <div>
              <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5">
                سطر الترويسة أعلى الفاتورة
              </label>
              <input
                type="text"
                value={profile.receiptHeader || ''}
                onChange={e => setProfile({ ...profile, receiptHeader: e.target.value })}
                placeholder="مثال: بقالة جافة • مشروبات • منظفات • كاشير وتوصيل"
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-black text-slate-700 dark:text-slate-300 mb-1.5">
                رسالة التذييل أسفل الفاتورة
              </label>
              <input
                type="text"
                value={profile.receiptFooter || ''}
                onChange={e => setProfile({ ...profile, receiptFooter: e.target.value })}
                placeholder="مثال: شكراً لزيارتكم ونسعد بخدمتكم دائماً"
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Right Sidebar: Logo Upload & Live Thermal Receipt Preview */}
        <div className="space-y-6">
          {/* Logo Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-5 rounded-2xl shadow-sm space-y-3">
            <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center justify-between">
              <span>شعار المحل (لوجو)</span>
              <span className="text-[10px] text-slate-500 font-mono">أقصى حد: 100KB</span>
            </h3>

            {profile.logo ? (
              <div className="space-y-3">
                <div className="p-3 bg-slate-100 dark:bg-slate-800/80 rounded-xl flex items-center justify-center border border-slate-200 dark:border-slate-700">
                  <img
                    src={profile.logo}
                    alt="Logo preview"
                    className="max-h-24 max-w-full object-contain rounded"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleRemoveLogo}
                  className="w-full py-2 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-800 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>حذف الشعار الحالي</span>
                </button>
              </div>
            ) : (
              <div>
                <label className="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-xl p-5 flex flex-col items-center justify-center text-center cursor-pointer transition-all bg-slate-50/50 dark:bg-slate-800/20">
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">اختر صورة الشعار</span>
                  <span className="text-[10px] text-slate-500 mt-1">PNG, JPG, SVG (أقل من 100 كيلوبايت)</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>

          {/* Live Receipt Preview Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-5 rounded-2xl shadow-sm space-y-3">
            <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-4 h-4 text-emerald-600" />
              <span>معاينة ترويسة بون الكاشير الحراري</span>
            </h3>

            <div className="bg-white text-black p-4 rounded-xl border border-dashed border-slate-400 font-mono text-[11px] leading-relaxed shadow-inner">
              <div className="text-center pb-2 border-b border-dashed border-black">
                {profile.logo && (
                  <img
                    src={profile.logo}
                    alt="Receipt Logo"
                    className="h-10 mx-auto object-contain mb-1.5 filter grayscale"
                  />
                )}
                <div className="font-black text-sm">{profile.name || 'اسم المحل'}</div>
                {profile.branchName && (
                  <div className="text-[10px] text-gray-700">{profile.branchName}</div>
                )}
                {profile.receiptHeader && (
                  <div className="text-[9px] text-gray-800 mt-0.5">{profile.receiptHeader}</div>
                )}
                <div className="text-[9px] mt-0.5">
                  هاتف: <span dir="ltr">{profile.phone || '01xxxxxxxxx'}</span>
                </div>
                <div className="text-[9px] text-gray-600">{profile.address || 'العنوان'}</div>
                {profile.taxNumber && (
                  <div className="text-[8px] text-gray-600">ب.ض: {profile.taxNumber}</div>
                )}
              </div>

              <div className="py-2 text-[10px] text-center text-gray-500">
                [محتوى أصناف الفاتورة والحساب]
              </div>

              <div className="text-center pt-2 border-t border-dashed border-black text-[9px] text-gray-800">
                {profile.receiptFooter || (`شكراً لزيارتكم ${profile.name || 'المحل'}`)}
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};
