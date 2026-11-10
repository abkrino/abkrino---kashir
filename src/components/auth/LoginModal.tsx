import React, { useState, useEffect, useRef } from 'react';
import { User } from '../../types';
import { storage } from '../../services/storageService';
import { 
  authSecurityService, 
  isKnownDefaultPin, 
  LockoutStatus 
} from '../../services/authSecurityService';
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
  X,
  Clock,
  ShieldAlert
} from 'lucide-react';

interface LoginModalProps {
  users: User[];
  currentUser: User | null;
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
  const activeUsers = users.filter(u => u.isActive !== false);
  const initialUserId = (currentUser && activeUsers.some(u => u.id === currentUser.id))
    ? currentUser.id
    : (activeUsers[0]?.id || users[0]?.id || '');

  const [selectedUserId, setSelectedUserId] = useState<string>(initialUserId);
  const [pin, setPin] = useState<string>('');
  const [showPin, setShowPin] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Lockout state per selected user
  const [lockout, setLockout] = useState<LockoutStatus>(() => authSecurityService.getLockoutStatus(selectedUserId));

  // Forced PIN change state (Requirement 6)
  const [isForcedChangePin, setIsForcedChangePin] = useState<boolean>(false);
  const [pendingMigratedUser, setPendingMigratedUser] = useState<User | null>(null);
  const [forcedNewPin, setForcedNewPin] = useState<string>('');
  const [forcedConfirmPin, setForcedConfirmPin] = useState<string>('');

  // Normal Change PIN Form state
  const [isChangingPin, setIsChangingPin] = useState<boolean>(false);
  const [oldPin, setOldPin] = useState<string>('');
  const [newPin, setNewPin] = useState<string>('');
  const [confirmNewPin, setConfirmNewPin] = useState<string>('');
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);

  const pinInputRef = useRef<HTMLInputElement>(null);
  // Requirement 1: Hold the just-entered PIN in memory ONLY during forced PIN change
  const enteredPinRef = useRef<string>('');

  const selectedUser = users.find(u => u.id === selectedUserId) || users[0];

  // Poll lockout timer every second for currently selected user
  useEffect(() => {
    const checkTimer = () => {
      const status = authSecurityService.getLockoutStatus(selectedUserId);
      setLockout(status);
    };

    checkTimer();
    const interval = setInterval(checkTimer, 1000);
    return () => clearInterval(interval);
  }, [selectedUserId]);

  // Clean in-memory PIN ref on unmount
  useEffect(() => {
    return () => {
      enteredPinRef.current = '';
    };
  }, []);

  // Focus input on mount or user switch
  useEffect(() => {
    if (!lockout.isLocked && !isChangingPin && !isForcedChangePin) {
      pinInputRef.current?.focus();
    }
  }, [selectedUserId, isChangingPin, isForcedChangePin, lockout.isLocked]);

  const handleKeyPress = (num: string) => {
    if (lockout.isLocked || isLoading) return;
    if (pin.length < 8) {
      setPin(prev => prev + num);
      setError(null);
    }
  };

  const handleDelete = () => {
    if (lockout.isLocked || isLoading) return;
    setPin(prev => prev.slice(0, -1));
    setError(null);
  };

  const handleClear = () => {
    if (lockout.isLocked || isLoading) return;
    setPin('');
    setError(null);
  };

  const handleLogin = async (pinToTest?: string) => {
    if (lockout.isLocked || isLoading) return;

    const rawPin = pinToTest !== undefined ? pinToTest : pin;
    const cleanPin = normalizeArabicDigits(rawPin).trim();
    
    if (!cleanPin) {
      setError('يرجى كتابة الرقم السري (PIN)');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await authSecurityService.authenticate(selectedUserId, cleanPin);
      
      if (res.isLockedOut) {
        enteredPinRef.current = '';
        setLockout(authSecurityService.getLockoutStatus(selectedUserId));
        setError(res.error || 'تم قفل تسجيل الدخول مؤقتاً');
        setPin('');
        setIsLoading(false);
        return;
      }

      if (res.success && res.user) {
        // Check if forced PIN change is required (migrated default 1234 or 1111)
        if (res.mustChangePin) {
          // Requirement 1: Keep in-memory ONLY
          enteredPinRef.current = cleanPin;
          setPendingMigratedUser(res.user);
          setIsForcedChangePin(true);
          setPin('');
          setIsLoading(false);
          return;
        }

        enteredPinRef.current = '';
        onLoginSuccess(res.user);
      } else {
        enteredPinRef.current = '';
        setError(res.error || 'الرقم السري غير صحيح، حاول مرة أخرى');
        setPin('');
        setLockout(authSecurityService.getLockoutStatus(selectedUserId));
      }
    } catch {
      enteredPinRef.current = '';
      setError('حدث خطأ أثناء التحقق من الرقم السري');
    } finally {
      setIsLoading(false);
    }
  };

  // Submit forced PIN change for migrated default PINs (Requirement 1 & 2)
  const handleForcedPinChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingMigratedUser) return;
    setError(null);

    const oldPin = enteredPinRef.current;
    if (!oldPin) {
      setError('انتهت صلاحية جلسة التحقق، يرجى إعادة تسجيل الدخول');
      setIsForcedChangePin(false);
      setPendingMigratedUser(null);
      return;
    }

    const cleanNew = normalizeArabicDigits(forcedNewPin).trim();
    const cleanConfirm = normalizeArabicDigits(forcedConfirmPin).trim();

    if (cleanNew !== cleanConfirm) {
      setError('الرقم السري الجديد وتأكيده غير متطابقين');
      return;
    }

    if (pendingMigratedUser.role === 'ADMIN') {
      if (cleanNew.length < 6) {
        setError('كلمة مرور المدير يجب ألا تقل عن 6 خانات');
        return;
      }
    } else {
      if (!/^\d{4,6}$/.test(cleanNew)) {
        setError('الرقم السري للكاشير يجب أن يتكون من 4 إلى 6 أرقام');
        return;
      }
    }

    if (isKnownDefaultPin(cleanNew)) {
      setError('لا يمكن اختيار رقم سري افتراضي شائع (مثل 1234 أو 1111). اختر رقماً خاصاً وقوياً.');
      return;
    }

    setIsLoading(true);
    try {
      // Pass oldPin verified from memory ref - never empty string
      const res = await authSecurityService.changeUserPin(pendingMigratedUser.id, oldPin, cleanNew);
      if (res.success) {
        // Requirement 3: flush to persistent storage
        try {
          await storage.flush();
          if (storage.getWriteError()) {
            setError(`تعذر تأكيد حفظ الرقم السري في التخزين الدائم: ${storage.getWriteError()}`);
            return;
          }
        } catch (err: any) {
          setError(`تعذر تأكيد حفظ الرقم السري في التخزين الدائم: ${err?.message || 'خطأ'}`);
          return;
        }

        // Clear memory ref immediately
        enteredPinRef.current = '';

        // Get fresh user from storage
        const latestUsers = storage.getUsers();
        const updatedUser = latestUsers.find(u => u.id === pendingMigratedUser.id) || pendingMigratedUser;

        // Requirement 2: record in audit log and log user in directly
        authSecurityService.recordSuccessfulLogin(updatedUser);
        storage.addAuditLog(
          'AUTH',
          'تسجيل دخول ناجح بعد تغيير الرقم السري الإجباري',
          'الأمان',
          updatedUser.id,
          `تسجيل دخول ناجح للمستخدم (${updatedUser.fullName}) بعد تعيين الرقم السري وتشفيره بـ PBKDF2`
        );

        setIsForcedChangePin(false);
        setPendingMigratedUser(null);
        setForcedNewPin('');
        setForcedConfirmPin('');
        onLoginSuccess(updatedUser);
      } else {
        setError(res.error || 'فشل تحديث الرقم السري');
      }
    } catch {
      setError('حدث خطأ أثناء حفظ الرقم السري الجديد');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePinSubmit = async (e: React.FormEvent) => {
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

    if (isKnownDefaultPin(cleanNew)) {
      setError('لا يمكن اختيار رقم سري افتراضي شائع (مثل 1234 أو 1111)');
      return;
    }

    setIsLoading(true);
    try {
      const res = await authSecurityService.changeUserPin(selectedUserId, cleanOld, cleanNew);
      if (res.success) {
        // Requirement 3: flush to persistent storage
        try {
          await storage.flush();
          if (storage.getWriteError()) {
            setError(`تعذر تأكيد تغيير الرقم السري في التخزين الدائم: ${storage.getWriteError()}`);
            return;
          }
        } catch (err: any) {
          setError(`تعذر تأكيد تغيير الرقم السري في التخزين الدائم: ${err?.message || 'خطأ'}`);
          return;
        }

        setChangeSuccess('تم تغيير وتشفير الرقم السري بـ PBKDF2 بنجاح!');
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
    } catch {
      setError('حدث خطأ أثناء تغيير الرقم السري');
    } finally {
      setIsLoading(false);
    }
  };

  const formatRemainingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 z-50 select-none overflow-y-auto" dir="rtl">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full shadow-2xl p-6 text-right relative my-6">
        {/* Close button if not locked screen */}
        {!isLockScreen && onClose && !isForcedChangePin && (
          <button
            onClick={() => {
              enteredPinRef.current = '';
              setIsForcedChangePin(false);
              setPendingMigratedUser(null);
              setForcedNewPin('');
              setForcedConfirmPin('');
              onClose();
            }}
            className="absolute top-4 left-4 text-slate-400 hover:text-white p-1 rounded-lg cursor-pointer transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Header */}
        <div className="text-center pb-4 border-b border-slate-800">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-2 ${
            lockout.isLocked
              ? 'bg-rose-500/10 border border-rose-500/30 text-rose-400 animate-pulse'
              : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
          }`}>
            {lockout.isLocked ? <ShieldAlert className="w-7 h-7" /> : <Lock className="w-7 h-7" />}
          </div>
          <h2 className="text-lg font-bold text-white">
            {isForcedChangePin
              ? 'تغيير الرقم السري إجباري'
              : isLockScreen
              ? 'شاشة الأمان وقفل البرنامج'
              : 'تسجيل دخول المستخدم'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {isForcedChangePin
              ? 'لحماية أموال وبيانات المحل، يرجى تعيين رقم سري جديد وخاص بك'
              : 'اختر المستخدم واكتب الرقم السري (PIN)'}
          </p>
        </div>

        {/* Lockout Warning Banner (Requirement 7) */}
        {lockout.isLocked && (
          <div className="my-3 p-3.5 rounded-xl bg-rose-950/90 border border-rose-600 text-rose-200 text-xs text-center space-y-1.5 shadow-lg">
            <div className="flex items-center justify-center gap-1.5 font-bold text-rose-300">
              <Clock className="w-4 h-4 text-rose-400 animate-spin" />
              <span>تم قفل تسجيل الدخول بعد 5 محاولات خاطئة متتالية!</span>
            </div>
            <div className="text-sm font-mono font-black text-rose-100 bg-rose-900/40 py-1 px-3 rounded-lg inline-block border border-rose-700/50">
              الوقت المتبقي لفك القفل: {formatRemainingTime(lockout.remainingSeconds)} دقيقة
            </div>
            <p className="text-[11px] text-rose-400">
              (حالة القفل محفوظة ولن تتأثر بإعادة تحميل الصفحة لحماية النظام)
            </p>
          </div>
        )}

        {/* User Selector Chips (Only when not forced changing PIN) */}
        {!isForcedChangePin && (
          <div className="my-4 grid grid-cols-2 gap-2">
            {users.map(u => {
              const uLock = authSecurityService.getLockoutStatus(u.id);

              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={u.isActive === false}
                  onClick={() => {
                    enteredPinRef.current = '';
                    setIsForcedChangePin(false);
                    setPendingMigratedUser(null);
                    setForcedNewPin('');
                    setForcedConfirmPin('');
                    setSelectedUserId(u.id);
                    setPin('');
                    setError(null);
                    setLockout(authSecurityService.getLockoutStatus(u.id));
                  }}
                  className={`p-3 rounded-xl border text-right transition-all cursor-pointer flex items-center gap-2.5 ${
                    selectedUserId === u.id
                      ? 'bg-slate-800 border-emerald-500 shadow-md shadow-emerald-950/50'
                      : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 opacity-60'
                  } ${u.isActive === false ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <div className={`p-2 rounded-lg text-white ${u.role === 'ADMIN' ? 'bg-emerald-600' : 'bg-blue-600'}`}>
                    {u.role === 'ADMIN' ? <ShieldCheck className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                  </div>
                  <div className="overflow-hidden">
                    <span className="font-bold text-xs text-slate-100 block truncate">{u.fullName}</span>
                    <span className="text-[10px] text-slate-400 block font-mono">
                      {uLock.isLocked ? '🔒 مقفول مؤقتاً' : u.role === 'ADMIN' ? 'مدير عام' : 'كاشير مبيعات'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div className="mb-3 p-2.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {changeSuccess && (
          <div className="mb-3 p-2.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{changeSuccess}</span>
          </div>
        )}

        {/* FORCED PIN CHANGE FORM (Requirement 6) */}
        {isForcedChangePin && pendingMigratedUser ? (
          <form onSubmit={handleForcedPinChangeSubmit} className="space-y-3.5 my-3 text-xs">
            <div className="p-3 bg-amber-950/40 border border-amber-800/80 rounded-xl text-amber-300 text-[11px] leading-relaxed">
              ⚠️ <strong>تنبيه أمني هام:</strong> حسابك <strong>({pendingMigratedUser.fullName})</strong> كان يستخدم رقماً سرياً افتراضياً قديماً. تم تشفير بياناتك، ويلزم تعيين رقم سري جديد وخاص بك قبل المتابعة.
            </div>

            <div>
              <label className="text-slate-300 block mb-1 font-bold">
                الرقم السري الجديد ({pendingMigratedUser.role === 'ADMIN' ? '6 خانات على الأقل' : '4 إلى 6 أرقام'}):
              </label>
              <input
                type="password"
                required
                autoFocus
                value={forcedNewPin}
                onChange={(e) => setForcedNewPin(normalizeArabicDigits(e.target.value))}
                placeholder="اكتب الرقم السري الجديد"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-mono text-center tracking-widest text-sm text-emerald-400 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1 font-bold">
                تأكيد الرقم السري الجديد:
              </label>
              <input
                type="password"
                required
                value={forcedConfirmPin}
                onChange={(e) => setForcedConfirmPin(normalizeArabicDigits(e.target.value))}
                placeholder="أعد كتابة الرقم السري للتأكيد"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-mono text-center tracking-widest text-sm text-emerald-400 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl cursor-pointer shadow-md transition-all disabled:opacity-50"
              >
                {isLoading ? 'جاري التشفير والحفظ...' : 'تأكيد الرقم السري الجديد والدخول للنظام'}
              </button>
            </div>
          </form>
        ) : !isChangingPin ? (
          /* STANDARD LOGIN FORM */
          <div>
            {/* Input Field */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 my-2 text-center relative">
              <span className="text-[11px] text-slate-400 block mb-1">
                الرقم السري لـ <strong className="text-white">({selectedUser?.fullName})</strong>:
              </span>
              
              <div className="relative max-w-[200px] mx-auto">
                <input
                  ref={pinInputRef}
                  disabled={lockout.isLocked || isLoading}
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
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-center text-xl font-mono tracking-widest text-emerald-400 font-bold focus:outline-none focus:border-emerald-500 disabled:opacity-50"
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

            {/* Numeric Keypad */}
            <div className="grid grid-cols-3 gap-2 my-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                <button
                  key={num}
                  type="button"
                  disabled={lockout.isLocked || isLoading}
                  onClick={() => handleKeyPress(num)}
                  className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 font-mono font-bold text-lg py-2.5 rounded-xl border border-slate-700/60 shadow-sm cursor-pointer transition-transform active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {num}
                </button>
              ))}
              <button
                type="button"
                disabled={lockout.isLocked || isLoading}
                onClick={handleClear}
                className="bg-slate-950 hover:bg-slate-800 text-slate-400 font-bold text-xs py-2.5 rounded-xl border border-slate-800 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                مسح
              </button>
              <button
                type="button"
                disabled={lockout.isLocked || isLoading}
                onClick={() => handleKeyPress('0')}
                className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 font-mono font-bold text-lg py-2.5 rounded-xl border border-slate-700/60 shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                0
              </button>
              <button
                type="button"
                disabled={lockout.isLocked || isLoading}
                onClick={handleDelete}
                className="bg-slate-950 hover:bg-slate-800 text-rose-400 flex items-center justify-center py-2.5 rounded-xl border border-slate-800 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Delete className="w-5 h-5" />
              </button>
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <button
                type="button"
                disabled={lockout.isLocked || isLoading}
                onClick={() => handleLogin()}
                className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    <span>جاري التحقق والتشفير...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4" />
                    <span>دخول النظام</span>
                  </>
                )}
              </button>

              <div className="flex items-center justify-end pt-2 text-[11px] text-slate-400 border-t border-slate-800">
                <button
                  type="button"
                  disabled={lockout.isLocked}
                  onClick={() => {
                    setIsChangingPin(true);
                    setError(null);
                  }}
                  className="text-amber-400 hover:text-amber-300 font-semibold cursor-pointer transition-colors"
                >
                  تغيير الرقم السري 🔑
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* VOLUNTARY CHANGE PIN FORM */
          <form onSubmit={handleChangePinSubmit} className="space-y-3 my-3 text-xs">
            <div>
              <label className="text-slate-300 block mb-1">الرقم السري الحالي لـ ({selectedUser?.fullName}):</label>
              <input
                type="password"
                required
                value={oldPin}
                onChange={(e) => setOldPin(normalizeArabicDigits(e.target.value))}
                placeholder="اكتب الرقم السري الحالي"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-center tracking-widest text-sm"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1">
                الرقم السري الجديد ({selectedUser?.role === 'ADMIN' ? '6 خانات على الأقل' : '4 إلى 6 أرقام'}):
              </label>
              <input
                type="password"
                required
                value={newPin}
                onChange={(e) => setNewPin(normalizeArabicDigits(e.target.value))}
                placeholder="اكتب الرقم السري الجديد"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-center tracking-widest text-sm text-emerald-400"
              />
            </div>

            <div>
              <label className="text-slate-300 block mb-1">تأكيد الرقم السري الجديد:</label>
              <input
                type="password"
                required
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(normalizeArabicDigits(e.target.value))}
                placeholder="أعد كتابة الرقم السري الجديد"
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
                disabled={isLoading}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer disabled:opacity-50"
              >
                {isLoading ? 'جاري الحفظ...' : 'تشفير وحفظ الرقم السري'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
