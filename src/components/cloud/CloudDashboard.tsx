import React, { useState, useEffect } from 'react';
import { cloudService } from '../../services/cloudService';
import { storage } from '../../services/storageService';
import { 
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
import { licenseService } from '../../services/licenseService';
import {
  cloudBackupService,
  CloudBackupSummary,
  CloudRestoreDownloadProgress,
} from '../../services/cloudBackupService';
import { cloudBudgetService, CloudBudgetStatus } from '../../services/cloudBudgetService';
import { BackupPreview } from '../../services/snapshotService';

interface CloudDashboardProps {
  currentUser: User;
  onRefreshAll: () => void;
  onNavigateTab?: (tab: string) => void;
}

interface PendingCloudRestore {
  backup: CloudBackupSummary;
  preview: BackupPreview;
  warning?: string;
  validatedData: Record<string, any>;
}

export const CloudDashboard: React.FC<CloudDashboardProps> = ({
  currentUser,
  onRefreshAll,
  onNavigateTab,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'ACCOUNT_LOGIN' | 'BACKUPS' | 'SETTINGS'>('ACCOUNT_LOGIN');
  
  // Cloud service reactive state
  const [isCloudConfigured] = useState<boolean>(cloudService.isConfigured());
  const [isOnline, setIsOnline] = useState<boolean>(cloudService.isOnline());
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>(cloudService.getCloudSettings());
  const [cloudBackups, setCloudBackups] = useState<CloudBackupSummary[]>([]);
  const [lastBackupMeta, setLastBackupMeta] = useState<CloudBackupSummary | null>(
    () => cloudBackupService.getLastSuccessfulBackup()
  );
  const [backupDropAlert, setBackupDropAlert] = useState<string | null>(
    () => cloudBackupService.getDropAlert()
  );
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(cloudService.isUserAuthenticated());
  const [linkedStore, setLinkedStore] = useState(cloudService.getLinkedStore());

  // Organization Sync Reactive State
  const [syncState, setSyncState] = useState<SyncState>(orgSyncService.getSyncState());
  const [isSummaryDirty, setIsSummaryDirty] = useState<boolean>(() => orgSyncService.isSummaryDirty());
  const [lastHeartbeat, setLastHeartbeat] = useState<Date | null>(orgSyncService.getLastHeartbeatDate());
  const [lastSummary, setLastSummary] = useState<Date | null>(orgSyncService.getLastDailySummaryDate());
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(orgSyncService.getStatusMessage());
  const [lastSyncError, setLastSyncError] = useState<string | null>(orgSyncService.getLastError());
  const [orgContext, setOrgContext] = useState(
    () => orgSyncService.getStoredLicenseContext() || orgSyncService.getContext()
  );
  const [isCloudSummaryEnabled, setIsCloudSummaryEnabled] = useState<boolean>(
    () => licenseService.isFeatureEnabled('cloudSummary')
  );
  const [isCloudBackupEnabled, setIsCloudBackupEnabled] = useState<boolean>(
    () => licenseService.isFeatureEnabled('cloudBackup')
  );
  const [firebaseUser, setFirebaseUser] = useState(auth?.currentUser || null);
  const [budgetStatus, setBudgetStatus] = useState<CloudBudgetStatus>(() => cloudBudgetService.getStatus());

  // Email & Password Login Form State (password kept strictly in component memory, never persisted)
  const [emailInput, setEmailInput] = useState<string>(cloudService.getLinkedStore().ownerEmail || '');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Backup states
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState<boolean>(false);
  const [manualBackupNote, setManualBackupNote] = useState<string>('');

  // Cloud Restore Modal states (Admin only + store login required)
  const [isRestorePickerOpen, setIsRestorePickerOpen] = useState<boolean>(false);
  const [downloadingBackupId, setDownloadingBackupId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<CloudRestoreDownloadProgress | null>(null);
  const [pendingCloudRestore, setPendingCloudRestore] = useState<PendingCloudRestore | null>(null);
  const [isDoubleConfirmed, setIsDoubleConfirmed] = useState<boolean>(false);
  const [isApplyingRestore, setIsApplyingRestore] = useState<boolean>(false);

  const isAdminUser = currentUser.role === 'ADMIN';
  const isStoreSignedIn = orgSyncService.ensureSignedIn({ allowExpired: true }) === 'ok';

  const refreshLocalCloudState = () => {
    setIsOnline(cloudService.isOnline());
    setCloudSettings(cloudService.getCloudSettings());
    setIsAuthenticated(cloudService.isUserAuthenticated());
    setLinkedStore(cloudService.getLinkedStore());
    setSyncState(orgSyncService.getSyncState());
    setIsSummaryDirty(orgSyncService.isSummaryDirty());
    setLastHeartbeat(orgSyncService.getLastHeartbeatDate());
    setLastSummary(orgSyncService.getLastDailySummaryDate());
    setSyncStatusMsg(orgSyncService.getStatusMessage());
    setLastSyncError(orgSyncService.getLastError());
    setOrgContext(orgSyncService.getStoredLicenseContext() || orgSyncService.getContext());
    setIsCloudSummaryEnabled(licenseService.isFeatureEnabled('cloudSummary'));
    setIsCloudBackupEnabled(licenseService.isFeatureEnabled('cloudBackup'));
    setFirebaseUser(auth?.currentUser || null);
    setLastBackupMeta(cloudBackupService.getLastSuccessfulBackup());
    setBackupDropAlert(cloudBackupService.getDropAlert());
    setBudgetStatus(cloudBudgetService.getStatus());
  };

  const loadAllCloudData = async (options?: { bypassBudget?: boolean }) => {
    refreshLocalCloudState();

    if (isCloudConfigured && orgSyncService.ensureSignedIn({ allowExpired: true }) === 'ok' && cloudService.isOnline()) {
      setIsLoadingBackups(true);
      const listRes = await cloudBackupService.listCompleteBackups(options);
      setIsLoadingBackups(false);
      if (listRes.success) {
        setCloudBackups(listRes.backups);
        setLastBackupMeta(listRes.backups[0] || cloudBackupService.getLastSuccessfulBackup());
      }
    }
  };

  useEffect(() => {
    cloudBudgetService.init().then(() => {
      setBudgetStatus(cloudBudgetService.getStatus());
    }).catch(() => {});
    loadAllCloudData();
    const unsubscribe = cloudService.subscribe(() => {
      setIsOnline(cloudService.isOnline());
      setIsAuthenticated(cloudService.isUserAuthenticated());
      setLinkedStore(cloudService.getLinkedStore());
    });
    const unsubscribeOrg = orgSyncService.subscribe(() => {
      refreshLocalCloudState();
    });
    const unsubscribeLicense = licenseService.subscribe(() => {
      refreshLocalCloudState();
    });
    const unsubscribeBackup = cloudBackupService.subscribe(() => {
      setLastBackupMeta(cloudBackupService.getLastSuccessfulBackup());
      setBackupDropAlert(cloudBackupService.getDropAlert());
      setIsCreatingBackup(cloudBackupService.isUploadInProgress());
    });
    const unsubscribeBudget = cloudBudgetService.subscribe(() => {
      setBudgetStatus(cloudBudgetService.getStatus());
    });
    return () => {
      unsubscribe();
      unsubscribeOrg();
      unsubscribeLicense();
      unsubscribeBackup();
      unsubscribeBudget();
      setPasswordInput('');
    };
  }, []);

  // Handle Store Login for Sync (Strictly signInWithEmailAndPassword, no password storage, UID must match orgId)
  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCloudConfigured) {
      setStatusMessage({ type: 'error', text: 'السحابة غير مُعدّة بعد.' });
      return;
    }

    const submittedPassword = passwordInput;
    setPasswordInput('');
    setIsAuthenticating(true);
    setStatusMessage({ type: 'info', text: 'جاري تسجيل دخول المحل والتحقق من ترخيص الجهاز...' });

    const res = await orgSyncService.signInStore(emailInput, submittedPassword);
    setIsAuthenticating(false);

    if (res.success) {
      setStatusMessage({ 
        type: 'success', 
        text: 'تم تسجيل دخول المحل للمزامنة بنجاح ومطابقة ترخيص الجهاز!' 
      });
      await loadAllCloudData();
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
    setConnectionTestResult(null);
    setCloudBackups([]);
    setStatusMessage({ type: 'info', text: 'تم تسجيل الخروج من جلسة المزامنة السحابية.' });
    onRefreshAll();
  };

  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    setConnectionTestResult(null);
    const result = await orgSyncService.testConnection();
    setIsTestingConnection(false);
    setConnectionTestResult(result);
    setStatusMessage({
      type: result.success ? 'success' : 'error',
      text: result.message,
    });
  };

  // Handle Create Chunked Cloud Backup ("نسخ الآن")
  const handleCreateCloudBackup = async () => {
    setIsCreatingBackup(true);
    setStatusMessage({ type: 'info', text: 'جاري ضغط وتجهيز النسخة الاحتياطية ورفعها إلى السحابة...' });
    const res = await cloudBackupService.createAndUploadBackup('manual', manualBackupNote);
    setIsCreatingBackup(false);
    if (res.success && res.backup) {
      setManualBackupNote('');
      setStatusMessage({ 
        type: 'success', 
        text: `تم رفع النسخة السحابية بنجاح (${res.backup.totalChunks} قطعة — ${(res.backup.sizeBytes / 1024).toFixed(1)} ك.ب).` 
      });
      await loadAllCloudData();
    } else if (res.success && res.skipped) {
      setStatusMessage({
        type: 'info',
        text: res.message || 'لا توجد تغييرات في البيانات منذ آخر نسخة سحابية ناجحة.',
      });
    } else {
      setStatusMessage({ type: 'error', text: res.error || 'فشل رفع النسخة إلى السحابة.' });
    }
  };

  // Start Download & Preview for Cloud Restore (Admin only + store login)
  const handleStartCloudRestore = async (backup: CloudBackupSummary) => {
    if (!isAdminUser) {
      setStatusMessage({ type: 'error', text: 'غير مصرح: استعادة النسخة السحابية مقتصرة على مدير النظام فقط.' });
      return;
    }
    if (orgSyncService.ensureSignedIn({ allowExpired: true }) !== 'ok') {
      setStatusMessage({ type: 'error', text: 'يجب تسجيل دخول المحل للسحابة أولاً قبل الاستعادة.' });
      return;
    }

    setDownloadingBackupId(backup.id);
    setDownloadProgress({ loadedChunks: 0, totalChunks: backup.totalChunks || 1, percent: 0 });
    setPendingCloudRestore(null);
    setIsDoubleConfirmed(false);

    const res = await cloudBackupService.downloadAndValidateBackup(backup.id, (prog) => {
      setDownloadProgress(prog);
    });

    setDownloadingBackupId(null);
    setDownloadProgress(null);

    if (!res.success || !res.preview || !res.validatedData) {
      setStatusMessage({
        type: 'error',
        text: res.error || 'فشل تنزيل أو التحقق من سلامة النسخة السحابية.',
      });
      return;
    }

    setIsRestorePickerOpen(false);
    setPendingCloudRestore({
      backup,
      preview: res.preview,
      warning: res.warning,
      validatedData: res.validatedData,
    });
  };

  // Open "استعادة من السحابة" modal or switch & load list
  const handleOpenRestoreFromCloud = async () => {
    if (!isAdminUser) {
      setStatusMessage({ type: 'error', text: 'غير مصرح: استعادة النسخة السحابية مقتصرة على مدير النظام فقط.' });
      return;
    }
    if (orgSyncService.ensureSignedIn({ allowExpired: true }) !== 'ok') {
      setStatusMessage({ type: 'error', text: 'يجب تسجيل دخول المحل للسحابة أولاً قبل الاستعادة.' });
      setActiveSubTab('ACCOUNT_LOGIN');
      return;
    }
    setIsRestorePickerOpen(true);
    await loadAllCloudData({ bypassBudget: true });
  };

  // Execute transactional cloud restore + force post-restore password setup
  const handleConfirmExecuteCloudRestore = async () => {
    if (!pendingCloudRestore || !isDoubleConfirmed || !isAdminUser) return;
    setIsApplyingRestore(true);

    const dateLabel = new Date(pendingCloudRestore.backup.createdAtMs).toLocaleString('ar-EG');
    const res = await cloudBackupService.executeCloudRestore(
      pendingCloudRestore.validatedData,
      `النسخة السحابية (${dateLabel})`
    );

    setIsApplyingRestore(false);
    if (res.success) {
      setPendingCloudRestore(null);
      setIsDoubleConfirmed(false);
      setStatusMessage({
        type: 'success',
        text: 'تمت استعادة البيانات من السحابة بنجاح! يرجى تعيين كلمة مرور جديدة للمدير.',
      });
      onRefreshAll();
    } else {
      setStatusMessage({
        type: 'error',
        text: res.error || 'فشلت عملية الاستعادة من السحابة.',
      });
    }
  };

  // Handle Delete Cloud Backup (never allows deleting the latest complete backup)
  const handleDeleteCloudBackup = async (backupId: string) => {
    const res = await cloudBackupService.deleteCloudBackup(backupId);
    if (res.success) {
      setStatusMessage({ type: 'info', text: 'تم حذف النسخة المحددة من السحابة.' });
      await loadAllCloudData();
    } else {
      setStatusMessage({ type: 'error', text: res.error || 'تعذر حذف النسخة السحابية.' });
    }
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
                <span className={`w-2 h-2 rounded-full ${!isCloudConfigured ? 'bg-slate-300' : isOnline ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`}></span>
                {!isCloudConfigured
                  ? 'السحابة غير مُعدّة بعد'
                  : isOnline
                  ? (isAuthenticated ? 'السحابة متصلة ومؤمنة ✓' : 'متصل بالإنترنت — بانتظار تسجيل الدخول')
                  : 'الوضع المحلي (أوفلاين)'}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-emerald-100/90 font-medium max-w-2xl leading-relaxed">
              إدارة حساب المحل للمزامنة، ربط المنشأة والفرع بالترخيص، واختبار الاتصال ومتابعة النبضات والملخص اليومي.
            </p>
          </div>

          {/* Quick Header Actions */}
          <div className="flex items-center gap-2.5 flex-wrap w-full lg:w-auto justify-end">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={!isCloudConfigured || isTestingConnection || !isOnline}
              className="px-4 py-2.5 bg-white text-emerald-900 hover:bg-emerald-50 disabled:opacity-50 text-xs sm:text-sm font-black rounded-xl cursor-pointer shadow-md flex items-center gap-2 transition-all active:scale-95"
            >
              <Activity className={`w-4 h-4 ${isTestingConnection ? 'animate-spin' : ''}`} />
              <span>{isTestingConnection ? 'جاري اختبار الاتصال...' : 'اختبار الاتصال'}</span>
            </button>

            <button
              type="button"
              onClick={handleCreateCloudBackup}
              disabled={!isCloudConfigured || !isCloudBackupEnabled || isCreatingBackup || !isOnline || !isStoreSignedIn}
              title={!isCloudBackupEnabled ? 'غير مضمّن في باقتك' : undefined}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs sm:text-sm font-black rounded-xl cursor-pointer shadow-md flex items-center gap-2 transition-all active:scale-95"
            >
              <CloudCheck className={`w-4 h-4 ${isCreatingBackup ? 'animate-spin' : ''}`} />
              <span>
                {!isCloudBackupEnabled
                  ? 'غير مضمّن في باقتك'
                  : isCreatingBackup
                  ? 'جاري النسخ...'
                  : 'نسخ الآن'}
              </span>
            </button>

            {isAdminUser && (
              <button
                type="button"
                onClick={handleOpenRestoreFromCloud}
                disabled={!isCloudConfigured || !isOnline || !isStoreSignedIn}
                className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs sm:text-sm font-black rounded-xl cursor-pointer shadow-md flex items-center gap-2 transition-all active:scale-95"
              >
                <Download className="w-4 h-4" />
                <span>استعادة من السحابة</span>
              </button>
            )}

            <div className="bg-white/10 backdrop-blur-md px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 border border-white/20">
              <div className={`w-2.5 h-2.5 rounded-full ${firebaseUser?.email ? 'bg-emerald-400' : 'bg-amber-400'}`}></div>
              <span className="font-mono">{firebaseUser?.email || 'غير مسجّل'}</span>
            </div>
          </div>
        </div>

        {/* Store & License Quick Badge Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-5 pt-4 border-t border-white/15 text-xs">
          <div className="bg-white/10 backdrop-blur-md p-2.5 rounded-xl flex items-center gap-2.5">
            <Store className="w-5 h-5 text-emerald-300 shrink-0" />
            <div className="min-w-0">
              <span className="text-emerald-200 block text-[11px]">حالة الترخيص (orgId):</span>
              <span className="font-mono font-bold text-xs text-white block mt-0.5 truncate">
                {orgContext ? orgContext.orgId : 'غير مرخص'}
              </span>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md p-2.5 rounded-xl flex items-center gap-2.5">
            <Building2 className="w-5 h-5 text-cyan-300 shrink-0" />
            <div className="min-w-0">
              <span className="text-emerald-200 block text-[11px]">معرّف الفرع (branchId):</span>
              <span className="font-mono font-bold text-xs text-white block mt-0.5 truncate">
                {orgContext ? orgContext.branchId : 'غير محدد'}
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

      {/* Unconfigured Cloud Banner */}
      {!isCloudConfigured && (
        <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 flex items-start gap-3 shadow-xs">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1 text-xs">
            <p className="font-black text-sm">السحابة غير مُعدّة بعد</p>
            <p className="leading-relaxed">
              لم يتم إدخال إعدادات Firebase بعد في <code className="font-mono bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded">src/config/firebaseConfig.ts</code>. جميع نداءات السحابة معطّلة حالياً ويعمل النظام محلياً بأمان بدون أخطاء. راجع <code className="font-mono bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded">docs/CLOUD_SETUP.md</code> لخطوات الربط.
            </p>
          </div>
        </div>
      )}

      {/* Daily Budget 90% Yellow Warning */}
      {budgetStatus.isWarning90 && !budgetStatus.isExceeded && (
        <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 flex items-center justify-between gap-2 text-xs font-bold shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{budgetStatus.warningMessage}</span>
          </div>
          <span className="font-mono">{budgetStatus.counterLabel}</span>
        </div>
      )}

      {/* Daily Budget Exceeded / Circuit Breaker Paused Banner */}
      {(syncState === 'budget-paused' || budgetStatus.isExceeded) && (
        <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950 border border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-200 flex items-center justify-between gap-2 text-xs font-bold shadow-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>تم إيقاف المزامنة السحابية اليوم لتجاوز الحد اليومي، ستُستأنف غداً</span>
          </div>
          <span className="font-mono">{budgetStatus.counterLabel}</span>
        </div>
      )}

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
                <span>تسجيل دخول المحل للمزامنة</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                دخول بالبريد الإلكتروني وكلمة المرور فقط (لا تُحفظ كلمة المرور نهائياً، وتُستخدم جلسة Firebase المحلية تلقائياً).
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
                  className="px-3 py-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg font-bold cursor-pointer transition-colors"
                >
                  تسجيل الخروج
                </button>
              </div>
            )}

            <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1">
                  البريد الإلكتروني المعتمد للمحل:
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute right-3.5 top-3 pointer-events-none" />
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    disabled={!isCloudConfigured}
                    required
                    placeholder="name@example.com"
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl pr-10 pl-3 py-2.5 text-xs sm:text-sm font-bold text-slate-900 dark:text-white font-mono focus:outline-none focus:border-emerald-500 shadow-inner disabled:opacity-50"
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
                    disabled={!isCloudConfigured}
                    required
                    placeholder="اكتب كلمة المرور..."
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl pr-10 pl-3 py-2.5 text-xs sm:text-sm font-bold text-slate-900 dark:text-white font-mono focus:outline-none focus:border-emerald-500 shadow-inner disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Offline Resilience Note */}
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-xl text-xs space-y-1">
                <span className="font-black text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
                  <Wifi className="w-4 h-4 text-emerald-600" />
                  <span>جلسة محلية آمنة:</span>
                </span>
                <p className="text-emerald-800 dark:text-emerald-300 text-[11px] leading-relaxed">
                  لا يتم تخزين كلمة المرور مطلقاً. بعد تسجيل الدخول الأول، تحفظ Firebase جلسة المصادقة محلياً لاستئناف المزامنة تلقائياً عند توفر الشبكة.
                </p>
              </div>

              <button
                type="submit"
                disabled={!isCloudConfigured || isAuthenticating}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black rounded-xl text-xs sm:text-sm cursor-pointer shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{isAuthenticating ? 'جاري التحقق والمصادقة...' : 'تسجيل دخول المحل للمزامنة'}</span>
              </button>
            </form>
          </div>

          {/* Linked Store & Sync Status Card */}
          <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <Store className="w-5 h-5 text-blue-600" />
                  <span>حالة ربط المحل والمزامنة السحابية</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  معلومات الترخيص، حالة الدخول، آخر نبضة، آخر ملخص يومي، ونتيجة اختبار الاتصال
                </p>
              </div>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={!isCloudConfigured || isTestingConnection || !isOnline}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-black cursor-pointer flex items-center gap-1.5 shrink-0 shadow-xs"
              >
                <Activity className={`w-3.5 h-3.5 ${isTestingConnection ? 'animate-spin' : ''}`} />
                <span>{isTestingConnection ? 'جاري الاختبار...' : 'اختبار الاتصال'}</span>
              </button>
            </div>

            {connectionTestResult && (
              <div
                className={`p-3 rounded-xl border text-xs font-bold flex items-center gap-2 ${
                  connectionTestResult.success
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-rose-50 dark:bg-rose-950/60 border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                }`}
              >
                {connectionTestResult.success ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                )}
                <span>{connectionTestResult.message}</span>
              </div>
            )}

            <div className="space-y-2.5 text-xs">
              {/* 1. License State: orgId & branchId */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-slate-600 dark:text-slate-400">حالة الترخيص:</span>
                  <span className={`font-black ${orgContext ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {orgContext ? linkedStore.subscriptionStatusLabel : 'غير مرخص'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] font-mono text-slate-700 dark:text-slate-300 pt-1">
                  <span>orgId: <strong>{orgContext?.orgId || 'غير متوفر'}</strong></span>
                  <span>branchId: <strong>{orgContext?.branchId || 'غير متوفر'}</strong></span>
                </div>
              </div>

              {/* 2. Store Login Status */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center gap-2">
                <span className="font-bold text-slate-600 dark:text-slate-400">حالة تسجيل دخول المحل:</span>
                <span className={`font-bold font-mono truncate ${firebaseUser ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {firebaseUser?.email || 'غير مسجّل'}
                </span>
              </div>

              {/* 3. Last Successful Heartbeat */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-blue-500" />
                  <span>آخر نبضة ناجحة:</span>
                </span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  {lastHeartbeat ? lastHeartbeat.toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'لم تُرسل بعد'}
                </span>
              </div>

              {/* 4. Last Daily Summary */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center gap-2">
                <span className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-emerald-500" />
                  <span>آخر ملخص يومي:</span>
                </span>
                {!isCloudSummaryEnabled ? (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    غير مضمّن في باقتك
                  </span>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {isSummaryDirty && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-black bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                        ملخص معلّق
                      </span>
                    )}
                    <span className="font-mono font-bold text-slate-900 dark:text-white">
                      {lastSummary ? lastSummary.toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'لم يُرفع بعد'}
                    </span>
                  </div>
                )}
              </div>

              {/* 5. Last Successful Cloud Backup */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center gap-2">
                <span className="font-bold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-emerald-600" />
                  <span>آخر نسخة سحابية ناجحة:</span>
                </span>
                {!isCloudBackupEnabled ? (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    غير مضمّن في باقتك
                  </span>
                ) : (
                  <span className="font-mono font-bold text-slate-900 dark:text-white text-left">
                    {lastBackupMeta
                      ? `${new Date(lastBackupMeta.createdAtMs).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })} (${(lastBackupMeta.sizeBytes / 1024).toFixed(1)} ك.ب)`
                      : 'لا توجد نسخة مرفوعة بعد'}
                  </span>
                )}
              </div>

              {/* 6. Daily Operations Budget Counter */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center gap-2">
                <span className="font-bold text-slate-600 dark:text-slate-400">استهلاك اليوم السحابي:</span>
                <span className={`font-mono font-bold ${
                  budgetStatus.isExceeded
                    ? 'text-rose-600 dark:text-rose-400'
                    : budgetStatus.isWarning90
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-slate-900 dark:text-white'
                }`}>
                  {budgetStatus.counterLabel}
                </span>
              </div>

              {/* 7. Sync State Badge */}
              <div className="p-3 bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <span className="font-bold text-slate-600 dark:text-slate-400">حالة المزامنة:</span>
                <span className={`px-2.5 py-0.5 rounded-full font-bold text-[11px] border ${
                  !isCloudConfigured || syncState === 'unconfigured'
                    ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300'
                    : syncState === 'synced'
                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-300'
                    : syncState === 'syncing'
                    ? 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300'
                    : syncState === 'budget-paused'
                    ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-400'
                    : syncState === 'subscription-paused' || syncState === 'wrong-account' || syncState === 'error'
                    ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300 border-rose-300'
                    : syncState === 'offline'
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-300 border-slate-300'
                    : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300'
                }`}>
                  {!isCloudConfigured || syncState === 'unconfigured' ? 'السحابة غير مُعدّة بعد' :
                   syncState === 'synced' ? 'متزامن بنجاح ✓' :
                   syncState === 'syncing' ? 'جاري المزامنة...' :
                   syncState === 'budget-paused' ? 'متوقف مؤقتاً (تجاوز الحد اليومي)' :
                   syncState === 'subscription-paused' ? 'تم رفض الصلاحية / اشتراك متوقف' :
                   syncState === 'wrong-account' ? 'الحساب لا يطابق orgId بالترخيص' :
                   syncState === 'offline' ? 'أوفلاين (محلي)' :
                   syncState === 'no-license' ? 'لا يوجد ترخيص سارٍ' :
                   syncState === 'error' ? 'تعذر إتمام المزامنة' : 'يلزم تسجيل الدخول'}
                </span>
              </div>

              {/* 7. Cloud Backup Drop Alert */}
              {backupDropAlert && (
                <div className="p-3 rounded-xl border bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>{backupDropAlert}</span>
                </div>
              )}

              {/* 8. Last Error */}
              <div className={`p-3 rounded-xl border space-y-1 ${
                lastSyncError || syncStatusMsg
                  ? 'bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800'
                  : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
              }`}>
                <span className="font-bold text-slate-600 dark:text-slate-400 block">آخر خطأ / ملاحظة:</span>
                <p className={`text-xs font-bold leading-relaxed ${
                  lastSyncError ? 'text-rose-700 dark:text-rose-300' : 'text-slate-700 dark:text-slate-300'
                }`}>
                  {lastSyncError || syncStatusMsg || 'لا توجد أخطاء'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- 2. DUAL BACKUP & RESTORE --- */}
      {activeSubTab === 'BACKUPS' && (
        <div className="space-y-5">
          {backupDropAlert && (
            <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs font-bold flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>{backupDropAlert}</span>
              </div>
              <button
                type="button"
                onClick={() => cloudBackupService.clearDropAlert()}
                className="text-xs underline cursor-pointer shrink-0"
              >
                إغلاق
              </button>
            </div>
          )}

          {/* Create Backup Action Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 p-4 rounded-2xl shadow-xs flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="flex-1 w-full">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1">
                رفع نسخة احتياطية مضغوطة ومقسّمة إلى السحابة (بدون كلمات مرور المستخدمين):
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualBackupNote}
                  onChange={(e) => setManualBackupNote(e.target.value)}
                  disabled={!isCloudBackupEnabled}
                  placeholder={isCloudBackupEnabled ? 'وصف اختياري للنسخة (مثلاً: قبل الجرد أو نهاية الوردية)...' : 'النسخ الاحتياطي السحابي غير مضمّن في باقتك'}
                  className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 dark:text-white disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleCreateCloudBackup}
                  disabled={!isCloudConfigured || !isCloudBackupEnabled || isCreatingBackup || !isOnline || !isStoreSignedIn}
                  title={!isCloudBackupEnabled ? 'غير مضمّن في باقتك' : undefined}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-black text-xs rounded-xl cursor-pointer flex items-center gap-1.5 shadow-xs shrink-0"
                >
                  <CloudCheck className="w-4 h-4" />
                  <span>
                    {!isCloudBackupEnabled
                      ? 'غير مضمّن في باقتك'
                      : isCreatingBackup
                      ? 'جاري الرفع...'
                      : 'نسخ الآن'}
                  </span>
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
            <div className="p-3.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-600" />
                <h3 className="text-xs sm:text-sm font-black text-slate-900 dark:text-white">
                  النسخ الاحتياطية السحابية المكتملة (آخر 7 نسخ — {cloudBackups.length})
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadAllCloudData()}
                  disabled={isLoadingBackups || !isStoreSignedIn}
                  className="px-3 py-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-[11px] font-bold cursor-pointer flex items-center gap-1"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoadingBackups ? 'animate-spin' : ''}`} />
                  <span>تحديث</span>
                </button>
              </div>
            </div>

            {downloadProgress && (
              <div className="p-4 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 space-y-2">
                <div className="flex justify-between items-center text-xs font-bold text-blue-900 dark:text-blue-200">
                  <span>جاري تنزيل وفحص النسخة السحابية...</span>
                  <span className="font-mono">{downloadProgress.loadedChunks} / {downloadProgress.totalChunks} ({downloadProgress.percent}%)</span>
                </div>
                <div className="w-full h-2.5 bg-blue-200 dark:bg-blue-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-200"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[460px] overflow-y-auto">
              {!isStoreSignedIn ? (
                <div className="p-8 text-center text-slate-500 text-xs space-y-2">
                  <p>يجب تسجيل دخول المحل للسحابة لعرض النسخ الاحتياطية السحابية واستعادتها.</p>
                </div>
              ) : cloudBackups.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  {isLoadingBackups
                    ? 'جاري تحميل قائمة النسخ السحابية...'
                    : 'لا توجد نسخ احتياطية سحابية مكتملة حتى الآن. اضغط "نسخ الآن" لرفع أول نسخة.'}
                </div>
              ) : (
                cloudBackups.map((backup, idx) => {
                  const dateFormatted = new Date(backup.createdAtMs).toLocaleString('ar-EG', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  });
                  const sizeFormatted =
                    backup.sizeBytes >= 1024 * 1024
                      ? `${(backup.sizeBytes / (1024 * 1024)).toFixed(2)} م.ب`
                      : `${(backup.sizeBytes / 1024).toFixed(1)} ك.ب`;

                  return (
                    <div
                      key={backup.id}
                      className="p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white">
                            {dateFormatted}
                          </span>
                          <span className="text-[10px] bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 px-2 py-0.5 rounded-full font-mono font-bold">
                            مكتملة ✓
                          </span>
                          {idx === 0 && (
                            <span className="text-[10px] bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 px-2 py-0.5 rounded-full font-bold">
                              الأحدث (محمية)
                            </span>
                          )}
                          {backup.note && (
                            <span className="text-[11px] text-slate-600 dark:text-slate-300 font-medium">
                              — {backup.note}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-3 flex-wrap">
                          <span className="font-mono">{sizeFormatted}</span>
                          <span>•</span>
                          <span>{backup.totalProducts} صنف</span>
                          <span>•</span>
                          <span>{backup.totalInvoices} فاتورة</span>
                          <span>•</span>
                          <span>{backup.totalCustomers} عميل</span>
                          <span>•</span>
                          <span className="font-mono">{backup.totalChunks} قطعة</span>
                          <span>•</span>
                          <span className="font-mono">إصدار {backup.appVersion}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                        {isAdminUser && (
                          <button
                            type="button"
                            onClick={() => handleStartCloudRestore(backup)}
                            disabled={downloadingBackupId !== null}
                            className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-black cursor-pointer shadow-xs flex items-center gap-1.5"
                          >
                            <Download className={`w-3.5 h-3.5 ${downloadingBackupId === backup.id ? 'animate-bounce' : ''}`} />
                            <span>{downloadingBackupId === backup.id ? 'جاري التنزيل...' : 'استعادة من السحابة'}</span>
                          </button>
                        )}

                        {isAdminUser && idx > 0 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteCloudBackup(backup.id)}
                            className="p-2 text-slate-400 hover:text-rose-600 cursor-pointer rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/50"
                            title="حذف النسخة من السحابة"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
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

      {/* --- CLOUD RESTORE PICKER MODAL (Admin only) --- */}
      {isRestorePickerOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-xl w-full shadow-2xl text-right space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/10 text-amber-500 rounded-xl">
                  <Download className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black text-sm text-slate-900 dark:text-white">استعادة نسخة احتياطية من السحابة</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">اختر إحدى النسخ المكتملة لتنزيلها وفحص سلامتها قبل التطبيق</p>
                </div>
              </div>
              <button
                type="button"
                disabled={downloadingBackupId !== null}
                onClick={() => setIsRestorePickerOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {downloadProgress && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-xl space-y-2">
                <div className="flex justify-between items-center text-xs font-bold text-blue-900 dark:text-blue-200">
                  <span>جاري تنزيل القطع من السحابة...</span>
                  <span className="font-mono">{downloadProgress.loadedChunks} / {downloadProgress.totalChunks} ({downloadProgress.percent}%)</span>
                </div>
                <div className="w-full h-2.5 bg-blue-200 dark:bg-blue-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-200"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl">
              {isLoadingBackups ? (
                <div className="p-6 text-center text-xs text-slate-500">جاري تحميل قائمة النسخ السحابية...</div>
              ) : cloudBackups.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">لا توجد نسخ احتياطية سحابية مكتملة لهذا الفرع.</div>
              ) : (
                cloudBackups.map(b => (
                  <div key={b.id} className="p-3 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <div className="space-y-0.5 text-xs">
                      <div className="font-bold text-slate-900 dark:text-white">
                        {new Date(b.createdAtMs).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {(b.sizeBytes / 1024).toFixed(1)} ك.ب • {b.totalProducts} صنف • {b.totalInvoices} فاتورة • {b.totalCustomers} عميل
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={downloadingBackupId !== null}
                      onClick={() => handleStartCloudRestore(b)}
                      className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-xs font-black cursor-pointer shrink-0"
                    >
                      {downloadingBackupId === b.id ? 'جاري التنزيل...' : 'اختيار ومعاينة'}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- CLOUD RESTORE PREVIEW & DOUBLE CONFIRMATION MODAL --- */}
      {pendingCloudRestore && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl text-right space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/10 text-amber-500 rounded-xl">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black text-sm text-slate-900 dark:text-white">معاينة وتأكيد استعادة النسخة السحابية</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{pendingCloudRestore.backup.id}</p>
                </div>
              </div>
              <button
                type="button"
                disabled={isApplyingRestore}
                onClick={() => setPendingCloudRestore(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {pendingCloudRestore.warning && (
              <div className="bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 p-3 rounded-xl text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{pendingCloudRestore.warning}</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-slate-50 dark:bg-slate-800/80 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 text-[10px]">المنتجات</div>
                <div className="font-black text-slate-800 dark:text-slate-100 text-sm mt-0.5">{pendingCloudRestore.preview.counts.products}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/80 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 text-[10px]">الفواتير</div>
                <div className="font-black text-slate-800 dark:text-slate-100 text-sm mt-0.5">{pendingCloudRestore.preview.counts.invoices}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/80 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 text-[10px]">العملاء</div>
                <div className="font-black text-slate-800 dark:text-slate-100 text-sm mt-0.5">{pendingCloudRestore.preview.counts.customers}</div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/80 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="text-slate-400 text-[10px]">الموردون</div>
                <div className="font-black text-slate-800 dark:text-slate-100 text-sm mt-0.5">{pendingCloudRestore.preview.counts.suppliers}</div>
              </div>
            </div>

            <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50 p-3 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed font-medium">
              🛡️ تم التحقق من التوقيع الرقمي SHA-256 واكتمال المجموعات. بعد الاستعادة سيُطلب من المدير تعيين كلمة مرور جديدة للحسابات لحماية المحل.
            </div>

            <label className="flex items-start gap-2.5 bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl cursor-pointer">
              <input
                type="checkbox"
                checked={isDoubleConfirmed}
                onChange={(e) => setIsDoubleConfirmed(e.target.checked)}
                className="mt-0.5 rounded text-amber-600 cursor-pointer"
              />
              <span className="text-xs text-slate-800 dark:text-slate-200 font-bold leading-relaxed">
                أؤكد موافقتي على استبدال قاعدة البيانات الحالية بهذا الجهاز بهذه النسخة السحابية.
              </span>
            </label>

            <div className="pt-2 flex justify-end gap-2.5">
              <button
                type="button"
                disabled={isApplyingRestore}
                onClick={() => setPendingCloudRestore(null)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold cursor-pointer"
              >
                إلغاء وتراجع
              </button>
              <button
                type="button"
                disabled={!isDoubleConfirmed || isApplyingRestore}
                onClick={handleConfirmExecuteCloudRestore}
                className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black text-xs cursor-pointer shadow-md"
              >
                {isApplyingRestore ? 'جاري الاستعادة...' : 'تأكيد الاستعادة الآن'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
