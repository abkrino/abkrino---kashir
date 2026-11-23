import React, { useState } from 'react';
import { User } from '../../types';
import { storage } from '../../services/storageService';
import { authSecurityService, isKnownDefaultPin } from '../../services/authSecurityService';
import { 
  ShieldCheck, 
  Lock, 
  UserCheck, 
  Phone, 
  KeyRound, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  Sparkles,
  CheckCircle2
} from 'lucide-react';

interface AdminSetupModalProps {
  onAdminCreated: (admin: User) => void;
}

export const AdminSetupModal: React.FC<AdminSetupModalProps> = ({ onAdminCreated }) => {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('admin');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
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
      setError('لا يمكن استخدام كلمة مرور افتراضية شائعة (مثل 123456 أو 1234 أو 1111). اختر كلمة مرور قوية وفريدة.');
      return;
    }

    setIsLoading(true);
    try {
      const admin = await authSecurityService.setupInitialAdmin({
        fullName: cleanName,
        username: cleanUsername,
        password: cleanPassword,
        phone: phone.trim(),
      });
      await storage.flush();
      if (storage.getWriteError()) {
        setError(`تعذر تأكيد حفظ بيانات المدير في التخزين الدائم: ${storage.getWriteError()}`);
        setIsLoading(false);
        return;
      }
      onAdminCreated(admin);
    } catch (err: any) {
      setError(err?.message || 'حدث خطأ أثناء حفظ بيانات المدير');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-4 z-50 overflow-y-auto select-none" dir="rtl">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-lg w-full shadow-2xl p-6 md:p-8 text-right my-8">
        {/* Header Icon & Title */}
        <div className="text-center pb-5 border-b border-slate-800">
          <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto mb-3 text-emerald-400 shadow-inner">
            <ShieldCheck className="w-9 h-9" />
          </div>
          <h2 className="text-xl md:text-2xl font-black text-white">
            إعداد حساب المدير العام المسؤول
          </h2>
          <p className="text-xs md:text-sm text-slate-400 mt-1.5 leading-relaxed">
            أهلاً بك! قبل بدء العمل بالنظام، يجب تعيين بيانات وكلمة مرور المدير العام لتأمين حسابات المحل، وإدارة الكاشيرية، وحماية أموال الخزينة.
          </p>
          <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-950/80 border border-emerald-700/60 rounded-full text-[11px] text-emerald-300 font-bold">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>حماية مشددة: تشفير PBKDF2-SHA256 بـ 100,000 تكرار مع Salt عشوائي</span>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 mt-5 text-xs">
          <div>
            <label className="text-slate-300 block mb-1 font-bold">
              الاسم بالكامل للمدير المسؤول: <span className="text-rose-400">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="مثال: الحاج محمود منصور"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-sm font-bold focus:outline-none focus:border-emerald-500 transition-colors pr-10"
              />
              <UserCheck className="w-4 h-4 text-slate-500 absolute right-3.5 top-3.5" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-slate-300 block mb-1 font-bold">
                اسم المستخدم للدخول: <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-sm font-mono focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1 font-bold">
                رقم الهاتف (اختياري):
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="01012345678"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-sm font-mono focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                />
                <Phone className="w-4 h-4 text-slate-500 absolute right-3.5 top-3.5" />
              </div>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-slate-300 font-bold">
                كلمة مرور المدير (6 خانات على الأقل): <span className="text-rose-400">*</span>
              </label>
              <span className="text-[10px] text-slate-400 font-medium">أرقام أو حروف</span>
            </div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="اكتب كلمة مرور قوية (6 خانات أو أكثر)"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-sm font-mono tracking-wider focus:outline-none focus:border-emerald-500 transition-colors pl-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute left-3 top-3.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                title={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-slate-300 block mb-1 font-bold">
              تأكيد كلمة المرور: <span className="text-rose-400">*</span>
            </label>
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="أعد كتابة كلمة المرور للتأكيد"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-white text-sm font-mono tracking-wider focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-black text-sm py-3.5 rounded-xl shadow-lg shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer transition-all disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>جاري تشفير وحفظ بيانات المدير...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>تأكيد وحفظ بيانات المدير وبدء العمل</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
