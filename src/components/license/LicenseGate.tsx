import React, { useState } from 'react';
import { 
  licenseService, 
  LICENSE_ENFORCEMENT 
} from '../../services/licenseService';
import { 
  Key, 
  Copy, 
  Check, 
  AlertCircle, 
  Laptop, 
  PlayCircle,
  FileCheck
} from 'lucide-react';

interface LicenseGateProps {
  onActivationSuccess: () => void;
}

export const LicenseGate: React.FC<LicenseGateProps> = ({ onActivationSuccess }) => {
  const [tokenInput, setTokenInput] = useState<string>('');
  const [copiedDeviceId, setCopiedDeviceId] = useState<boolean>(false);
  const [copiedRequestCode, setCopiedRequestCode] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const deviceId = licenseService.getDeviceId();
  const requestCode = licenseService.getRequestCode();

  const handleCopyDeviceId = async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopiedDeviceId(true);
      setTimeout(() => setCopiedDeviceId(false), 2000);
    } catch {}
  };

  const handleCopyRequestCode = async () => {
    try {
      await navigator.clipboard.writeText(requestCode);
      setCopiedRequestCode(true);
      setTimeout(() => setCopiedRequestCode(false), 2000);
    } catch {}
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const clean = tokenInput.trim();
    if (!clean) {
      setError('يرجى لصق كود تفعيل الترخيص أولاً.');
      return;
    }

    setIsVerifying(true);
    const res = await licenseService.verifyAndStoreLicense(clean);
    setIsVerifying(false);

    if (res.success) {
      onActivationSuccess();
    } else {
      setError(res.error || 'فشل التحقق من كود الترخيص. تأكد من صحة الكود ومطابقته لهذا الجهاز.');
    }
  };

  const handleTrialBypass = () => {
    // Strictly allowed ONLY when LICENSE_ENFORCEMENT is false
    if (!LICENSE_ENFORCEMENT) {
      licenseService.enableTrialBypass();
      onActivationSuccess();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4 font-sans select-none" dir="rtl">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full shadow-2xl p-6 sm:p-8 space-y-6 text-right relative">
        {/* Header */}
        <div className="text-center pb-3 border-b border-slate-800 space-y-2">
          <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto text-emerald-400">
            <Key className="w-7 h-7" />
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white">
            تفعيل ترخيص النظام
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 font-medium leading-relaxed">
            أرسل كود الطلب لمزوّد النظام واستلم كود التفعيل
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="p-3 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-300 text-xs sm:text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Device and Request Code */}
        <div className="space-y-3 bg-slate-950/70 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Laptop className="w-4 h-4 text-emerald-400" />
              <span>معرّف الجهاز:</span>
            </span>
            <button
              type="button"
              onClick={handleCopyDeviceId}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono font-bold flex items-center gap-1 cursor-pointer transition-colors"
            >
              {copiedDeviceId ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedDeviceId ? 'تم النسخ' : 'نسخ'}</span>
            </button>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg py-1.5 px-3 font-mono text-xs text-emerald-400 truncate text-left" dir="ltr">
            {deviceId}
          </div>

          <div className="pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <FileCheck className="w-4 h-4 text-emerald-400" />
                <span>كود طلب الترخيص:</span>
              </span>
              <button
                type="button"
                onClick={handleCopyRequestCode}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
              >
                {copiedRequestCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedRequestCode ? 'تم نسخ كود الطلب' : 'نسخ كود الطلب'}</span>
              </button>
            </div>
            <textarea
              readOnly
              rows={2}
              value={requestCode}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 font-mono text-[11px] text-slate-300 resize-none focus:outline-none text-left"
              dir="ltr"
            />
          </div>
        </div>

        {/* Step 2: Activation Code Input */}
        <form onSubmit={handleActivate} className="space-y-3">
          <div>
            <label className="text-xs font-bold text-slate-300 block mb-1.5">
              الصق كود التفعيل المستلم من المزوّد:
            </label>
            <textarea
              rows={3}
              required
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="ey... (ضع كود التفعيل هنا)"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-left resize-none"
              dir="ltr"
            />
          </div>

          <button
            type="submit"
            disabled={isVerifying}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-black text-sm rounded-xl shadow-lg shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-98"
          >
            <Key className="w-4 h-4" />
            <span>{isVerifying ? 'جاري التحقق من التوقيع...' : 'تفعيل الترخيص'}</span>
          </button>
        </form>

        {/* Optional Trial Bypass Button (ONLY when LICENSE_ENFORCEMENT == false) */}
        {!LICENSE_ENFORCEMENT && (
          <div className="pt-2 border-t border-slate-800 text-center">
            <button
              type="button"
              onClick={handleTrialBypass}
              className="w-full py-2.5 bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700/80 rounded-xl text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
            >
              <PlayCircle className="w-4 h-4 text-emerald-400" />
              <span>المتابعة بدون ترخيص (وضع التجربة)</span>
            </button>
            <p className="text-[10px] text-slate-500 mt-1.5">
              متاح حالياً أثناء وضع التطوير التجريبي فقط
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
