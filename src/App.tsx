import React, { useState, useEffect } from 'react';
import { storage } from './services/storageService';
import { themeService } from './services/themeService';
import { User, SalesInvoice } from './types';
import { Navbar } from './components/Navbar';
import { Sidebar, TabType } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { PosSales } from './components/pos/PosSales';
import { InvoicesManager } from './components/invoices/InvoicesManager';
import { InventoryManager } from './components/inventory/InventoryManager';
import { PurchasingManager } from './components/purchasing/PurchasingManager';
import { CustomerLedger } from './components/customers/CustomerLedger';
import { SupplierLedger } from './components/suppliers/SupplierLedger';
import { CashManager } from './components/cash/CashManager';
import { UsersManager } from './components/users/UsersManager';
import { ProfitReports } from './components/reports/ProfitReports';
import { ThemeAccessibilitySettings } from './components/settings/ThemeAccessibilitySettings';
import { BackupManager } from './components/backup/BackupManager';
import { AuditTrail } from './components/audit/AuditTrail';
import { PrintableInvoice } from './components/common/PrintableInvoice';
import { EnvironmentBanner } from './components/common/EnvironmentBanner';
import { LoginModal } from './components/auth/LoginModal';
import { AdminSetupModal } from './components/auth/AdminSetupModal';
import { InitialSetupWizard } from './components/auth/InitialSetupWizard';
import { StoreProfileSettings } from './components/settings/StoreProfileSettings';
import { LicenseGate } from './components/license/LicenseGate';
import { CloudDashboard } from './components/cloud/CloudDashboard';
import { cloudService } from './services/cloudService';
import { licenseService } from './services/licenseService';
import { canAccessTab, authSecurityService } from './services/authSecurityService';
import { UnauthorizedState } from './components/common/FeedbackStates';
import { UnifiedSettings, SettingsSubTab } from './components/settings/UnifiedSettings';
import { tabLockService } from './services/tabLockService';
import { orgSyncService } from './services/orgSyncService';
import { snapshotService } from './services/snapshotService';
import { LayoutDashboard, ShoppingCart, Receipt, Boxes, Menu } from 'lucide-react';

export default function App() {
  const [tabLockState, setTabLockState] = useState<'checking' | 'acquired' | 'denied'>('checking');
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [storageInitError, setStorageInitError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(() => storage.getWriteError());
  const [migrationWarning, setMigrationWarning] = useState<string | null>(() => storage.getMigrationWarning());

  // Migration Recovery State (Requirement 2)
  const [isMigrationRecoveryRequired, setIsMigrationRecoveryRequired] = useState(false);
  const [legacyBackupDate, setLegacyBackupDate] = useState<string>('');
  const [recoveryConfirmAction, setRecoveryConfirmAction] = useState<'restore_legacy' | 'import_file' | null>(null);
  const [pendingImportJson, setPendingImportJson] = useState<string | null>(null);
  const [pendingImportFileName, setPendingImportFileName] = useState<string>('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState<boolean>(false);

  const [isInitialized, setIsInitialized] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [currentTab, setCurrentTab] = useState<TabType>('dashboard');
  const [currentCash, setCurrentCash] = useState<number>(3500);
  const [activePrintInvoice, setActivePrintInvoice] = useState<SalesInvoice | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<SalesInvoice | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [isLoginOpen, setIsLoginOpen] = useState<boolean>(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  // License and activation reactive state
  const [licenseState, setLicenseState] = useState(() => licenseService.getLicenseState());
  const [isStoreActivated, setIsStoreActivated] = useState<boolean>(() => licenseService.isStoreActivated());

  // 7-Day Manual Backup Reminder State (Requirement ثانياً: 4)
  const [backupReminder, setBackupReminder] = useState<{ needsReminder: boolean; daysSinceLastBackup: number } | null>(null);
  // Snapshot Drop Alert State (Requirement 1)
  const [dropAlert, setDropAlert] = useState<string | null>(() => snapshotService.getDropAlert());

  // Sync Data
  const refreshAll = React.useCallback(() => {
    const active = storage.getActiveUser();
    const allUsers = storage.getUsers();
    setCurrentUser(active);
    setUsers(allUsers);
    setCurrentCash(storage.calculateCurrentCashInDrawer());
  }, []);

  // Single, Idempotent Bootstrap Function (Requirement أولاً: ب)
  const bootstrapPromiseRef = React.useRef<Promise<boolean> | null>(null);

  const bootstrap = React.useCallback(async (): Promise<boolean> => {
    // If a bootstrap is already in-flight, return the shared promise
    if (bootstrapPromiseRef.current) {
      return bootstrapPromiseRef.current;
    }

    const task = (async (): Promise<boolean> => {
      setTabLockState('checking');
      const result = await tabLockService.requestLock();

      if (!result.acquired) {
        setTabLockState('denied');
        return false;
      }

      setTabLockState('acquired');

      // Load all data from IndexedDB into memory before rendering
      try {
        await storage.init();

        // Check if migration recovery is required (idb_migrated_at exists but IDB is empty)
        if (storage.isMigrationRecoveryRequired()) {
          const ts = storage.getLegacyBackupTimestamp();
          const dateStr = ts ? new Date(ts).toLocaleString('ar-EG') : 'غير محدد';
          setLegacyBackupDate(dateStr);
          setIsMigrationRecoveryRequired(true);
          return true;
        }

        refreshAll();
        setIsStorageReady(true);
        setIsInitialized(true);
        setMigrationWarning(storage.getMigrationWarning());

        // Initialize offline license verification
        licenseService.initLicense().catch(() => {});

        // Start background sync & heartbeats ONLY after lock is acquired and storage.init() succeeds
        orgSyncService.startService();

        // 1) Trigger daily internal snapshot if not taken today (Requirement ثانياً: 1)
        snapshotService.checkAndCreateDailySnapshot().catch(err => {
          console.warn('Daily snapshot error:', err);
        });

        // 4) Check backup reminder (7 days without manual export) (Requirement ثانياً: 4)
        const reminder = snapshotService.getReminderStatus();
        if (reminder.needsReminder) {
          setBackupReminder(reminder);
        }

        return true;
      } catch (err: any) {
        console.error('Storage initialization failed:', err);
        setStorageInitError(err?.message || 'تعذر تشغيل قاعدة البيانات المحلية');
        return false;
      }
    })();

    bootstrapPromiseRef.current = task.finally(() => {
      bootstrapPromiseRef.current = null;
    });

    return bootstrapPromiseRef.current;
  }, [refreshAll]);

  useEffect(() => {
    let isMounted = true;

    // Initialize Theme & Accessibility System on load
    themeService.init();

    // Subscribe to storage write errors (Requirement 7)
    const unsubWriteError = storage.onWriteError((err) => {
      setWriteError(err);
    });

    // Execute unified bootstrap
    bootstrap();

    // Subscribe to license changes
    const unsubLicense = licenseService.subscribe(() => {
      setLicenseState(licenseService.getLicenseState());
      setIsStoreActivated(licenseService.isStoreActivated());
    });

    const unsubAction = storage.onAction((actionName) => {
      cloudService.triggerAutoSyncOnAction(actionName);
      if (actionName === 'SHIFT_CLOSED') {
        snapshotService.createSnapshot('shift_close').catch(err => {
          console.warn('Shift close snapshot error:', err);
        });
      }
    });

    // Global keyboard shortcuts (F1 -> POS, F2 -> Invoices, F3 -> Customers, F4 -> Cash)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setEditingInvoice(null);
        setCurrentTab('pos');
      } else if (e.key === 'F2') {
        e.preventDefault();
        setCurrentTab('invoices');
      } else if (e.key === 'F3') {
        e.preventDefault();
        setCurrentTab('customers');
      } else if (e.key === 'F4') {
        e.preventDefault();
        setCurrentTab('cash');
      }
    };

    const unsubDropAlert = snapshotService.onDropAlertChange((alert) => {
      setDropAlert(alert);
    });

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      isMounted = false;
      window.removeEventListener('keydown', handleKeyDown);
      unsubLicense();
      unsubAction();
      unsubWriteError();
      unsubDropAlert();
      orgSyncService.stopService();
      // Requirement 2: Do NOT call tabLockService.releaseLock() in useEffect cleanup.
      // The lock is released by the browser on window/tab close.
    };
  }, [bootstrap]);

  // Automatic retry every 3 seconds while on the rejection screen using unified bootstrap()
  useEffect(() => {
    if (tabLockState !== 'denied') return;
    const interval = setInterval(() => {
      bootstrap();
    }, 3000);

    return () => clearInterval(interval);
  }, [tabLockState, bootstrap]);

  // Inactivity Auto-Lock (default 10 minutes, configurable)
  const lastActivityRef = React.useRef<number>(Date.now());
  const hasAdmin = users.some(u => u.role === 'ADMIN' && u.isActive !== false);

  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(evt => window.addEventListener(evt, handleActivity, { passive: true }));

    const interval = setInterval(() => {
      const settings = authSecurityService.getSecuritySettings();
      const lockMinutes = settings.autoLockMinutes;
      if (lockMinutes > 0 && !isLocked && currentUser && isStoreActivated && hasAdmin) {
        const idleMs = Date.now() - lastActivityRef.current;
        if (idleMs >= lockMinutes * 60 * 1000) {
          setIsLocked(true);
          storage.addAuditLog(
            'AUTH',
            'قفل تلقائي',
            'الأمان',
            currentUser.id,
            `تم قفل الشاشة تلقائياً بعد ${lockMinutes} دقيقة من عدم النشاط`
          );
        }
      }
    }, 5000);

    return () => {
      events.forEach(evt => window.removeEventListener(evt, handleActivity));
      clearInterval(interval);
    };
  }, [isLocked, currentUser, isStoreActivated, hasAdmin]);

  const handleSwitchUser = (userId: string) => {
    storage.setActiveUser(userId);
    refreshAll();
  };

  const handleManualRetry = () => {
    bootstrap();
  };

  // Banner Backup Export Handler
  const handleExportNowFromBanner = async () => {
    try {
      const pkg = await snapshotService.generateExportPackage();
      const jsonString = JSON.stringify(pkg, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `Kashir_Backup_v${pkg.schemaVersion}_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupReminder(null);
    } catch (err) {
      console.error('Export from banner failed:', err);
    }
  };

  const handleSnoozeBackupReminder = () => {
    snapshotService.snoozeReminderOneDay();
    setBackupReminder(null);
  };

  const handleForceCreateSnapshot = async () => {
    await snapshotService.createSnapshot('manual', undefined, undefined, { force: true, status: 'suspicious' });
    setDropAlert(null);
  };

  // -2. Single-Tab Lock Checking Screen (Requirement 3)
  if (tabLockState === 'checking') {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-lg font-bold text-slate-200">جاري التحقق من جاهزية تشغيل النظام...</p>
        </div>
      </div>
    );
  }

  // -1. Single-Tab Lock Denied: Another tab is running (Requirement 1 & 4)
  if (tabLockState === 'denied') {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans p-4" dir="rtl">
        <div className="bg-slate-800 border border-amber-500/40 rounded-2xl p-8 max-w-md w-full text-center space-y-5 shadow-2xl">
          <div className="w-20 h-20 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center mx-auto text-4xl font-black">
            🔒
          </div>
          <h2 className="text-2xl font-black text-amber-300">التطبيق مفتوح في نافذة أخرى، أغلق هذه النافذة</h2>
          <p className="text-sm text-slate-300 leading-relaxed font-medium">
            لحماية قاعدة البيانات المحلية من التعارض أو تلف البيانات، يُسمح بتشغيل نافذة واحدة فقط من النظام في نفس الوقت.
          </p>
          <div className="bg-slate-950/70 border border-slate-700/50 rounded-xl p-3 text-xs text-slate-300 leading-relaxed">
            إن لم تكن فاتحاً النظام في مكان آخر، انتظر ثوانٍ أو اضغط إعادة المحاولة.
          </div>
          <button
            type="button"
            onClick={handleManualRetry}
            className="w-full bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white font-bold py-2.5 px-4 rounded-xl text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-lg"
          >
            <span>إعادة المحاولة الآن</span>
          </button>
        </div>
      </div>
    );
  }

  // -0.5. Migration Recovery Required: Database empty but legacy backup exists (Requirement 2)
  if (isMigrationRecoveryRequired) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center font-sans p-4" dir="rtl">
        <div className="bg-slate-900 border-2 border-rose-600 rounded-2xl p-6 sm:p-8 max-w-lg w-full text-center space-y-6 shadow-2xl">
          <div className="w-16 h-16 bg-rose-500/20 text-rose-400 rounded-full flex items-center justify-center mx-auto text-3xl font-black">
            ⚠️
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-black text-rose-400">قاعدة البيانات المحلية فارغة</h2>
            <p className="text-sm text-slate-200 font-semibold leading-relaxed">
              قاعدة البيانات المحلية فارغة، توجد نسخة قديمة بتاريخ:
              <br />
              <span className="text-amber-400 font-mono font-bold text-base mt-1 inline-block">{legacyBackupDate}</span>
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              تم رصد تسجيل ترحيل سابق ولكن لم يتم العثور على مجموعات البيانات في IndexedDB. لا يمكن تشغيل التطبيق تلقائياً تفادياً لفقدان البيانات. اختر أحد الإجراءين التاليين بتأكيد مزدوج:
            </p>
          </div>

          {recoveryError && (
            <div className="bg-rose-950/80 border border-rose-500 text-rose-300 text-xs p-3 rounded-xl font-bold">
              {recoveryError}
            </div>
          )}

          {recoveryConfirmAction === 'restore_legacy' ? (
            <div className="bg-slate-800 border border-amber-500/50 rounded-xl p-4 text-right space-y-3">
              <h3 className="text-sm font-bold text-amber-300">تأكيد استعادة النسخة القديمة المحفوظة</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                هل أنت متأكد من استعادة بياناتك من النسخة القديمة المؤرخة في ({legacyBackupDate})؟ سيتم نقلها إلى قاعدة البيانات المحلية فوراً.
              </p>
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  disabled={isRecovering}
                  onClick={() => setRecoveryConfirmAction(null)}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-xs font-bold rounded-lg cursor-pointer transition"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={isRecovering}
                  onClick={async () => {
                    setIsRecovering(true);
                    setRecoveryError(null);
                    const res = await storage.restoreFromLegacyLocalStorage();
                    setIsRecovering(false);
                    if (res.success) {
                      setIsMigrationRecoveryRequired(false);
                      refreshAll();
                      setIsStorageReady(true);
                      setIsInitialized(true);
                      licenseService.initLicense().catch(() => {});
                      orgSyncService.startService();
                    } else {
                      setRecoveryError(res.error || 'تعذر استعادة البيانات');
                    }
                  }}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-black rounded-lg cursor-pointer transition shadow-md"
                >
                  {isRecovering ? 'جاري الاستعادة...' : 'تأكيد الاستعادة الآن'}
                </button>
              </div>
            </div>
          ) : recoveryConfirmAction === 'import_file' ? (
            <div className="bg-slate-800 border border-emerald-500/50 rounded-xl p-4 text-right space-y-3">
              <h3 className="text-sm font-bold text-emerald-300">تأكيد استيراد ملف النسخة الاحتياطية</h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                الملف المحدد: <span className="font-mono font-bold text-white">{pendingImportFileName}</span>
                <br />
                هل أنت متأكد من استيراد هذه النسخة واستبدال قاعدة البيانات بها؟
              </p>
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  disabled={isRecovering}
                  onClick={() => {
                    setRecoveryConfirmAction(null);
                    setPendingImportJson(null);
                    setPendingImportFileName('');
                  }}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-xs font-bold rounded-lg cursor-pointer transition"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={isRecovering}
                  onClick={async () => {
                    if (!pendingImportJson) return;
                    setIsRecovering(true);
                    setRecoveryError(null);
                    const res = storage.restoreBackupJson(pendingImportJson);
                    if (res.success) {
                      await storage.flush();
                      setIsRecovering(false);
                      setIsMigrationRecoveryRequired(false);
                      refreshAll();
                      setIsStorageReady(true);
                      setIsInitialized(true);
                      licenseService.initLicense().catch(() => {});
                      orgSyncService.startService();
                    } else {
                      setIsRecovering(false);
                      setRecoveryError(res.error || 'الملف غير صالح');
                    }
                  }}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black rounded-lg cursor-pointer transition shadow-md"
                >
                  {isRecovering ? 'جاري الاستيراد...' : 'تأكيد الاستيراد الآن'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setRecoveryConfirmAction('restore_legacy')}
                className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 px-4 rounded-xl text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-lg"
              >
                <span>(أ) استعادة من النسخة القديمة المحفوظة</span>
              </button>

              <label className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-bold py-3 px-4 rounded-xl text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow block">
                <span>(ب) استيراد ملف نسخة احتياطية (.json)</span>
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                      const text = event.target?.result as string;
                      setPendingImportJson(text);
                      setPendingImportFileName(file.name);
                      setRecoveryConfirmAction('import_file');
                    };
                    reader.readAsText(file);
                  }}
                />
              </label>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 0. Storage Error state: if storage initialization failed, show clear error and do NOT overwrite data
  if (storageInitError) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans p-4" dir="rtl">
        <div className="bg-slate-800 border border-rose-600 rounded-2xl p-6 max-w-md w-full text-center space-y-4 shadow-2xl">
          <div className="w-16 h-16 bg-rose-500/20 text-rose-400 rounded-full flex items-center justify-center mx-auto text-3xl font-black">
            ⚠️
          </div>
          <h2 className="text-xl font-bold text-rose-300">خطأ في تشغيل قاعدة البيانات</h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            تعذر تحميل بيانات النظام من قاعدة البيانات الآمنة (IndexedDB).
            لم يتم الكتابة فوق أي بيانات لحمايتها من التلف. يرجى إعادة المحاولة أو مراجعة أذونات التخزين في المتصفح.
          </p>
          <div className="text-xs text-rose-400 font-mono bg-slate-950 p-2.5 rounded border border-rose-900/50 break-all text-right" dir="ltr">
            {storageInitError}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-2.5 rounded-xl transition cursor-pointer text-sm"
          >
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  // 0. Storage loading state: must complete storage.init() before any screen renders (Requirement 4)
  if (!isStorageReady) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-lg font-bold text-slate-200">جاري تحميل بيانات النظام من قاعدة البيانات الآمنة (IndexedDB)...</p>
        </div>
      </div>
    );
  }

  // 1. Loading state during cryptographic verification on boot
  if (licenseState.status === 'checking') {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-lg font-bold text-slate-200">جاري التحقق من ترخيص النظام...</p>
        </div>
      </div>
    );
  }

  // 2. Gatekeeper: If device is not activated (neither valid nor grace nor trial bypass)
  if (!isStoreActivated) {
    return (
      <LicenseGate
        onActivationSuccess={() => {
          setIsStoreActivated(true);
          setIsLocked(true);
          refreshAll();
        }}
      />
    );
  }

  // 3. First-Run Setup Gatekeeper (Store Profile & Admin Setup - Requirement 4)
  if (!hasAdmin) {
    return (
      <InitialSetupWizard
        onComplete={(newAdmin) => {
          refreshAll();
          setCurrentUser(newAdmin);
          setIsLocked(false);
        }}
      />
    );
  }

  // 4. App startup loading state
  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center font-sans" dir="rtl">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-lg font-bold text-slate-200">جاري تشغيل نظام الكاشير وإدارة المبيعات...</p>
        </div>
      </div>
    );
  }

  // 5. If no active user is logged in (currentUser is null) -> Render Login screen
  if (!currentUser) {
    return (
      <LoginModal
        users={users}
        currentUser={null}
        isLockScreen={true}
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          storage.setActiveUser(user.id);
          setIsLocked(false);
          refreshAll();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans select-none transition-colors" dir="rtl">
      {/* Top Application Navbar */}
      <Navbar
        currentUser={currentUser}
        onSwitchUser={handleSwitchUser}
        users={users}
        currentCash={currentCash}
        onOpenBackupModal={() => setCurrentTab('backup')}
        onOpenSettingsModal={() => setCurrentTab('settings')}
        onNavigateCloud={() => setCurrentTab('cloud')}
        onLockScreen={() => setIsLocked(true)}
        onOpenLogin={() => setIsLoginOpen(true)}
        onToggleMobileMenu={() => setIsMobileMenuOpen(prev => !prev)}
      />

      {/* Non-blocking banner: Review store profile for upgraded installation (Requirement 5) */}
      {!storage.isStoreProfileReviewed() && currentUser?.role === 'ADMIN' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-xs font-bold text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="text-base">💡</span>
            <span>يرجى مراجعة بيانات المحل: رقم الهاتف والعنوان فارغان حالياً ويلزم إدخالهما ليظهرا في بونات الكاشير والفواتير والتقارير.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentTab('store-profile')}
              className="bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded-lg text-xs font-black cursor-pointer shadow-xs transition-colors"
            >
              راجع بيانات المحل
            </button>
            <button
              type="button"
              onClick={() => {
                storage.setStoreProfileReviewed(true);
                refreshAll();
              }}
              className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white px-2 py-1 text-xs cursor-pointer"
            >
              تجاهل الآن ✕
            </button>
          </div>
        </div>
      )}

      {/* Persistent Write Error Alert Banner (Requirement 7) */}
      {writeError && (
        <div className="bg-rose-600 text-white font-bold px-4 py-2.5 flex items-center justify-between shadow-lg z-50 text-xs sm:text-sm" role="alert">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>تعذر حفظ البيانات، اصنع نسخة احتياطية الآن! ({writeError})</span>
          </div>
          <button
            onClick={() => setCurrentTab('backup')}
            className="bg-white text-rose-700 hover:bg-rose-50 px-3 py-1 rounded-lg text-xs font-black shadow cursor-pointer transition shrink-0"
          >
            اصنع نسخة احتياطية الآن
          </button>
        </div>
      )}

      {/* Migration Warning Banner (if fallback to localStorage happened) */}
      {migrationWarning && !writeError && (
        <div className="bg-amber-600 text-white font-semibold px-4 py-2 flex items-center justify-between text-xs" role="alert">
          <span>⚠️ {migrationWarning}</span>
          <button onClick={() => setMigrationWarning(null)} className="cursor-pointer text-xs underline font-bold">إغلاق</button>
        </div>
      )}

      {/* 7-Day Manual Backup Reminder Banner (Requirement ثانياً: 4) */}
      {backupReminder?.needsReminder && !writeError && (
        <div className="bg-amber-500 text-slate-950 font-bold px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-md z-40 text-xs sm:text-sm" role="alert">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>لم تُصدّر نسخة احتياطية إلى ملف منذ {backupReminder.daysSinceLastBackup} أيام</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportNowFromBanner}
              className="bg-slate-950 hover:bg-slate-900 text-amber-300 px-3 py-1 rounded-lg text-xs font-black shadow cursor-pointer transition"
            >
              تصدير الآن
            </button>
            <button
              onClick={handleSnoozeBackupReminder}
              className="bg-amber-600/30 hover:bg-amber-600/50 text-slate-950 px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition border border-amber-600/40"
            >
              تأجيل يوماً واحداً
            </button>
          </div>
        </div>
      )}

      {/* Snapshot Drop Alert Banner (Requirement 1) */}
      {dropAlert && !writeError && (
        <div className="bg-amber-500 text-slate-950 font-bold px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-md z-40 text-xs sm:text-sm" role="alert">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>{dropAlert}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleForceCreateSnapshot}
              className="bg-slate-950 hover:bg-slate-900 text-amber-300 px-3 py-1 rounded-lg text-xs font-black shadow cursor-pointer transition"
            >
              إنشاء لقطة على أي حال
            </button>
            <button
              onClick={() => {
                snapshotService.clearDropAlert();
                setDropAlert(null);
              }}
              className="bg-amber-600/30 hover:bg-amber-600/50 text-slate-950 px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition border border-amber-600/40"
            >
              تجاهل
            </button>
          </div>
        </div>
      )}

      {/* System Environment Notification Banner */}
      <EnvironmentBanner />

      {/* Main Workspace (Sidebar + Dynamic Screen Area) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Right-To-Left Sidebar */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={(tab) => {
            if (tab === 'pos') setEditingInvoice(null);
            setCurrentTab(tab);
          }}
          currentUser={currentUser}
          isOpenMobile={isMobileMenuOpen}
          onCloseMobile={() => setIsMobileMenuOpen(false)}
        />

        {/* Content Viewport with extra bottom padding on mobile/tablet */}
        <main className="flex-1 overflow-y-auto p-2.5 sm:p-4 md:p-6 pb-24 lg:pb-6 bg-slate-100/90 dark:bg-slate-950/90 transition-colors">
          <div className="max-w-7xl mx-auto">
            {/* RBAC Route Guard (Requirement 4) */}
            {!canAccessTab(currentUser, currentTab) ? (
              <UnauthorizedState
                title="غير مصرح بالدخول"
                message="ليس لديك الصلاحية المطلوبة للوصول إلى هذه الشاشة أو التقرير. يرجى مراجعة مدير النظام لمنحك الصلاحية اللازمة."
                onNavigatePos={() => {
                  setEditingInvoice(null);
                  setCurrentTab('pos');
                }}
                onNavigateHome={() => setCurrentTab('dashboard')}
              />
            ) : (
              <>
                {currentTab === 'dashboard' && (
                  <Dashboard
                    products={storage.getProducts()}
                    customers={storage.getCustomers()}
                    suppliers={storage.getSuppliers()}
                    invoices={storage.getSalesInvoices()}
                    cashMovements={storage.getCashMovements()}
                    currentCash={currentCash}
                    onNavigate={setCurrentTab}
                    onOpenTransferModal={() => setCurrentTab('inventory')}
                  />
                )}

                {currentTab === 'pos' && (
                  <PosSales
                    currentUser={currentUser}
                    editingInvoice={editingInvoice}
                    onCancelEdit={() => setEditingInvoice(null)}
                    onInvoiceCreated={(invoice, shouldPrint = true) => {
                      setEditingInvoice(null);
                      refreshAll();
                      if (shouldPrint) {
                        setActivePrintInvoice(invoice);
                      }
                    }}
                    onOpenCustomerModal={() => setCurrentTab('customers')}
                  />
                )}

                {currentTab === 'invoices' && (
                  <InvoicesManager
                    currentUser={currentUser}
                    onNewInvoice={() => {
                      setEditingInvoice(null);
                      setCurrentTab('pos');
                    }}
                    onEditInvoice={(inv) => {
                      setEditingInvoice(inv);
                      setCurrentTab('pos');
                    }}
                    onPrintInvoice={(inv) => {
                      setActivePrintInvoice(inv);
                    }}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'inventory' && (
                  <InventoryManager
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'purchasing' && (
                  <PurchasingManager
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'customers' && (
                  <CustomerLedger
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'suppliers' && (
                  <SupplierLedger
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'cash' && (
                  <CashManager
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'users' && (
                  <UsersManager
                    currentUser={currentUser}
                    onRefreshData={refreshAll}
                  />
                )}

                {currentTab === 'reports' && (
                  <ProfitReports currentUser={currentUser} />
                )}

                {/* Unified Settings Screen: handles settings, store-profile, backup, cloud, and audit (Requirement 2) */}
                {['settings', 'store-profile', 'backup', 'cloud', 'audit'].includes(currentTab) && (
                  <UnifiedSettings
                    currentUser={currentUser}
                    initialSubTab={
                      currentTab === 'settings'
                        ? 'store-profile'
                        : (currentTab as SettingsSubTab)
                    }
                    onRefreshAll={refreshAll}
                    onNavigateTab={(tab) => setCurrentTab(tab)}
                  />
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* STICKY MOBILE & TABLET BOTTOM NAVIGATION BAR (< 1024px) */}
      <nav 
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-300 dark:border-slate-800 py-1.5 px-2 flex justify-around items-center shadow-2xl transition-colors select-none"
        aria-label="شريط التنقل السريع للهاتف والتابلت"
      >
        {/* 1. Dashboard */}
        <button
          type="button"
          onClick={() => {
            setCurrentTab('dashboard');
            setIsMobileMenuOpen(false);
          }}
          className={`flex flex-col items-center justify-center min-w-[56px] py-1 px-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            currentTab === 'dashboard'
              ? 'text-emerald-600 dark:text-emerald-400 font-black'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <LayoutDashboard className={`w-5 h-5 ${currentTab === 'dashboard' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px] mt-0.5">لوحة التحكم</span>
        </button>

        {/* 2. POS (F1 - Hero Button) */}
        <button
          type="button"
          onClick={() => {
            setEditingInvoice(null);
            setCurrentTab('pos');
            setIsMobileMenuOpen(false);
          }}
          className={`flex flex-col items-center justify-center min-w-[62px] py-1 px-1.5 rounded-xl text-xs transition-all cursor-pointer ${
            currentTab === 'pos'
              ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30 font-black -translate-y-1'
              : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700 font-bold'
          }`}
        >
          <ShoppingCart className="w-5 h-5" />
          <span className="text-[10px] mt-0.5">الكاشير (F1)</span>
        </button>

        {/* 3. Invoices */}
        <button
          type="button"
          onClick={() => {
            setCurrentTab('invoices');
            setIsMobileMenuOpen(false);
          }}
          className={`flex flex-col items-center justify-center min-w-[56px] py-1 px-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            currentTab === 'invoices'
              ? 'text-emerald-600 dark:text-emerald-400 font-black'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Receipt className={`w-5 h-5 ${currentTab === 'invoices' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px] mt-0.5">فواتير المبيعات</span>
        </button>

        {/* 4. Inventory */}
        <button
          type="button"
          onClick={() => {
            setCurrentTab('inventory');
            setIsMobileMenuOpen(false);
          }}
          className={`flex flex-col items-center justify-center min-w-[56px] py-1 px-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            currentTab === 'inventory'
              ? 'text-emerald-600 dark:text-emerald-400 font-black'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Boxes className={`w-5 h-5 ${currentTab === 'inventory' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px] mt-0.5">الأصناف</span>
        </button>

        {/* 5. More / Full Menu Drawer */}
        <button
          type="button"
          onClick={() => setIsMobileMenuOpen(true)}
          className={`flex flex-col items-center justify-center min-w-[56px] py-1 px-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            isMobileMenuOpen
              ? 'text-emerald-600 dark:text-emerald-400 font-black'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Menu className="w-5 h-5" />
          <span className="text-[10px] mt-0.5">كل الأقسام</span>
        </button>
      </nav>

      {/* Printable Invoice Modal (Triggered on save or reprint) */}
      {activePrintInvoice && (
        <PrintableInvoice
          invoice={activePrintInvoice}
          onClose={() => setActivePrintInvoice(null)}
        />
      )}

      {/* User Login & Lock Screen Modal */}
      {(isLocked || isLoginOpen) && (
        <LoginModal
          users={users}
          currentUser={currentUser}
          isLockScreen={isLocked}
          onLoginSuccess={(user) => {
            setCurrentUser(user);
            setIsLocked(false);
            setIsLoginOpen(false);
            refreshAll();
          }}
          onClose={() => {
            if (!isLocked) setIsLoginOpen(false);
          }}
        />
      )}
    </div>
  );
}
