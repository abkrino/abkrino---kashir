import React, { useState, useEffect } from 'react';
import { licenseService, LicenseStateResult } from '../../services/licenseService';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Key, 
  Copy, 
  Check, 
  X, 
  AlertCircle, 
  CheckCircle2, 
  Laptop, 
  Calendar, 
  Clock, 
  Info,
  RotateCcw
} from 'lucide-react';

interface LicenseActivationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const LicenseActivationModal: React.FC<LicenseActivationModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [tokenInput, setTokenInput] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedDeviceId, setCopiedDeviceId] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [licenseState, setLicenseState] = useState<LicenseStateResult>(() => licenseService.getLicenseState());

  useEffect(() => {
    if (isOpen) {
      setLicenseState(licenseService.getLicenseState());
      setError(null);
      setSuccessMessage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const requestCode = licenseService.getRequestCode();
  const deviceId = licenseService.getDeviceId();

  const handleCopyRequestCode = async () => {
    try {
      await navigator.clipboard.writeText(requestCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    } catch {
      // Fallback
    }
  };

  const handleCopyDeviceId = async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopiedDeviceId(true);
      setTimeout(() => setCopiedDeviceId(false), 2500);
    } catch {
      // Fallback
    }
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const clean = tokenInput.trim();
    if (!clean) {
      setError('يرجى لصق كود تفعيل الترخيص أولاً.');
      return;
    }

    setIsVerifying(true);
    try {
      const res = await licenseService.verifyAndStoreLicense(clean);
      setIsVerifying(false);

      if (res.success && res.payload) {
        setSuccessMessage(`تم تفعيل الترخيص بنجاح! الخطة: ${res.payload.plan}`);
        setLicenseState(licenseService.getLicenseState());
        setTokenInput('');
        if (onSuccess) {
          onSuccess();
        }
      } else {
        setError(res.error || 'فشل التحقق من كود الترخيص.');
      }
    } catch (err: unknown) {
      setIsVerifying(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`خطأ أثناء تفعيل الترخيص: ${msg}`);
    }
  };

  const handleRemoveLicense = () => {
    licenseService.removeLicense();
    setLicenseState(licenseService.getLicenseState());
    setSuccessMessage('تم إلغاء الترخيص المسجل على هذا الجهاز.');
    setError(null);
  };

  const getStatusBadge = () => {
    switch (licenseState.status) {
      case 'valid':
        if (licenseState.subscriptionPhase === 'EXPIRING') {
          return {
            label: `قريب الانتهاء (متبقي ${licenseState.daysToExpiry} يوم)`,
            color: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/30',
            icon: Clock,
          };
        }
        return {
          label: `ترخيص سارٍ (${licenseState.daysToExpiry} يوم متبقي)`,
          color: 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/30',
          icon: ShieldCheck,
        };
      case 'grace':
        return {
          label: `فترة سماح (متبقي ${licenseState.graceDaysLeft} يوم)`,
          color: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/30',
          icon: Clock,
        };
      case 'expired':
        return {
          label: 'الترخيص منتهي الصلاحية',
          color: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/30',
          icon: ShieldAlert,
        };
      case 'checking':
        return {
          label: 'جاري التحقق من الترخيص...',
          color: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/30',
          icon: RotateCcw,
        };
      case 'tampered':
        return {
          label: 'توقيع تالف أو غير صالح',
          color: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/30',
          icon: ShieldAlert,
        };
      case 'wrong-device':
        return {
          label: 'مخصص لجهاز مختلف',
          color: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/30',
          icon: Laptop,
        };
      case 'clock-rollback':
        return {
          label: 'تم تغيير ساعة الجهاز',
          color: 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/30',
          icon: Clock,
        };
      default:
        return {
          label: 'غير مرخص',
          color: 'bg-slate-500/20 text-slate-800 dark:text-slate-300 border-slate-500/30',
          icon: Key,
        };
    }
  };

  const statusBadge = getStatusBadge();
  const StatusIcon = statusBadge.icon;

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" dir="rtl">
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl max-w-xl w-full shadow-2xl p-6 text-right relative my-6 space-y-5 animate-in fade-in duration-200">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 left-4 text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded-lg cursor-pointer transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
            <Key className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-black text-slate-900 dark:text-white">
                تفعيل وتجديد ترخيص النظام
              </h2>
              <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border flex items-center gap-1 ${statusBadge.color}`}>
                <StatusIcon className="w-3.5 h-3.5" />
                <span>{statusBadge.label}</span>
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              نظام الترخيص المحلي المشفر بدون الحاجة إلى اتصال دائم بالإنترنت.
            </p>
          </div>
        </div>

        {/* Error / Success Notices */}
        {error && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/70 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs sm:text-sm font-bold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{error}</span>
          </div>
        )}

        {successMessage && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs sm:text-sm font-bold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Step 1: Device Request Code */}
        <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
              <Laptop className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>الخطوة 1: كود طلب الترخيص للجهاز</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyDeviceId}
                className="text-[11px] px-2 py-1 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 font-mono font-bold cursor-pointer transition-colors"
                title="نسخ معرّف الجهاز فقط"
              >
                {copiedDeviceId ? 'تم نسخ المعرف ✓' : `الجهاز: ${deviceId.slice(0, 10)}...`}
              </button>
              <button
                type="button"
                onClick={handleCopyRequestCode}
                className="text-xs px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
              >
                {copiedCode ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>تم النسخ ✓</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>نسخ كود الطلب</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-300 dark:border-slate-800 font-mono text-[11px] text-slate-600 dark:text-slate-300 break-all select-all max-h-16 overflow-y-auto">
            {requestCode}
          </div>

          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            انسخ هذا الكود وأرسله للإدارة أو الدعم الفني لاستخراج كود التفعيل الرقمي المخصص لهذا الجهاز.
          </p>
        </div>

        {/* Step 2: Paste Activation Token */}
        <form onSubmit={handleActivate} className="space-y-3">
          <div>
            <label className="text-xs font-black text-slate-900 dark:text-white block mb-1.5">
              الخطوة 2: لصق كود تفعيل الترخيص
            </label>
            <textarea
              required
              rows={3}
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value);
                setError(null);
              }}
              placeholder="الصق كود التفعيل أو التجديد هنا"
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-900 dark:text-emerald-300 focus:outline-none focus:border-emerald-500 resize-none"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            {licenseState.status !== 'unlicensed' ? (
              <button
                type="button"
                onClick={handleRemoveLicense}
                className="text-xs px-3 py-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg cursor-pointer flex items-center gap-1 font-bold"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>إزالة الترخيص الحالي</span>
              </button>
            ) : <div />}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer transition-colors"
              >
                إغلاق
              </button>

              <button
                type="submit"
                disabled={isVerifying}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-black flex items-center gap-2 cursor-pointer shadow-md transition-all active:scale-95"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{isVerifying ? 'جاري التحقق...' : 'تفعيل الترخيص الآن'}</span>
              </button>
            </div>
          </div>
        </form>

        {/* Active License Details if present */}
        {licenseState.payload && (
          <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 text-xs space-y-2">
            <span className="font-black text-slate-700 dark:text-slate-300 block mb-1">
              بيانات الترخيص المفعّل حالياً:
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px]">الخطة</span>
                <span className="font-bold text-slate-800 dark:text-white truncate block">{licenseState.payload.plan}</span>
              </div>
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px]">وضع التشغيل</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400 block">{licenseState.payload.mode === 'offline' ? 'أوفلاين محلي' : 'أونلاين'}</span>
              </div>
              <div className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px]">تاريخ الانتهاء</span>
                <span className="font-mono font-bold text-slate-800 dark:text-white block">{licenseState.payload.validUntil.slice(0, 10)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
