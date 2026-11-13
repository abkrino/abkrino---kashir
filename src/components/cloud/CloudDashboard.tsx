import React, { useState, useEffect } from 'react';
import { cloudService } from '../../services/cloudService';
import { storage } from '../../services/storageService';
import { 
  CloudBackupItem, 
  CloudSettings,
  User 
} from '../../types';
import { 
  Cloud, 
  CloudCheck, 
  RefreshCw, 
  ShieldCheck, 
  Sliders, 
  CheckCircle2, 
  Download, 
  Upload, 
  Trash2, 
  Database, 
  Check, 
  X, 
  Store, 
  Mail, 
  KeyRound, 
  Building2, 
  Layers, 
  Sparkles,
  Lock,
  Wifi,
  WifiOff,
  UserCheck,
  AlertTriangle,
  Clock,
  Activity
} from 'lucide-react';
import { orgSyncService, SyncState } from '../../services/orgSyncService';
import { auth } from '../../services/cloudService';

interface CloudDashboardProps {
  currentUser: User;
  onRefreshAll: () => void;
  onNavigateTab?: (tab: string) => void;
}

export const CloudDashboard: React.FC<CloudDashboardProps> = ({
  currentUser,
  onRefreshAll,
  onNavigateTab,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'ACCOUNT_LOGIN' | 'BACKUPS' | 'SETTINGS'>('ACCOUNT_LOGIN');
  
  // Cloud service reactive state
  const [isOnline, setIsOnline] = useState<boolean>(cloudService.isOnline());
  const [isSyncing, setIsSyncing] = useState<boolean>(cloudService.isSyncing());
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>(cloudService.getCloudSettings());
  const [cloudBackups, setCloudBackups] = useState<CloudBackupItem[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(cloudService.isUserAuthenticated());
  const [linkedStore, setLinkedStore] = useState(cloudService.getLinkedStore());

  // Organization Sync Reactive State
  const [syncState, setSyncState] = useState<SyncState>(orgSyncService.getSyncState());
  const [lastHeartbeat, setLastHeartbeat] = useState<Date | null>(orgSyncService.getLastHeartbeatDate());
  const [lastSummary, setLastSummary] = useState<Date | null>(orgSyncService.getLastDailySummaryDate());
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(orgSyncService.getStatusMessage());
  const [orgContext, setOrgContext] = useState(orgSyncService.getContext());
  const [firebaseUser, setFirebaseUser] = useState(auth.currentUser);

  // Email & Password Login Form State
  const [emailInput, setEmailInput] = useState<string>(cloudService.getLinkedStore().ownerEmail || '');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [authOfflineBanner, setAuthOfflineBanner] = useState<boolean>(false);

  // Backup states
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isRestoringBackupId, setIsRestoringBackupId] = useState<string | null>(null);
  const [isCreatingBackup, setIsCreatingBackup] = useState<boolean>(false);
  const [manualBackupNote, setManualBackupNote] = useState<string>('');

  const loadAllCloudData = async () => {
    setIsOnline(cloudService.isOnline());
    setIsSyncing(cloudService.isSyncing());
    setCloudSettings(cloudService.getCloudSettings());
    setIsAuthenticated(cloudService.isUserAuthenticated());
    setLinkedStore(cloudService.getLinkedStore());
    setSyncState(orgSyncService.getSyncState());
    setLastHeartbeat(orgSyncService.getLastHeartbeatDate());
    setLastSummary(orgSyncService.getLastDailySummaryDate());
    setSyncStatusMsg(orgSyncService.getStatusMessage());
    setOrgContext(orgSyncService.getContext());
    setFirebaseUser(auth.currentUser);

    const backups = await cloudService.getCloudBackupsList();
    setCloudBackups(backups);
  };

  useEffect(() => {
    loadAllCloudData();
    const unsubscribe = cloudService.subscribe(() => {
      loadAllCloudData();
    });
    const unsubscribeOrg = orgSyncService.subscribe(() => {
      setSyncState(orgSyncService.getSyncState());
      setLastHeartbeat(orgSyncService.getLastHeartbeatDate());
      setLastSummary(orgSyncService.getLastDailySummaryDate());
      setSyncStatusMsg(orgSyncService.getStatusMessage());
      setOrgContext(orgSyncService.getContext());
      setFirebaseUser(auth.currentUser);
    });
    return () => {
      unsubscribe();
      unsubscribeOrg();
    };
  }, []);

  // Handle Store Login for Sync (Strictly signInWithEmailAndPassword, no password storage, UID must match orgId)
  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthenticating(true);
    setStatusMessage({ type: 'info', text: 'جاري تسجيل دخول المحل والتحقق من ترخيص الجهاز...' });

    const res = await orgSyncService.signInStore(emailInput, passwordInput);
    setIsAuthenticating(false);

    if (res.success) {
      setPasswordInput('');
      setStatusMessage({ 
        type: 'success', 
        text: 'تم تسجيل دخول المحل للمزامنة بنجاح ومطابقة ترخيص الجهاز!' 
      });
      onRefreshAll();
    } else {
      setStatusMessage({ 
        type: 'error', 
        text: res.error || 'فشل تسجيل الدخول للمزامنة.' 
      });
    }
  };

  const handleSignOutStore = async () => {
    await orgSyncService.signOutStore();
    setStatusMessage({ type: 'info', text: 'تم تسجيل الخروج من جلسة المزامنة السحابية.' });
    onRefreshAll();
  };

  // Handle Manual Immediate Sync
  const handleTriggerSync = async () => {
    setStatusMessage({ type: 'info', text: 'جاري المزامنة الشاملة مع الكلود...' });
    const res = await cloudService.syncLocalToCloud(false);
    if (res.success) {
      setStatusMessage({ 
        type: 'success', 
        text: 'تمت مزامنة جميع الفواتير والأصناف والعملاء والدرج مع الكلود بنجاح.' 
      });
      loadAllCloudData();
      onRefreshAll();
    } else {
      setStatusMessage({ 
        type: 'error', 
        text: `فشلت المزامنة: ${res.error}. تم حفظ العمليات محلياً وسيتم الرفع فور استقرار الشبكة.` 
      });
    }
  };

  // Handle Create Cloud Backup
  const handleCreateCloudBackup = async () => {
    setIsCreatingBackup(true);
    const res = await cloudService.createManualCloudBackup(manualBackupNote);
    setIsCreatingBackup(false);
    if (res.success && res.backup) {
      setManualBackupNote('');
      setStatusMessage({ 
        type: 'success', 
        text: `تم حفظ نسخة جديدة مؤمنة بالكامل على الكلود بنجاح (${res.backup.dateStr} - ${res.backup.timeStr}).` 
      });
      const list = await cloudService.getCloudBackupsList();
      setCloudBackups(list);
    } else {
      setStatusMessage({ type: 'error', text: res.error || 'فشل حفظ النسخة على الكلود.' });
    }
  };

  // Handle Restore from Cloud Backup
  const handleRestoreCloudBackup = async (backupId: string) => {
    if (!window.confirm('تحذير أمان: هل أنت متأكد من استرجاع هذه النسخة من الكلود؟ سيتم تحديث قاعدة البيانات المحلية بالأصناف والفواتير المحفوظة في هذه النسخة.')) {
      return;
    }

    setIsRestoringBackupId(backupId);
    const res = await cloudService.restoreFromCloudBackup(backupId);
    setIsRestoringBackupId(null);

    if (res.success) {
      setStatusMessage({ 
        type: 'success', 
        text: 'تمت استعادة النسخة السحابية بنجاح وتحديث كافة الأرصدة والفواتير!' 
      });
      onRefreshAll();
    } else {
      setStatusMessage({ type: 'error', text: res.error || 'فشلت استعادة النسخة السحابية.' });
    }
  };

  // Handle Delete Cloud Backup
  const handleDeleteCloudBackup = async (backupId: string) => {
    if (!window.confirm('هل تريد بالتأكيد حذف هذه النسخة السحابية؟')) return;
    await cloudService.deleteCloudBackup(backupId);
    const list = await cloudService.getCloudBackupsList();
    setCloudBackups(list);
    setStatusMessage({ type: 'info', text: 'تم حذف النسخة المحددة من السحابة.' });
  };

  // Local Device Backup Export
  const handleDownloadLocalJsonBackup = () => {
    const jsonStr = storage.exportFullBackupJson();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Supermarket_Local_Backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage({ type: 'success', text: 'تم تحميل نسخة الجهاز المحلية (ملف JSON) بنجاح.' });
  };

  // Local Device Backup Restore
  const handleUploadLocalJsonBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const res = storage.restoreBackupJson(content);
        if (res.success) {
          setStatusMessage({ type: 'success', text: 'تمت استعادة النسخة من ملف الجهاز بنجاح!' });
          onRefreshAll();
        } else {
          setStatusMessage({ type: 'error', text: res.error || 'الملف غير صالح للاستعادة.' });
        }
      } catch {
        setStatusMessage({ type: 'error', text: 'حدث خطأ أثناء قراءة ملف النسخة الاحتياطية.' });
      }
    };
    reader.readAsText(file);
  };

  // Toggle Auto Sync on Action in Settings
  const handleToggleAutoSync = (enabled: boolean) => {
    const updated = { ...cloudSettings, autoSyncOnAction: enabled };
    cloudService.saveCloudSettings(updated);
    setCloudSettings(updated);
    setStatusMessage({
      type: 'success',
      text: enabled 
        ? 'تم تفعيل الحفظ التلقائي على السحابة بعد كل عملية (فاتورة / سداد / حركة نقدية).' 
        : 'تم تعطيل الحفظ التلقائي. يمكنك المزامنة يدوياً في أي وقت.'
    });
  };

  return (
    <div className="space-y-5" dir="rtl">
      {/* Top Hero Banner */}
      <div className="bg-gradient-to-r from-emerald-800 via-teal-800 to-slate-900 text-white rounded-2xl p-5 sm:p-6 shadow-xl border border-emerald-600/40 relative overflow-hidden">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 relative z-10">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="p-2 bg-white/10 backdrop-blur-md rounded-xl text-emerald-300">
                <Cloud className="w-6 h-6 animate-pulse" />
              </span>
              <h2 className="text-xl sm:text-2xl font-black tracking-wide">
                مركز إدارة وتشغيل المزامنة السحابية
              </h2>
              <span className="bg-emerald-500/30 text-emerald-200 border border-emerald-400/40 text-xs px-3 py-1 rounded-full font-mono font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`}></span>
                {isOnline ? 'السحابة متصلة ومؤمنة ✓' : 'الوضع المحلي (أوفلاين)'}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-emerald-100/90 font-medium max-w-2xl leading-relaxed">
              إدارة حساب المالك، ربط المحل والفرع، وحالة الاشتراك الفعلية والنسخ السحابي والمحلي.
            </p>
          </div>

          {/* Quick Header Actions */}
          <div className="flex items-center gap-2.5 flex-wrap w-full lg:w-auto justify-end">
            <button
              type="button"
              onClick={handleTriggerSync}
              disabled={isSyncing || !isOnline}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs sm:text-sm font-black rounded-xl cursor-pointer shadow-md flex items-center gap-2 transition-all active:scale-95"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'جاري المزامنة...' : 'المزامنة السحابية الآن'}</span>
            </button>

            <div className="bg-white/10 backdrop-blur-md px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 border border-white/20">
              <div className={`w-2.5 h-2.5 rounded-full ${linkedStore.ownerEmail ? 'bg-emerald-400' : 'bg-amber-400'}`}></div>
              <span className="font-mono">{linkedStore.ownerEmail || 'غير مرتبط بحساب'}</span>
            </div>
          </div>
        </div>

        {/* Store & License Quick Badge Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-5 pt-4 border-t border-white/15 text-xs">
          <div className="bg-white/10 backdrop-blur-md p-2.5 rounded-xl flex items-center gap-2.5">
            <Store className="w-5 h-5 text-emerald-300 shrink-0" />
            <div>
              <span className="text-emerald-200 block text-[11px]">المحل المربوط بالحساب:</span>
              <span className="font-bold text-xs text-white block mt-0.5">{linkedStore.storeName}</span>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md p-2.5 rounded-xl flex items-center gap-2.5">
            <Building2 className="w-5 h-5 text-cyan-300 shrink-0" />
            <div>
              <span className="text-emerald-200 block text-[11px]">الفرع / المنشأة:</span>
              <span className="font-bold text-xs text-white block mt-0.5">
                {linkedStore.branchName || linkedStore.chainName}
              </span>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md p-2.5 rounded-xl flex items-center gap-2.5">
            <Layers className="w-5 h-5 text-amber-300 shrink-0" />
            <div>
              <span className="text-emerald-200 block text-[11px]">الباقة وحالة الاشتراك:</span>
              <span className="font-bold text-xs text-white block mt-0.5">
                {linkedStore.subscriptionPlan} — {linkedStore.subscriptionStatusLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Status Message Alert */}
      {statusMessage && (
        <div className={`p-3.5 rounded-2xl text-xs sm:text-sm font-bold flex items-center justify-between shadow-xs border transition-all ${
          statusMessage.type === 'success' 
            ? 'bg-emerald-50 dark:bg-emerald-950/70 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' 
            : statusMessage.type === 'error'
            ? 'bg-rose-50 dark:bg-rose-950/70 border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200'
            : 'bg-blue-50 dark:bg-blue-950/70 border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-200'
        }`}>
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
            {statusMessage.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />}
            {statusMessage.type === 'info' && <RefreshCw className="w-4 h-4 text-blue-600 animate-spin shrink-0" />}
            <span>{statusMessage.text}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Navigation Sub-Tabs (Clean & Focused on Authentication, Dual Backups, and Settings) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-1.5 rounded-2xl shadow-xs no-scrollbar">
        {[
          { id: 'ACCOUNT_LOGIN', label: 'المصادقة وربط المحل (إيميل وباسورد)', icon: Mail },
          { id: 'BACKUPS', label: 'النسخ السحابية والمحلية والاسترداد', icon: Database, badge: `${cloudBackups.length}` },
          { id: 'SETTINGS', label: 'إعدادات السحابة والمزامنة التلقائية', icon: Sliders },
        ].map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveSubTab(tab.id as any)}
            className={`px-4 py-2.5 rounded-xl text-xs font-black cursor-pointer transition-all flex items-center gap-2 shrink-0 ${
              activeSubTab === tab.id
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span>{tab.label}</span>
            {tab.badge && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                activeSubTab === tab.id ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200'
              }`}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* --- 1. AUTHENTICATION: EMAIL & PASSWORD LOGIN & STORE/CHAIN LINKING --- */}
      {activeSubTab === 'ACCOUNT_LOGIN' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Email & Password Login Window */}
          <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Lock className="w-5 h-5 text-emerald-600" />
                <span>تسجيل دخول حساب المالك (إيميل وباسورد)</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                نافذة تسجيل الدخول للمحل المربوط. يتم ربط هذا الإيميل بالمحل وسلسلة المحلات للاشتراك في أي باقة موحدة.
              </p>
            </div>

            <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1">
                  البريد الإلكتروني المعتمد للمحل / سلسلة المحلات:
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute right-3.5 top-3 pointer-events-none" />
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    required
                    placeholder="name@example.com"
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl pr-10 pl-3 py-2.5 text-xs sm:text-sm font-bold text-slate-900 dark:text-white font-mono focus:outline-none focus:border-emerald-500 shadow-inner"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1">
                  كلمة المرور:
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute right-3.5 top-3 pointer-events-none" />
                  <input
                    type="password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    required
                    placeholder="اكتب كلمة المرور..."
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl pr-10 pl-3 py-2.5 text-xs sm:text-sm font-bold text-slate-900 dark:text-white font-mono focus:outline-none focus:border-emerald-500 shadow-inner"
                  />
                </div>
              </div>

              {/* Offline Resilience Note */}
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-xl text-xs space-y-1">
                <span className="font-black text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
                  <Wifi className="w-4 h-4 text-emerald-600" />
                  <span>دخول بالإنترنت أول مرة فقط:</span>
                </span>
                <p className="text-emerald-800 dark:text-emerald-300 text-[11px] leading-relaxed">
                  يلزم الاتصال بالإنترنت عند تسجيل الدخول للمرة الأولى لتفعيل الحساب ومطابقة المحل، وبعد ذلك يتم حفظ جلسة الحساب وبيانات المحل في نسخة محلية على هذا الجهاز ليعمل الكاشير بالكامل بدون نت (أوفلاين).
                </p>
              </div>

              {firebaseUser && (
                <div className="flex items-center justify-between p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-xl text-xs">
                  <div>
                    <span className="text-emerald-900 dark:text-emerald-200 font-bold block">جلسة الدخول النشطة للمزامنة:</span>
                    <span className="font-mono text-emerald-700 dark:text-emerald-300 font-black">{firebaseUser.email}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleSignOutStore}
                    className="px-3 py-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-bold cursor-pointer transition-colors"
                  >
                    تسجيل الخروج
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={isAuthenticating}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black rounded-xl text-xs sm:text-sm cursor-pointer shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{isAuthenticating ? 'جاري التحقق والمصادقة...' : 'تسجيل دخول المحل للمزامنة'}</span>
              </button>
            </form>
          </div>

          {/* Linked Store & Chain Architecture Details Card */}
          <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Store className="w-5 h-5 text-blue-600" />
                <span>حالة المزامنة السحابية ومعلومات الترخيص</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                متابعة الاتصال اللحظي ونبضات الفروع والملخص اليومي المشفر
              </p>
            </div>

            <div className="space-y-3 text-xs">
              {/* 1. Login Status */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400">حالة الدخول:</span>
                <span className={`font-bold ${firebaseUser ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {firebaseUser ? `مسجل دخول (${firebaseUser.email})` : 'غير مسجل دخول للمزامنة'}
                </span>
              </div>

              {/* 2. Last Successful Heartbeat */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-blue-500" />
                  <span>وقت آخر نبضة اتصال ناجحة:</span>
                </span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  {lastHeartbeat ? lastHeartbeat.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'لم تُرسل بعد'}
                </span>
              </div>

              {/* 3. Last Daily Summary */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-emerald-500" />
                  <span>وقت آخر ملخص يومي (بتوقيت القاهرة):</span>
                </span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  {lastSummary ? lastSummary.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'لم يُرفع بعد'}
                </span>
              </div>

              {/* 4. Sync State Badge */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400">حالة المزامنة:</span>
                <span className={`px-2.5 py-0.5 rounded-full font-bold text-[11px] border ${
                  syncState === 'synced'
                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-300'
                    : syncState === 'syncing'
                    ? 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300'
                    : syncState === 'subscription-paused'
                    ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border-rose-300'
                    : syncState === 'wrong-account'
                    ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border-rose-300'
                    : syncState === 'offline'
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-300 border-slate-300'
                    : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300'
                }`}>
                  {syncState === 'synced' ? 'متزامن بنجاح ✓' :
                   syncState === 'syncing' ? 'جاري المزامنة...' :
                   syncState === 'subscription-paused' ? 'تم إيقاف المزامنة: الاشتراك منتهٍ' :
                   syncState === 'wrong-account' ? 'الحساب لا يطابق ترخيص الجهاز' :
                   syncState === 'offline' ? 'أوفلاين (محلي)' :
                   syncState === 'no-license' ? 'لا يوجد ترخيص سارٍ' : 'يلزم تسجيل الدخول'}
                </span>
              </div>

              {/* Linked Store & Branch from Context */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400">المحل المربوط بالترخيص:</span>
                <span className="font-black text-slate-900 dark:text-white">
                  {orgContext ? `المنشأة: ${orgContext.orgId} • الفرع: ${orgContext.branchId}` : linkedStore.storeName}
                </span>
              </div>
            </div>

            <div className="p-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800 rounded-xl text-blue-900 dark:text-blue-200 text-xs">
              <span className="font-black block mb-0.5">جاهزية التوسع لسلسلة الفروع:</span>
              <p className="text-[11px] leading-relaxed text-blue-800 dark:text-blue-300">
                تمت هندسة قاعدة البيانات لتمكين ربط فروع أخرى أو مستودعات متعددة تحت مظلة نفس الإيميل المعتمد عند إعداد باقات الاشتراك المشتركة.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* --- 2. DUAL BACKUP & RESTORE ("امكانية استرداد أي نسخة محفوظة سواء علي الكلود او علي الجهاز") --- */}
      {activeSubTab === 'BACKUPS' && (
        <div className="space-y-5">
          {/* Create Backup Action Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-4 rounded-2xl shadow-xs flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="flex-1 w-full">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1">
                حفظ نسخة احتياطية فورية على السحابة:
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualBackupNote}
                  onChange={(e) => setManualBackupNote(e.target.value)}
                  placeholder="وصف اختياري للنسخة (مثلاً: قبل الجرد أو نهاية الوردية)..."
                  className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={handleCreateCloudBackup}
                  disabled={isCreatingBackup}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black text-xs rounded-xl cursor-pointer flex items-center gap-1.5 shadow-xs shrink-0"
                >
                  <CloudCheck className="w-4 h-4" />
                  <span>{isCreatingBackup ? 'جاري الحفظ...' : 'حفظ على السحابة الآن'}</span>
                </button>
              </div>
            </div>

            {/* Local Device Options */}
            <div className="flex items-center gap-2 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-200 dark:border-slate-800 w-full md:w-auto justify-end">
              <button
                type="button"
                onClick={handleDownloadLocalJsonBackup}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-bold flex items-center gap-1.5 border border-slate-300 dark:border-slate-700 cursor-pointer"
                title="تحميل نسخة احتياطية بصيغة ملف على جهاز الكمبيوتر / الموبايل"
              >
                <Download className="w-4 h-4 text-emerald-600" />
                <span>تحميل نسخة للجهاز</span>
              </button>

              <label className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-bold flex items-center gap-1.5 border border-slate-300 dark:border-slate-700 cursor-pointer">
                <Upload className="w-4 h-4 text-blue-600" />
                <span>استعادة ملف من الجهاز</span>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleUploadLocalJsonBackup}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Cloud Backups List */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl shadow-xs overflow-hidden">
            <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-600" />
                <h3 className="text-xs sm:text-sm font-black text-slate-900 dark:text-white">
                  سجل النسخ الاحتياطية المحفوظة سحابياً ({cloudBackups.length})
                </h3>
              </div>
              <span className="text-[11px] text-slate-500">
                يمكن استرجاع أي نسخة بضغطة زر واحدة
              </span>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[460px] overflow-y-auto">
              {cloudBackups.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  لا توجد نسخ احتياطية سحابية حتى الآن. اضغط "حفظ على السحابة الآن" لإنشاء أول نسخة.
                </div>
              ) : (
                cloudBackups.map(backup => (
                  <div
                    key={backup.id}
                    className="p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white">
                          نسخة: {backup.dateStr} - {backup.timeStr}
                        </span>
                        <span className="text-[10px] bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 px-2 py-0.5 rounded-full font-mono font-bold">
                          السحابة ✓
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-3 flex-wrap">
                        <span>{backup.itemCounts.products} صنف</span>
                        <span>•</span>
                        <span>{backup.itemCounts.invoices} فاتورة</span>
                        <span>•</span>
                        <span>{backup.itemCounts.customers} عميل</span>
                        <span>•</span>
                        <span>بواسطة: {backup.createdBy}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                      <button
                        type="button"
                        onClick={() => handleRestoreCloudBackup(backup.id)}
                        disabled={isRestoringBackupId === backup.id}
                        className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-black cursor-pointer shadow-xs flex items-center gap-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isRestoringBackupId === backup.id ? 'animate-spin' : ''}`} />
                        <span>{isRestoringBackupId === backup.id ? 'جاري الاسترجاع...' : 'استرجاع هذه النسخة'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteCloudBackup(backup.id)}
                        className="p-2 text-slate-400 hover:text-rose-600 cursor-pointer rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/50"
                        title="حذف النسخة من السحابة"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- 3. CLOUD SETTINGS ("طريقة حفظ النسخة على السحابة بعد كل عملية يتم ضبطها من الاعدادات") --- */}
      {activeSubTab === 'SETTINGS' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-5 shadow-xs space-y-4">
          <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
            <Sliders className="w-4 h-4 text-emerald-600" />
            <span>إعدادات المزامنة السحابية التلقائية</span>
          </h3>

          <div className="space-y-4">
            {/* Setting 1: Auto Sync on Action */}
            <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800">
              <div className="space-y-0.5">
                <span className="text-xs sm:text-sm font-black text-slate-900 dark:text-white block">
                  حفظ نسخة على السحابة بعد كل عملية تلقائياً
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 block">
                  عند إصدار كل فاتورة مبيعات، تسجيل مصروف، أو تحصيل نقدية، يتم حفظ التعديلات على الجهاز وفوراً على السحابة.
                </span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mr-3">
                <input
                  type="checkbox"
                  checked={cloudSettings.autoSyncOnAction}
                  onChange={(e) => handleToggleAutoSync(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-slate-600 peer-checked:bg-emerald-600"></div>
              </label>
            </div>

            {/* Setting 2: Primary Account Email & Linked Store */}
            <div className="p-3.5 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
              <span className="text-xs sm:text-sm font-black text-slate-900 dark:text-white block">
                الإيميل الأساسي المعتمد للمحل:
              </span>
              <span className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400 block">
                {linkedStore.ownerEmail || 'غير مرتبط بحساب بريد بعد'}
              </span>
              <p className="text-[11px] text-slate-500">
                يلزم الاتصال بالإنترنت أول مرة فقط لتسجيل هذا الحساب، ثم يتم تخزين البيانات محلياً على الجهاز ليعمل الكاشير بالكامل بدون إنترنت.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
