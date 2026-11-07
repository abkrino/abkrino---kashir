import React, { useState, useEffect, useRef } from 'react';
import { User } from '../../types';
import { storage } from '../../services/storageService';
import { cloudService } from '../../services/cloudService';
import { 
  Lock, 
  ShieldCheck, 
  UserCheck, 
  KeyRound, 
  AlertCircle, 
  CheckCircle, 
  Delete, 
  Eye, 
  EyeOff, 
  Sparkles, 
  X,
  RotateCcw,
  Mail,
  Store,
  Wifi,
  Cloud
} from 'lucide-react';

interface LoginModalProps {
  users: User[];
  currentUser: User;
  onLoginSuccess: (user: User) => void;
  onClose?: () => void;
  isLockScreen?: boolean;
}

// Convert any Arabic-Indic numerals (١, ٢, ٣...) or Persian numerals to standard digits (1, 2, 3...)
export const normalizeArabicDigits = (str: string): string => {
  return str
    .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
    .replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
};

export const LoginModal: React.FC<LoginModalProps> = ({
  users,
  currentUser,
  onLoginSuccess,
  onClose,
  isLockScreen = false,
}) => {
  const [authMode, setAuthMode] = useState<'PIN' | 'CLOUD_EMAIL'>('PIN');
  const [cloudEmail, setCloudEmail] = useState<string>(cloudService.getLinkedStore().ownerEmail || 'mahmoud.mansour0b@gmail.com');
  const [cloudPassword, setCloudPassword] = useState<string>('••••••••');
  const [showCloudPassword, setShowCloudPassword] = useState<boolean>(false);
  const [isCloudLoggingIn, setIsCloudLoggingIn] = useState<boolean>(false);
  const linkedStore = cloudService.getLinkedStore();

  const [selectedUserId, setSelectedUserId] = useState<string>(currentUser.id);
  const [pin, setPin] = useState<string>('');
  const [showPin, setShowPin] = useState<boolean>(true); // default visible so user sees what they type
  const [error, setError] = useState<string | null>(null);
  const [isChangingPin, setIsChangingPin] = useState<boolean>(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  // Change PIN Form
  const [oldPin, setOldPin] = useState<string>('');
  const [newPin, setNewPin] = useState<string>('');
  const [confirmNewPin, setConfirmNewPin] = useState<string>('');
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);

  const pinInputRef = useRef<HTMLInputElement>(null);

  const selectedUser = users.find(u => u.id === selectedUserId) || users[0];
  const defaultPinForSelected = selectedUser.role === 'ADMIN' ? '1234' : '1111';

  const handleCloudLogin = async (e?: React.FormEvent, overrideEmail?: string, overridePass?: string) => {
    if (e) e.preventDefault();
    setError(null);
    setIsCloudLoggingIn(true);
    
    const emailToUse = overrideEmail || cloudEmail;
    const passToUse = overridePass || cloudPassword;

    const res = await cloudService.signInWithEmail(emailToUse, passToUse);
    setIsCloudLoggingIn(false);

    if (res.success) {
      // Find admin user or create/use primary user
      const adminUser = users.find(u => u.role === 'ADMIN') || users[0];
      setResetNotice(
        res.offlineMode 
          ? `تم الدخول بنجاح بحساب (${emailToUse}) في وضع الأوفلاين المحلي (تم حفظ البيانات على الجهاز).`
          : `تم توثيق الدخول السحابي بنجاح بحساب (${emailToUse}) ومزامنة بيانات المحل!`
      );
      setTimeout(() => {
        onLoginSuccess(adminUser);
      }, 700);
    } else {
      setError(res.error || 'فشل تسجيل الدخول. يرجى التأكد من كتابة البريد وكلمة المرور بشكل صحيح.');
    }
  };

  // Focus input on mount or user change
  useEffect(() => {
    pinInputRef.current?.focus();
  }, [selectedUserId, isChangingPin]);

  const handleKeyPress = (num: string) => {
    if (pin.length < 8) {
      setPin(prev => prev + num);
      setError(null);
    }
  };

  const handleDelete = () => {
    setPin(prev => prev.slice(0, -1));
    setError(null);
  };

  const handleClear = () => {
    setPin('');
    setError(null);
  };

  const handleLogin = (pinToTest?: string) => {
    const rawPin = pinToTest !== undefined ? pinToTest : pin;
    const cleanPin = normalizeArabicDigits(rawPin).trim();
    
    if (!cleanPin) {
      setError('يرجى كتابة الرقم السري (PIN)');
      return;
    }

    const res = storage.authenticate(selectedUserId, cleanPin);
    if (res.success && res.user) {
      onLoginSuccess(res.user);
    } else {
      setError(res.error || `الرقم السري غير صحيح. الرقم السري الافتراضي هو (${defaultPinForSelected})`);
      setPin('');
    }
  };

  // One-click quick login with default PIN
  const handleDirectDefaultLogin = () => {
    // If the pin in storage was changed or desynced, ensure selected user has the default PIN
    const allUsers = storage.getUsers();
    const u = allUsers.find(usr => usr.id === selectedUserId);
    if (u) {
      u.pinCode = defaultPinForSelected;
      storage.saveUser(u);
    }
    setPin(defaultPinForSelected);
    handleLogin(defaultPinForSelected);
  };

  // Emergency reset of PINs to 1234 (Admin) and 1111 (Sales)
  const handleResetAllPinsToDefault = () => {
    const allUsers = storage.getUsers();
    for (const u of allUsers) {
      u.pinCode = u.role === 'ADMIN' ? '1234' : '1111';
      storage.saveUser(u);
    }
    setResetNotice('تمت استعادة الأرقام السرية الافتراضية بنجاح! المدير (1234) • الكاشير (1111)');
    setError(null);
    setPin(defaultPinForSelected);
    setTimeout(() => setResetNotice(null), 4000);
  };

  const handleChangePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setChangeSuccess(null);

    const cleanOld = normalizeArabicDigits(oldPin).trim();
    const cleanNew = normalizeArabicDigits(newPin).trim();
    const cleanConfirm = normalizeArabicDigits(confirmNewPin).trim();

    if (cleanNew !== cleanConfirm) {
      setError('الرقم السري الجديد وتأكيده غير متطابقين');
      return;
    }

    const res = storage.changeUserPin(selectedUserId, cleanOld, cleanNew);
    if (res.success) {
      setChangeSuccess('تم تغيير الرقم السري بنجاح!');
      setOldPin('');
      setNewPin('');
      setConfirmNewPin('');
      setTimeout(() => {
        setIsChangingPin(false);
        setChangeSuccess(null);
      }, 1500);
    } else {
      setError(res.error || 'فشل تغيير الرقم السري. تأكد من الرقم السري القديم.');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 z-50 select-none overflow-y-auto" dir="rtl">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full shadow-2xl p-6 text-right relative my-6">
        {/* Close button if not locked */}
        {!isLockScreen && onClose && (
          <button
            onClick={onClose}
            className="absolute top-4 left-4 text-slate-400 hover:text-white p-1 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Header */}
        <div className="text-center pb-4 border-b border-slate-800">
          <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-full flex items-center justify-center mx-auto mb-2 text-emerald-400">
            <Lock className="w-7 h-7" />
          </div>
          <h2 className="text-lg font-bold text-white">
            {isLockScreen ? 'شاشة الأمان وقفل البرنامج' : 'تسجيل دخول المستخدم'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            اختر المستخدم واكتب الرقم السري (PIN)
          </p>
        </div>

        {/* Auth Mode Tabs Switcher */}
        <div className="flex bg-slate-950 p-1 rounded-xl my-3 border border-slate-800 gap-1">
          <button
            type="button"
            onClick={() => {
              setAuthMode('PIN');
              setError(null);
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
              authMode === 'PIN'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>كاشير المحل (PIN)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setAuthMode('CLOUD_EMAIL');
              setError(null);
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
              authMode === 'CLOUD_EMAIL'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>حساب المالك بالكلود (إيميل وباسورد)</span>
          </button>
        </div>

        {authMode === 'CLOUD_EMAIL' ? (
          /* Cloud Email & Password Login View */
          <div className="space-y-3.5 my-2">
            {/* Linked Store & Chain Card */}
            <div className="bg-slate-950/90 border border-emerald-500/30 rounded-xl p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between text-emerald-400 font-bold border-b border-slate-800 pb-1.5">
                <span className="flex items-center gap-1.5">
                  <Store className="w-4 h-4 text-emerald-400" />
                  <span>المحل المربوط بهذا الحساب</span>
                </span>
                <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-500/30">
                  فرع رئيسي
                </span>
              </div>
              <div className="text-white font-bold text-sm">
                {linkedStore.storeName}
              </div>
              <div className="text-slate-400 text-[11px] flex items-center justify-between">
                <span>السلسلة: <strong className="text-slate-300">{linkedStore.chainName}</strong></span>
                <span className="text-amber-400 font-semibold">{linkedStore.subscriptionPlan}</span>
              </div>
            </div>

            {/* Offline Resilience Note */}
            <div className="p-2.5 rounded-xl bg-blue-950/50 border border-blue-800/60 text-[11px] text-blue-200 flex items-start gap-2 leading-relaxed">
              <Wifi className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <span>
                <strong>ملاحظة هامة:</strong> يلزم الاتصال بالإنترنت للمرة الأولى فقط لربط المحل بالكلود، وبعدها يتم حفظ البيانات والتوثيق محلياً على الجهاز ليعمل النظام أوفلاين بالكامل مع استمرار الحفظ المزدوج.
              </span>
            </div>

            {/* Email Form */}
            <form onSubmit={(e) => handleCloudLogin(e)} className="space-y-3">
              <div>
                <label className="text-slate-300 block mb-1 text-xs font-semibold">
                  البريد الإلكتروني الأساسي للمالك:
                </label>
                <div className="relative">
                  <input
                    type="email"
                    required
                    value={cloudEmail}
                    onChange={(e) => setCloudEmail(e.target.value)}
                    placeholder="mahmoud.mansour0b@gmail.com"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2 px-3 pl-10 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                </div>
              </div>

              <div>
                <label className="text-slate-300 block mb-1 text-xs font-semibold">
                  كلمة المرور:
                </label>
                <div className="relative">
                  <input
                    type={showCloudPassword ? 'text' : 'password'}
                    required
                    value={cloudPassword}
                    onChange={(e) => setCloudPassword(e.target.value)}
                    placeholder="اكتب كلمة المرور..."
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2 px-3 pl-10 text-white font-mono text-xs focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCloudPassword(!showCloudPassword)}
                    className="absolute left-3 top-2.5 text-slate-500 hover:text-slate-300 cursor-pointer"
                  >
                    {showCloudPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* 1-Click Quick Fill & Login Button */}
              <button
                type="button"
                onClick={() => {
                  setCloudEmail('mahmoud.mansour0b@gmail.com');
                  setCloudPassword('admin123456');
                  handleCloudLogin(undefined, 'mahmoud.mansour0b@gmail.com', 'admin123456');
                }}
                className="w-full bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600 text-emerald-300 text-xs font-bold py-2 rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all shadow-md"
              >
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>دخول سريع وتوثيق حساب المالك الافتراضي (mahmoud.mansour0b@gmail.com)</span>
              </button>

              <button
                type="submit"
                disabled={isCloudLoggingIn}
                className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-black text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer transition-all"
              >
                <Cloud className="w-4 h-4" />
                <span>{isCloudLoggingIn ? 'جاري التحقق والربط...' : 'دخول وتوثيق المحل بالكلود'}</span>
              </button>
            </form>
          </div>
        ) : (
          /* Cashier PIN Login Mode */
          <>
            {/* User Selector Chips */}
            <div className="my-4 grid grid-cols-2 gap-2">
              {users.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setSelectedUserId(u.id);
                    setPin('');
                    setError(null);
                  }}
                  className={`p-3 rounded-xl border text-right transition-all cursor-pointer flex items-center gap-2.5 ${
                    selectedUserId === u.id
                      ? 'bg-slate-800 border-emerald-500 shadow-md shadow-emerald-950/50'
                      : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 opacity-60'
                  }`}
                >
                  <div className={`p-2 rounded-lg text-white ${u.role === 'ADMIN' ? 'bg-emerald-600' : 'bg-blue-600'}`}>
                    {u.role === 'ADMIN' ? <ShieldCheck className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                  </div>
                  <div className="overflow-hidden">
                    <span className="font-bold text-xs text-slate-100 block truncate">{u.fullName}</span>
                    <span className="text-[10px] text-emerald-400 block font-mono font-bold">
                      {u.role === 'ADMIN' ? 'الرقم السري: 1234' : 'الرقم السري: 1111'}
                    </span>
                  </div>
                </button>
              ))}
            </div>

        {error && (
          <div className="mb-3 p-2.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {resetNotice && (
          <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{resetNotice}</span>
          </div>
        )}

        {changeSuccess && (
          <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{changeSuccess}</span>
          </div>
        )}

        {!isChangingPin ? (
          <div>
            {/* Direct Input Field for physical keyboard & tablet touch keyboard */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 my-2 text-center relative">
              <span className="text-[11px] text-slate-400 block mb-1">
                الرقم السري لـ <strong className="text-white">({selectedUser.fullName})</strong>:
              </span>
              
              <div className="relative max-w-[200px] mx-auto">
                <input
                  ref={pinInputRef}
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pin}
                  onChange={(e) => {
                    const normalized = normalizeArabicDigits(e.target.value);
                    setPin(normalized);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleLogin();
                    }
                  }}
                  placeholder="اكتب الرقم السري..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-center text-xl font-mono tracking-widest text-emerald-400 font-bold focus:outline-none focus:border-emerald-500"
                />
                
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute left-2 top-2.5 text-slate-500 hover:text-slate-300 p-0.5 cursor-pointer"
                  title={showPin ? 'إخفاء الأرقام' : 'إظهار الأرقام'}
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Quick 1-Click Fill and Auto-Login Button */}
            <div className="my-2.5 text-center">
              <button
                type="button"
                onClick={handleDirectDefaultLogin}
                className="w-full bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600 text-emerald-300 text-xs font-bold py-2 rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all shadow-md"
              >
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>دخول مباشر وفوري بكلمة السر الافتراضية ({defaultPinForSelected})</span>
              </button>
            </div>

            {/* Touch-Friendly On-Screen Numeric Keypad (for POS Touchscreens & Tablets) */}
            <div className="grid grid-cols-3 gap-2 my-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                <button
                  key={num}
                  type="button"
                  onClick={() => handleKeyPress(num)}
                  className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 font-mono font-bold text-lg py-2.5 rounded-xl border border-slate-700/60 shadow-sm cursor-pointer transition-transform active:scale-95"
                >
                  {num}
                </button>
              ))}
              <button
                type="button"
                onClick={handleClear}
                className="bg-slate-950 hover:bg-slate-800 text-slate-400 font-bold text-xs py-2.5 rounded-xl border border-slate-800 cursor-pointer"
              >
                مسح
              </button>
              <button
                type="button"
                onClick={() => handleKeyPress('0')}
                className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 font-mono font-bold text-lg py-2.5 rounded-xl border border-slate-700/60 shadow-sm cursor-pointer"
              >
                0
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="bg-slate-950 hover:bg-slate-800 text-rose-400 flex items-center justify-center py-2.5 rounded-xl border border-slate-800 cursor-pointer"
              >
                <Delete className="w-5 h-5" />
              </button>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => handleLogin()}
                className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer transition-all"
              >
                <KeyRound className="w-4 h-4" />
                <span>دخول النظام</span>
              </button>

              <div className="flex items-center justify-between pt-2 text-[11px] text-slate-400 border-t border-slate-800">
                <button
                  type="button"
                  onClick={handleResetAllPinsToDefault}
                  className="text-slate-400 hover:text-emerald-400 flex items-center gap-1 cursor-pointer"
                  title="استعادة الباسورد 1234 و 1111 إذا نسيتها"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>إعادة تعيين للأرقام الافتراضية</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsChangingPin(true);
                    setError(null);
                  }}
                  className="text-amber-400 hover:text-amber-300 font-semibold cursor-pointer"
                >
                  تغيير الرقم السري 🔑
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Change PIN Form */
          <form onSubmit={handleChangePinSubmit} className="space-y-3 my-3 text-xs">
            <div>
              <label className="text-slate-300 block mb-1">الرقم السري الحالي لـ ({selectedUser.fullName}):</label>
              <input
                type="text"
                required
                value={oldPin}
                onChange={(e) => setOldPin(normalizeArabicDigits(e.target.value))}
                placeholder={defaultPinForSelected}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-center tracking-widest text-sm"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1">الرقم السري الجديد (4 أرقام أو أكثر):</label>
              <input
                type="text"
                required
                value={newPin}
                onChange={(e) => setNewPin(normalizeArabicDigits(e.target.value))}
                placeholder="اكتب الباسورد الجديد"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-center tracking-widest text-sm text-emerald-400"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1">تأكيد الرقم السري الجديد:</label>
              <input
                type="text"
                required
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(normalizeArabicDigits(e.target.value))}
                placeholder="أعد كتابة الباسورد الجديد"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-center tracking-widest text-sm text-emerald-400"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsChangingPin(false);
                  setError(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer"
              >
                حفظ الباسورد الجديد
              </button>
            </div>
          </form>
        )}
      </>
    )}
  </div>
</div>
  );
};
