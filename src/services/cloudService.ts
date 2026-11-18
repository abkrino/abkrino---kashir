import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  Auth,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  Firestore,
  FirestoreSettings,
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
  CloudSettings,
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

const LOCAL_STORAGE_KEYS = {
  CLOUD_SETTINGS: 'sm_cloud_settings_v1',
  AUTH_CACHE: 'sm_cloud_auth_cache_v1',
  LOCAL_ALERTS: 'sm_cloud_local_alerts_v1',
  LOCAL_CRASHES: 'sm_cloud_local_crashes_v1',
  LOCAL_PERF: 'sm_cloud_local_perf_v1',
};

class CloudService {
  private isOnlineStatus: boolean = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  private syncInProgress: boolean = false;
  private currentFirebaseUser: FirebaseUser | null = null;
  private listeners: (() => void)[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnlineStatus = true;
        this.notifyListeners();
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

      // Seed initial alerts locally if empty
      this.initDefaultAlerts();
    }
  }

  public isConfigured(): boolean {
    return isCloudConfigured && db !== null && auth !== null;
  }

  // --- SETTINGS ---
  public getCloudSettings(): CloudSettings {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.CLOUD_SETTINGS);
      if (data) return JSON.parse(data);
    } catch {}

    const defaults: CloudSettings = {
      autoSyncOnAction: true,
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
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.CLOUD_SETTINGS, JSON.stringify(settings));
    } catch {}
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
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return this.isOnlineStatus && navigator.onLine;
    }
    return this.isOnlineStatus;
  }

  public isSyncing(): boolean {
    return this.syncInProgress;
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
    try {
      localStorage.setItem('sm_linked_store_v1', JSON.stringify(storeData));
    } catch {}
    this.notifyListeners();
  }

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

  // --- LOCAL-ONLY CACHED BACKUPS STUB (No Firestore calls to stores/*) ---
  public async getCloudBackupsList(): Promise<CloudBackupItem[]> {
    return this.getLocalCachedBackups();
  }

  private getLocalCachedBackups(): CloudBackupItem[] {
    try {
      const data = localStorage.getItem('sm_cached_cloud_backups');
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  // --- LOCAL-ONLY ALERTS (No Firestore writes to stores/*) ---
  public getAlerts(): CloudAlert[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public addAlert(
    title: string,
    body: string,
    type: 'STOCK' | 'EXPIRY' | 'FINANCE' | 'SYSTEM' | 'SYNC',
    priority: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL',
    linkTab?: string
  ): void {
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
          },
        ];
        localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(initial));
      }
    } catch {}
  }

  // --- LOCAL-ONLY CRASH LOGS (No Firestore writes to stores/*) ---
  public getCrashReports(): CrashReport[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public logCrash(
    message: string,
    component: string,
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    stack?: string
  ): void {
    const crashes = this.getCrashReports();
    const newCrash: CrashReport = {
      id: `crash-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message,
      component,
      severity,
      stack: stack || new Error().stack,
      resolved: false,
      offlineOccurred: !this.isOnline(),
    };
    crashes.unshift(newCrash);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes.slice(0, 100)));
    } catch {}
    this.notifyListeners();
  }

  public resolveCrash(crashId: string): void {
    const crashes = this.getCrashReports().map(c => c.id === crashId ? { ...c, resolved: true } : c);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes.slice(0, 100)));
    } catch {}
    this.notifyListeners();
  }

  // --- LOCAL-ONLY PERFORMANCE METRICS (No Firestore writes to stores/* or test/*) ---
  public getPerformanceMetrics(): PerformanceMetric[] {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_PERF);
      if (data) return JSON.parse(data);
    } catch {}
    return [];
  }

  public logPerformance(
    operation: string,
    durationMs: number,
    status: 'SUCCESS' | 'SLOW' | 'FAILED'
  ): void {
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
  }

  public async measureCloudLatency(): Promise<number> {
    // Deprecated legacy test/connection check removed to avoid Firestore permission-denied errors.
    return 0;
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
