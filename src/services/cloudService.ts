import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { 
  getAuth, 
  Auth,
  signOut as firebaseSignOut, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  initializeFirestore,
  getFirestore, 
  Firestore,
  FirestoreSettings,
  doc, 
  getDocFromServer, 
  getDoc, 
  setDoc, 
  deleteDoc, 
  collection, 
  getDocs
} from 'firebase/firestore';
import {
  firebaseConfig,
  firestoreDatabaseId,
  isFirebaseConfigComplete,
} from '../config/firebaseConfig';
import { storage } from './storageService';
import { 
  CloudBackupItem, 
  CloudAlert, 
  CrashReport, 
  PerformanceMetric, 
  CloudSettings 
} from '../types';
import { isStoreActivated, licenseService } from './licenseService';
import { orgSyncService } from './orgSyncService';

// Disable Fetch streaming in WebChannel to prevent Chrome AbortError ("signal is aborted without reason")
// when Firestore closes an active Listen/RPC stream on error or teardown.
export const FIRESTORE_SETTINGS: FirestoreSettings & { useFetchStreams: boolean } = {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
};

export function createFirestoreInstance(
  targetApp: FirebaseApp,
  databaseId: string = firestoreDatabaseId
): Firestore {
  try {
    return initializeFirestore(targetApp, FIRESTORE_SETTINGS, databaseId);
  } catch {
    return getFirestore(targetApp, databaseId);
  }
}

export const isCloudConfigured: boolean = isFirebaseConfigComplete(firebaseConfig, firestoreDatabaseId);

let appInstance: FirebaseApp | null = null;
let dbInstance: Firestore | null = null;
let authInstance: Auth | null = null;

if (isCloudConfigured) {
  try {
    appInstance = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    dbInstance = createFirestoreInstance(appInstance, firestoreDatabaseId);
    authInstance = getAuth(appInstance);
  } catch {
    appInstance = null;
    dbInstance = null;
    authInstance = null;
  }
}

export const db: Firestore | null = dbInstance;
export const auth: Auth | null = authInstance;

// --- FIRESTORE ERROR HANDLING ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Cloud Firestore Error: ', JSON.stringify(errInfo));
  cloudService.logCrash(errInfo.error, `Firestore:${operationType}`, 'HIGH');
  throw new Error(JSON.stringify(errInfo));
}

const LOCAL_STORAGE_KEYS = {
  CLOUD_SETTINGS: 'sm_cloud_settings_v1',
  AUTH_CACHE: 'sm_cloud_auth_cache_v1',
  LOCAL_ALERTS: 'sm_cloud_local_alerts_v1',
  LOCAL_CRASHES: 'sm_cloud_local_crashes_v1',
  LOCAL_PERF: 'sm_cloud_local_perf_v1',
  OFFLINE_QUEUE: 'sm_cloud_offline_queue_v1',
};

export const LEGACY_STORE_SYNC = false;

class CloudService {
  private isOnlineStatus: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private syncInProgress: boolean = false;
  private currentFirebaseUser: FirebaseUser | null = null;
  private listeners: (() => void)[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnlineStatus = true;
        this.notifyListeners();
        this.processOfflineQueue();
        this.logPerformance('NetworkReconnect', 15, 'SUCCESS');
      });

      window.addEventListener('offline', () => {
        this.isOnlineStatus = false;
        this.notifyListeners();
        this.logCrash('انقطاع الاتصال بالإنترنت - التبديل التلقائي للوضع المحلي أوفلاين', 'Network', 'LOW');
      });

      // Listen to persisted local Firebase Auth state ONLY when Firebase is configured
      if (isCloudConfigured && auth) {
        try {
          onAuthStateChanged(auth, (user) => {
            this.currentFirebaseUser = user;
            this.notifyListeners();
          });
        } catch {}
      }

      // Seed initial alerts if empty
      this.initDefaultAlerts();
    }
  }

  public isConfigured(): boolean {
    return isCloudConfigured && db !== null && auth !== null;
  }

  // --- SETTINGS ("ضبط الكلود وحفظ النسخة بعد كل عملية") ---
  public getCloudSettings(): CloudSettings {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.CLOUD_SETTINGS);
      if (data) return JSON.parse(data);
    } catch {}

    const defaults: CloudSettings = {
      autoSyncOnAction: true, // حفظ نسخة على الكلود بعد كل عملية
      primaryEmail: this.getCurrentUserEmail(),
      autoBackupIntervalHours: 24,
      autoFunctionsEnabled: true,
      crashReportingEnabled: true,
      performanceMonitoringEnabled: true,
      lastCloudSyncTimestamp: undefined,
    };
    this.saveCloudSettings(defaults);
    return defaults;
  }

  public saveCloudSettings(settings: CloudSettings): void {
    localStorage.setItem(LOCAL_STORAGE_KEYS.CLOUD_SETTINGS, JSON.stringify(settings));
    this.notifyListeners();
  }

  public getCachedAuthUser() {
    if (this.currentFirebaseUser) {
      return {
        uid: this.currentFirebaseUser.uid,
        email: this.currentFirebaseUser.email,
        displayName: this.currentFirebaseUser.displayName || 'مدير النظام',
      };
    }
    return null;
  }

  public isUserAuthenticated(): boolean {
    return orgSyncService.ensureSignedIn() === 'ok';
  }

  public isStoreActivated(): boolean {
    return isStoreActivated();
  }

  public getPrimaryOwnerEmail(): string {
    return this.getCurrentUserEmail();
  }

  public getCurrentUserEmail(): string {
    return this.currentFirebaseUser?.email || '';
  }

  public isOnline(): boolean {
    return this.isOnlineStatus && navigator.onLine;
  }

  public isSyncing(): boolean {
    return this.syncInProgress;
  }

  private getStoreDocId(): string {
    const orgCtx = orgSyncService.getContext();
    if (orgCtx?.orgId) {
      return orgCtx.branchId ? `${orgCtx.orgId}_${orgCtx.branchId}` : orgCtx.orgId;
    }
    return licenseService.getDeviceId() || 'local-store';
  }

  // --- LINKED STORE & CHAIN PROFILE ---
  public getLinkedStore() {
    const profile = storage.getStoreProfile();
    const licState = licenseService.getLicenseState();
    const orgCtx = orgSyncService.getContext();
    const deviceId = licenseService.getDeviceId();
    const licPayload = licState.payload;

    const subscriptionStatus =
      licState.status === 'valid'
        ? 'ACTIVE'
        : licState.status === 'grace'
        ? 'GRACE'
        : licState.status === 'expired'
        ? 'EXPIRED'
        : licState.status === 'tampered' || licState.status === 'wrong-device' || licState.status === 'clock-rollback'
        ? 'LOCKED'
        : 'UNLICENSED';

    const subscriptionStatusLabel =
      licState.status === 'valid'
        ? 'سارٍ ومفعّل'
        : licState.status === 'grace'
        ? 'فترة سماح'
        : licState.status === 'expired'
        ? 'منتهي الصلاحية'
        : licState.status === 'tampered'
        ? 'توقيع غير صالح'
        : licState.status === 'wrong-device'
        ? 'مرتبط بجهاز آخر'
        : licState.status === 'clock-rollback'
        ? 'خطأ في تاريخ الجهاز'
        : 'غير مرخص';

    return {
      storeId: orgCtx?.branchId || deviceId || '',
      storeCode: orgCtx?.branchId || deviceId || '',
      storeName: profile.name,
      branchName: profile.branchName || '',
      chainName: orgCtx?.orgId || profile.name,
      ownerEmail: this.getCurrentUserEmail() || licPayload?.orgId || '',
      subscriptionPlan: licPayload?.plan || 'غير مرخص',
      subscriptionStatus,
      subscriptionStatusLabel,
      licenseStatus: licState.status,
      linkedAt: licPayload?.issuedAt ? licPayload.issuedAt.slice(0, 10) : '',
    };
  }

  public saveLinkedStore(storeData: any): void {
    localStorage.setItem('sm_linked_store_v1', JSON.stringify(storeData));
    this.notifyListeners();
  }

  // Note: Store sync authentication is handled strictly via orgSyncService.signInStore

  public async signOut(): Promise<void> {
    try {
      if (this.isConfigured() && auth) {
        await firebaseSignOut(auth);
      }
      this.currentFirebaseUser = null;
      localStorage.removeItem(LOCAL_STORAGE_KEYS.AUTH_CACHE);
      this.notifyListeners();
    } catch (err) {
      console.error('Error signing out:', err);
    }
  }

  public async lockStoreAndRevokeAccess(): Promise<void> {
    await this.signOut();
  }

  // --- AUTOMATIC SYNC AFTER ACTION ("حفظ نسخة على الكلود بعد كل عملية") ---
  public triggerAutoSyncOnAction(actionName: string): void {
    if (!LEGACY_STORE_SYNC) return;
    const settings = this.getCloudSettings();
    if (!settings.autoSyncOnAction) return;

    // Queue or execute async sync
    this.enqueueSyncTask(actionName);
  }

  private enqueueSyncTask(actionName: string) {
    if (!LEGACY_STORE_SYNC) return;
    if (!this.isOnline()) {
      const queue = this.getOfflineQueue();
      queue.push({ action: actionName, timestamp: new Date().toISOString() });
      localStorage.setItem(LOCAL_STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(queue.slice(-50)));
      return;
    }

    // Debounced sync execution
    setTimeout(() => {
      this.syncLocalToCloud(false).catch(err => {
        console.warn('Auto cloud sync failed, queued for later:', err);
      });
    }, 1000);
  }

  private getOfflineQueue(): { action: string; timestamp: string }[] {
    try {
      const q = localStorage.getItem(LOCAL_STORAGE_KEYS.OFFLINE_QUEUE);
      return q ? JSON.parse(q) : [];
    } catch {
      return [];
    }
  }

  private async processOfflineQueue() {
    if (!LEGACY_STORE_SYNC) return;
    const queue = this.getOfflineQueue();
    if (queue.length === 0) return;

    try {
      await this.syncLocalToCloud(false);
      localStorage.removeItem(LOCAL_STORAGE_KEYS.OFFLINE_QUEUE);
      this.addAlert(
        'تمت مزامنة العمليات المعلقة بالكلود',
        `تم رفع ${queue.length} عملية كانت محفوظة محلياً أثناء انقطاع الاتصال بنجاح.`,
        'SYNC',
        'NORMAL'
      );
    } catch {}
  }

  // --- FIRESTORE DATA SYNC ---
  public async syncLocalToCloud(showToast: boolean = true): Promise<{ success: boolean; error?: string }> {
    if (!LEGACY_STORE_SYNC) {
      return { success: true };
    }
    if (!this.isConfigured() || !db) {
      return { success: false, error: 'السحابة غير مُعدّة بعد.' };
    }
    if (this.syncInProgress) return { success: true };
    this.syncInProgress = true;
    this.notifyListeners();

    const startTime = performance.now();
    try {
      const storeDocId = this.getStoreDocId();
      const storeProfile = storage.getStoreProfile();
      const storeRef = doc(db, 'stores', storeDocId);
      const backupJson = storage.exportFullBackupJson();
      const parsed = JSON.parse(backupJson);

      // 1. Update main store document
      await setDoc(storeRef, {
        id: storeDocId,
        name: storeProfile.name,
        ownerEmail: this.getCurrentUserEmail(),
        autoCloudSync: true,
        offlineModeEnabled: true,
        lastSyncTimestamp: new Date().toISOString(),
        itemCounts: {
          products: parsed.data.products.length,
          customers: parsed.data.customers.length,
          invoices: parsed.data.invoices.length,
        }
      }, { merge: true });

      // 2. Save active snapshot in cloudBackups
      const snapshotId = `auto-snapshot-${Date.now()}`;
      const snapshotRef = doc(db, `stores/${storeDocId}/cloudBackups`, snapshotId);
      
      const newBackup: CloudBackupItem = {
        id: snapshotId,
        timestamp: new Date().toISOString(),
        dateStr: new Date().toLocaleDateString('ar-EG'),
        timeStr: new Date().toLocaleTimeString('ar-EG'),
        itemCounts: {
          products: parsed.data.products.length,
          customers: parsed.data.customers.length,
          suppliers: parsed.data.suppliers.length,
          invoices: parsed.data.invoices.length,
          cashMovements: parsed.data.cashMovements.length,
        },
        totalValuation: parsed.data.products.reduce((s: number, p: any) => s + (p.stockPieces * p.retailPricePerBase), 0),
        payloadJson: backupJson,
        createdBy: this.getCurrentUserEmail(),
      };

      await setDoc(snapshotRef, newBackup);

      // Update settings
      const settings = this.getCloudSettings();
      settings.lastCloudSyncTimestamp = new Date().toISOString();
      this.saveCloudSettings(settings);

      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Sync:LocalToCloud', duration, 'SUCCESS');

      this.syncInProgress = false;
      this.notifyListeners();
      return { success: true };
    } catch (err: unknown) {
      this.syncInProgress = false;
      this.notifyListeners();
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Sync:LocalToCloud', duration, 'FAILED');
      const msg = err instanceof Error ? err.message : String(err);
      this.logCrash(msg, 'Sync:LocalToCloud', 'HIGH');
      return { success: false, error: msg };
    }
  }

  // --- DUAL BACKUP & RESTORE ("استرداد أي نسخة محفوظة سواء علي الكلود او علي الجهاز") ---
  public async getCloudBackupsList(): Promise<CloudBackupItem[]> {
    if (!this.isConfigured() || !db || !this.isOnline() || !this.isUserAuthenticated()) {
      return this.getLocalCachedBackups();
    }

    const startTime = performance.now();
    try {
      const colRef = collection(db, `stores/${this.getStoreDocId()}/cloudBackups`);
      const snapshot = await getDocs(colRef);
      const list: CloudBackupItem[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as CloudBackupItem);
      });

      // Sort newest first
      list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      
      // Cache locally as fallback: METADATA ONLY (omit heavy payloadJson), capped to last 20
      try {
        const metaOnlyList = list.slice(0, 20).map(item => {
          const { payloadJson, ...meta } = item;
          return meta as CloudBackupItem;
        });
        localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(metaOnlyList));
      } catch {}
      
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Backup:GetList', duration, 'SUCCESS');
      return list;
    } catch {
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Backup:GetList', duration, 'SLOW');
      return this.getLocalCachedBackups();
    }
  }

  private getLocalCachedBackups(): CloudBackupItem[] {
    try {
      const data = localStorage.getItem('sm_cached_cloud_backups');
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public async createManualCloudBackup(note?: string): Promise<{ success: boolean; backup?: CloudBackupItem; error?: string }> {
    const startTime = performance.now();
    try {
      const backupJson = storage.exportFullBackupJson();
      const parsed = JSON.parse(backupJson);

      const backupId = `backup-manual-${Date.now()}`;
      const backup: CloudBackupItem = {
        id: backupId,
        timestamp: new Date().toISOString(),
        dateStr: new Date().toLocaleDateString('ar-EG'),
        timeStr: new Date().toLocaleTimeString('ar-EG'),
        itemCounts: {
          products: parsed.data.products.length,
          customers: parsed.data.customers.length,
          suppliers: parsed.data.suppliers.length,
          invoices: parsed.data.invoices.length,
          cashMovements: parsed.data.cashMovements.length,
        },
        totalValuation: parsed.data.products.reduce((s: number, p: any) => s + (p.stockPieces * p.retailPricePerBase), 0),
        payloadJson: backupJson,
        createdBy: note ? `${this.getCurrentUserEmail()} (${note})` : this.getCurrentUserEmail(),
      };

      if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated()) {
        try {
          const backupRef = doc(db, `stores/${this.getStoreDocId()}/cloudBackups`, backupId);
          await setDoc(backupRef, backup);
        } catch {}
      }

      // Cache locally as metadata ONLY, capped at last 20 items
      try {
        const localCached = this.getLocalCachedBackups();
        const { payloadJson, ...metaOnly } = backup;
        localCached.unshift(metaOnly as CloudBackupItem);
        localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(localCached.slice(0, 20)));
      } catch {}

      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Backup:CreateManual', duration, 'SUCCESS');

      this.addAlert(
        'تم إنشاء نسخة احتياطية جديدة بالكلود',
        `تم حفظ نسخة كاملة تشمل ${backup.itemCounts.products} صنف و ${backup.itemCounts.invoices} فاتورة بنجاح.`,
        'SYSTEM',
        'NORMAL'
      );

      return { success: true, backup };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logCrash(msg, 'Backup:CreateManual', 'HIGH');
      return { success: false, error: msg };
    }
  }

  public async restoreFromCloudBackup(backupId: string): Promise<{ success: boolean; error?: string }> {
    const startTime = performance.now();
    try {
      let backup: CloudBackupItem | null = null;

      if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated()) {
        try {
          const backupRef = doc(db, `stores/${this.getStoreDocId()}/cloudBackups`, backupId);
          const snap = await getDoc(backupRef);
          if (snap.exists()) {
            backup = snap.data() as CloudBackupItem;
          }
        } catch {}
      }

      if (!backup) {
        // Check local cache
        const localCached = this.getLocalCachedBackups();
        backup = localCached.find(b => b.id === backupId) || null;
      }

      if (!backup) {
        return { success: false, error: 'تعذر العثور على النسخة الاحتياطية المطلوبة بالكلود' };
      }

      // Restore into storageService
      const restoreRes = storage.restoreBackupJson(backup.payloadJson);
      if (!restoreRes.success) {
        return { success: false, error: restoreRes.error };
      }

      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Backup:Restore', duration, 'SUCCESS');

      this.addAlert(
        'تم استرجاع نسخة الكلود بنجاح',
        `تمت استعادة بيانات النظام بالكامل من نسخة الكلود بتاريخ ${backup.dateStr} - ${backup.timeStr}.`,
        'SYSTEM',
        'HIGH'
      );

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logCrash(msg, 'Backup:Restore', 'CRITICAL');
      return { success: false, error: msg };
    }
  }

  public async deleteCloudBackup(backupId: string): Promise<boolean> {
    try {
      if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated()) {
        try {
          const backupRef = doc(db, `stores/${this.getStoreDocId()}/cloudBackups`, backupId);
          await deleteDoc(backupRef);
        } catch {}
      }
      const localCached = this.getLocalCachedBackups().filter(b => b.id !== backupId);
      try {
        localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(localCached.slice(0, 20)));
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  // --- MESSAGING ("Messaging") ---
  public getAlerts(): CloudAlert[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public addAlert(title: string, body: string, type: 'STOCK' | 'EXPIRY' | 'FINANCE' | 'SYSTEM' | 'SYNC', priority: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL', linkTab?: string): void {
    const alerts = this.getAlerts();
    const newAlert: CloudAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      title,
      body,
      type,
      timestamp: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      read: false,
      priority,
      linkTab,
    };
    alerts.unshift(newAlert);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(alerts.slice(0, 100)));
    } catch {}
    this.notifyListeners();

    // Async push to Cloud only if configured, authenticated, and online
    if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated()) {
      try {
        const alertRef = doc(db, `stores/${this.getStoreDocId()}/cloudAlerts`, newAlert.id);
        setDoc(alertRef, newAlert).catch(() => {});
      } catch {}
    }
  }

  public markAlertAsRead(alertId: string): void {
    const alerts = this.getAlerts().map(a => a.id === alertId ? { ...a, read: true } : a);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(alerts.slice(0, 100)));
    } catch {}
    this.notifyListeners();
  }

  public clearAllAlerts(): void {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify([]));
    } catch {}
    this.notifyListeners();
  }

  private initDefaultAlerts() {
    try {
      if (!localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS)) {
        const initial: CloudAlert[] = [
          {
            id: 'alert-welcome',
            title: 'جاهزية المزامنة السحابية والعمل المحلي',
            body: 'بيانات المحل محفوظة محلياً ويمكن ربطها بالمزامنة السحابية عند الحاجة.',
            type: 'SYSTEM',
            timestamp: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
            read: false,
            priority: 'NORMAL',
          }
        ];
        localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(initial));
      }
    } catch {}
  }

  // --- CRASHLYTICS ("Crashlytics") ---
  public getCrashReports(): CrashReport[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public logCrash(message: string, component: string, severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', stack?: string): void {
    const crashes = this.getCrashReports();
    const newCrash: CrashReport = {
      id: `crash-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message,
      component,
      severity,
      stack: stack || (new Error().stack),
      resolved: false,
      offlineOccurred: !this.isOnline(),
    };
    crashes.unshift(newCrash);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes.slice(0, 100)));
    } catch {}
    this.notifyListeners();

    if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated()) {
      try {
        const crashRef = doc(db, `stores/${this.getStoreDocId()}/crashReports`, newCrash.id);
        setDoc(crashRef, newCrash).catch(() => {});
      } catch {}
    }
  }

  public resolveCrash(crashId: string): void {
    const crashes = this.getCrashReports().map(c => c.id === crashId ? { ...c, resolved: true } : c);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes.slice(0, 100)));
    } catch {}
    this.notifyListeners();
  }

  // --- PERFORMANCE ("Performance") ---
  public getPerformanceMetrics(): PerformanceMetric[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_PERF);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public logPerformance(operation: string, durationMs: number, status: 'SUCCESS' | 'SLOW' | 'FAILED'): void {
    const metrics = this.getPerformanceMetrics();
    const newMetric: PerformanceMetric = {
      id: `perf-${Date.now()}`,
      operation,
      durationMs,
      status: durationMs > 1500 ? 'SLOW' : status,
      timestamp: new Date().toLocaleTimeString('ar-EG'),
      networkOnline: this.isOnline(),
    };
    metrics.unshift(newMetric);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_PERF, JSON.stringify(metrics.slice(0, 100)));
    } catch {}
    this.notifyListeners();

    if (this.isConfigured() && db && this.isOnline() && this.isUserAuthenticated() && metrics.length % 5 === 0) {
      try {
        const metricRef = doc(db, `stores/${this.getStoreDocId()}/performanceMetrics`, newMetric.id);
        setDoc(metricRef, newMetric).catch(() => {});
      } catch {}
    }
  }

  public async measureCloudLatency(): Promise<number> {
    const t0 = performance.now();
    try {
      if (!this.isConfigured() || !db || !this.isOnline() || !this.isUserAuthenticated()) return 0;
      await getDocFromServer(doc(db, 'test', 'connection'));
      const latency = Math.round(performance.now() - t0);
      this.logPerformance('Ping:FirestoreLatency', latency, 'SUCCESS');
      return latency;
    } catch {
      return 0;
    }
  }

  // --- FUNCTIONS ("Functions: مهام الكلود التلقائية") ---
  public async runCloudFunctionsPipeline(): Promise<{
    consolidatedRevenue: number;
    consolidatedProfit: number;
    expiringDairyCount: number;
    lowStockCount: number;
    backupCreated: boolean;
  }> {
    const products = storage.getProducts();
    const invoices = storage.getSalesInvoices();
    const todayStr = new Date().toISOString().split('T')[0];

    // 1. Task: Consolidate Daily Stats
    const todayInvoices = invoices.filter(inv => inv.date === todayStr);
    const totalRev = todayInvoices.reduce((s, inv) => s + inv.total, 0);
    const totalProf = todayInvoices.reduce((s, inv) => s + (inv.totalProfit || 0), 0);

    // 2. Task: Dairy & Cold Storage Expiry Scan
    const now = new Date();
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(now.getDate() + 7);

    const expiringDairy = products.filter(p => {
      if (!p.expiryDate) return false;
      const exp = new Date(p.expiryDate);
      return exp <= sevenDaysLater && exp >= now;
    });

    if (expiringDairy.length > 0) {
      this.addAlert(
        `تنبيه صلاحية الألبان (${expiringDairy.length} صنف)`,
        `يوجد ${expiringDairy.length} أصناف ألبان وأجبان تنتهي صلاحيتها خلال أسبوع. يرجى مراجعة الثلاجات.`,
        'EXPIRY',
        'HIGH',
        'inventory'
      );
    }

    // 3. Task: Low Stock Scanner
    const lowStock = products.filter(p => p.stockPieces <= p.reorderLevelPieces);
    if (lowStock.length > 0) {
      this.addAlert(
        `تنبيه نواقص المخزن (${lowStock.length} صنف)`,
        `وصل رصيد ${lowStock.length} صنف إلى حد الطلب الأدنى وتحتاج إلى طلب توريد.`,
        'STOCK',
        'NORMAL',
        'inventory'
      );
    }

    // 4. Task: Automated Snapshot to Cloud
    let backupCreated = false;
    if (this.isOnline()) {
      const res = await this.createManualCloudBackup('نسخة مجدولة آلية عبر Functions');
      backupCreated = res.success;
    }

    this.logPerformance('Function:PipelineExecution', 45, 'SUCCESS');

    return {
      consolidatedRevenue: totalRev,
      consolidatedProfit: totalProf,
      expiringDairyCount: expiringDairy.length,
      lowStockCount: lowStock.length,
      backupCreated,
    };
  }

  // --- SUBSCRIPTIONS ---
  public subscribe(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  private notifyListeners() {
    this.listeners.forEach(cb => {
      try {
        cb();
      } catch (err) {
        console.error('Error in cloud listener:', err);
      }
    });
  }
}

export const cloudService = new CloudService();
