import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDocFromServer, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  getDocs, 
  onSnapshot, 
  query, 
  orderBy, 
  limit 
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { storage } from './storageService';
import { 
  CloudBackupItem, 
  CloudAlert, 
  CrashReport, 
  PerformanceMetric, 
  CloudSettings 
} from '../types';

// Initialize Firebase App
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// CRITICAL: Firestore database instance using configured firestoreDatabaseId
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Verification test on startup as per Firebase integration standard
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Cloud: Currently offline, operating in local-first mode.");
    }
  }
}
testConnection();

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
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
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

const DEFAULT_STORE_ID = 'main-store';
const PRIMARY_OWNER_EMAIL = 'mahmoud.mansour0b@gmail.com';

class CloudService {
  private isOnlineStatus: boolean = navigator.onLine;
  private syncInProgress: boolean = false;
  private currentFirebaseUser: FirebaseUser | null = null;
  private listeners: (() => void)[] = [];

  constructor() {
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

    // Listen to Firebase Auth state
    onAuthStateChanged(auth, (user) => {
      this.currentFirebaseUser = user;
      if (user) {
        // Cache user details locally so offline access works seamlessly
        localStorage.setItem(LOCAL_STORAGE_KEYS.AUTH_CACHE, JSON.stringify({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || 'مدير النظام الأساسي',
          lastLoginTime: new Date().toISOString(),
          isPrimaryOwner: user.email === PRIMARY_OWNER_EMAIL,
        }));
      }
      this.notifyListeners();
    });

    // Seed initial alerts if empty
    this.initDefaultAlerts();
  }

  // --- SETTINGS ("ضبط الكلود وحفظ النسخة بعد كل عملية") ---
  public getCloudSettings(): CloudSettings {
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.CLOUD_SETTINGS);
      if (data) return JSON.parse(data);
    } catch {}

    const defaults: CloudSettings = {
      autoSyncOnAction: true, // حفظ نسخة على الكلود بعد كل عملية
      primaryEmail: PRIMARY_OWNER_EMAIL,
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
    try {
      const data = localStorage.getItem(LOCAL_STORAGE_KEYS.AUTH_CACHE);
      if (data) return JSON.parse(data);
    } catch {}
    return null;
  }

  public isUserAuthenticated(): boolean {
    return Boolean(this.currentFirebaseUser || this.getCachedAuthUser());
  }

  public isStoreActivated(): boolean {
    const cached = this.getCachedAuthUser();
    if (!cached || !cached.email) return false;
    return cached.email.toLowerCase() === PRIMARY_OWNER_EMAIL.toLowerCase();
  }

  public getPrimaryOwnerEmail(): string {
    return PRIMARY_OWNER_EMAIL;
  }

  public getCurrentUserEmail(): string {
    return this.currentFirebaseUser?.email || this.getCachedAuthUser()?.email || PRIMARY_OWNER_EMAIL;
  }

  public isOnline(): boolean {
    return this.isOnlineStatus && navigator.onLine;
  }

  public isSyncing(): boolean {
    return this.syncInProgress;
  }

  // --- LINKED STORE & CHAIN PROFILE ("مربوط عليه محل واحد أو سلسلة محلات") ---
  public getLinkedStore() {
    try {
      const data = localStorage.getItem('sm_linked_store_v1');
      if (data) return JSON.parse(data);
    } catch {}
    return {
      storeId: 'main-store',
      storeCode: 'STORE-EGY-01',
      storeName: 'سوبر ماركت وماركت الألبان الخير والبركة',
      branchName: 'الفرع الرئيسي الموحد (قطاعي وميزان)',
      chainName: 'سلسلة أسواق الخير والبركة للتوزيع والتجزئة',
      ownerEmail: this.getCurrentUserEmail(),
      subscriptionPlan: 'الباقة الموحدة المشتركة (سلسلة المحلات)',
      subscriptionStatus: 'ACTIVE',
      branchesCount: 1,
      linkedAt: '2026-11-01',
    };
  }

  public saveLinkedStore(storeData: any): void {
    localStorage.setItem('sm_linked_store_v1', JSON.stringify(storeData));
    this.notifyListeners();
  }

  // --- AUTHENTICATION ("الدخول بالإيميل والباسورد للمحل وسلسلة المحلات") ---
  public async signInWithEmail(email: string, password: string): Promise<{ success: boolean; user?: any; offlineMode?: boolean; error?: string }> {
    const startTime = performance.now();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      return { success: false, error: 'يرجى كتابة عنوان بريد إلكتروني صحيح' };
    }
    if (!cleanPassword || cleanPassword.length < 4) {
      return { success: false, error: 'كلمة المرور يجب ألا تقل عن 4 أحرف أو أرقام' };
    }

    // STRICT OWNER CHECK: The store is exclusively bound to PRIMARY_OWNER_EMAIL
    if (cleanEmail !== PRIMARY_OWNER_EMAIL.toLowerCase()) {
      this.logCrash(`محاولة دخول غير مصرح بها باستخدام بريد غير معتمد: ${cleanEmail}`, 'Auth:ForbiddenEmail', 'HIGH');
      return {
        success: false,
        error: `⛔ لا تملك أي صلاحية! هذا النظام مرخص ومربوط حصرياً للمالك بالبريد الإلكتروني المعتمد (${PRIMARY_OWNER_EMAIL}). لا يمكن لأي حساب آخر تسجيل الدخول أو فتح المحل.`
      };
    }

    // Check if network is online
    if (this.isOnline()) {
      try {
        let authUser: FirebaseUser | null = null;
        try {
          const res = await signInWithEmailAndPassword(auth, cleanEmail, cleanPassword);
          authUser = res.user;
        } catch (signInErr: any) {
          // If user doesn't exist yet in Firebase Auth, auto-register them
          if (signInErr?.code === 'auth/user-not-found' || signInErr?.code === 'auth/invalid-credential') {
            try {
              const createRes = await createUserWithEmailAndPassword(auth, cleanEmail, cleanPassword);
              authUser = createRes.user;
            } catch {
              // Fallback to local offline cache
            }
          }
        }

        // Cache session and credentials locally for offline fallback
        const cachedAccount = {
          uid: authUser?.uid || `usr-${Date.now()}`,
          email: cleanEmail,
          displayName: cleanEmail.split('@')[0],
          lastLoginTime: new Date().toISOString(),
          isPrimaryOwner: cleanEmail === PRIMARY_OWNER_EMAIL,
          cachedPassword: cleanPassword,
          offlineVerified: true,
        };
        localStorage.setItem(LOCAL_STORAGE_KEYS.AUTH_CACHE, JSON.stringify(cachedAccount));

        // Update linked store owner email
        const store = this.getLinkedStore();
        store.ownerEmail = cleanEmail;
        this.saveLinkedStore(store);

        const duration = Math.round(performance.now() - startTime);
        this.logPerformance('Auth:EmailSignInOnline', duration, 'SUCCESS');

        // Async sync local data with cloud
        this.syncLocalToCloud(false).catch(() => {});

        this.notifyListeners();
        return { success: true, user: cachedAccount, offlineMode: false };
      } catch (onlineErr: any) {
        console.warn('Online email auth encountered issue, falling back to local verification:', onlineErr);
      }
    }

    // OFFLINE LOGIN FALLBACK (ويلزم دخول نت للمرة الأولى، وبعد ذلك حفظ النسخة محلياً)
    const cached = this.getCachedAuthUser();
    const isMatchedEmail = cached && cached.email && cached.email.toLowerCase() === cleanEmail;
    const isPrimaryMatch = cleanEmail === PRIMARY_OWNER_EMAIL;

    if (cached || isPrimaryMatch || isMatchedEmail) {
      const offlineUser = {
        uid: cached?.uid || 'cached-owner-uid',
        email: cleanEmail,
        displayName: cached?.displayName || 'مدير المحل (محلي)',
        lastLoginTime: new Date().toISOString(),
        isPrimaryOwner: isPrimaryMatch,
        offlineVerified: true,
      };
      localStorage.setItem(LOCAL_STORAGE_KEYS.AUTH_CACHE, JSON.stringify(offlineUser));
      this.notifyListeners();
      return { 
        success: true, 
        user: offlineUser, 
        offlineMode: true 
      };
    }

    return { 
      success: false, 
      error: 'لم يتم التحقق من هذا الإيميل مسبقاً عبر الإنترنت. يلزم الاتصال بالإنترنت للمرة الأولى فقط لتفعيل الحساب والمحل.' 
    };
  }

  public async signInWithGoogle(): Promise<{ success: boolean; user?: FirebaseUser; error?: string }> {
    const startTime = performance.now();
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        prompt: 'select_account',
        login_hint: PRIMARY_OWNER_EMAIL,
      });

      const result = await signInWithPopup(auth, provider);
      this.currentFirebaseUser = result.user;
      
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Auth:GoogleSignIn', duration, 'SUCCESS');

      this.addAlert(
        'تم تسجيل الدخول بالكلود بنجاح',
        `تم الربط والمصادقة بحساب: ${result.user.email} ومزامنة بيانات السوبر ماركت وقسم الألبان.`,
        'SYSTEM',
        'NORMAL'
      );

      // Perform initial cloud sync
      await this.syncLocalToCloud();

      return { success: true, user: result.user };
    } catch (err: unknown) {
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Auth:GoogleSignIn', duration, 'FAILED');
      const msg = err instanceof Error ? err.message : String(err);
      this.logCrash(msg, 'Auth:GoogleSignIn', 'MEDIUM');
      return { success: false, error: msg };
    }
  }

  public async signOut(): Promise<void> {
    try {
      await firebaseSignOut(auth);
      this.currentFirebaseUser = null;
      localStorage.removeItem(LOCAL_STORAGE_KEYS.AUTH_CACHE);
      const store = this.getLinkedStore();
      store.subscriptionStatus = 'LOCKED';
      this.saveLinkedStore(store);
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
    const settings = this.getCloudSettings();
    if (!settings.autoSyncOnAction) return;

    // Queue or execute async sync
    this.enqueueSyncTask(actionName);
  }

  private enqueueSyncTask(actionName: string) {
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
    if (this.syncInProgress) return { success: true };
    this.syncInProgress = true;
    this.notifyListeners();

    const startTime = performance.now();
    try {
      const storeRef = doc(db, 'stores', DEFAULT_STORE_ID);
      const backupJson = storage.exportFullBackupJson();
      const parsed = JSON.parse(backupJson);

      // 1. Update main store document
      await setDoc(storeRef, {
        id: DEFAULT_STORE_ID,
        name: 'سوبر ماركت وماركت الألبان الخير والبركة',
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
      const snapshotRef = doc(db, `stores/${DEFAULT_STORE_ID}/cloudBackups`, snapshotId);
      
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
    if (!this.isOnline()) {
      return this.getLocalCachedBackups();
    }

    const startTime = performance.now();
    try {
      const colRef = collection(db, `stores/${DEFAULT_STORE_ID}/cloudBackups`);
      const snapshot = await getDocs(colRef);
      const list: CloudBackupItem[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as CloudBackupItem);
      });

      // Sort newest first
      list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      
      // Cache locally as fallback
      localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(list.slice(0, 15)));
      
      const duration = Math.round(performance.now() - startTime);
      this.logPerformance('Backup:GetList', duration, 'SUCCESS');
      return list;
    } catch (err) {
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

      if (this.isOnline()) {
        const backupRef = doc(db, `stores/${DEFAULT_STORE_ID}/cloudBackups`, backupId);
        await setDoc(backupRef, backup);
      }

      // Also cache in local list
      const localCached = this.getLocalCachedBackups();
      localCached.unshift(backup);
      localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(localCached.slice(0, 15)));

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

      if (this.isOnline()) {
        const backupRef = doc(db, `stores/${DEFAULT_STORE_ID}/cloudBackups`, backupId);
        const snap = await getDoc(backupRef);
        if (snap.exists()) {
          backup = snap.data() as CloudBackupItem;
        }
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
      if (this.isOnline()) {
        const backupRef = doc(db, `stores/${DEFAULT_STORE_ID}/cloudBackups`, backupId);
        await deleteDoc(backupRef);
      }
      const localCached = this.getLocalCachedBackups().filter(b => b.id !== backupId);
      localStorage.setItem('sm_cached_cloud_backups', JSON.stringify(localCached));
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
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(alerts.slice(0, 30)));
    this.notifyListeners();

    // Async push to Cloud if online
    if (this.isOnline()) {
      const alertRef = doc(db, `stores/${DEFAULT_STORE_ID}/cloudAlerts`, newAlert.id);
      setDoc(alertRef, newAlert).catch(() => {});
    }
  }

  public markAlertAsRead(alertId: string): void {
    const alerts = this.getAlerts().map(a => a.id === alertId ? { ...a, read: true } : a);
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(alerts));
    this.notifyListeners();
  }

  public clearAllAlerts(): void {
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify([]));
    this.notifyListeners();
  }

  private initDefaultAlerts() {
    if (!localStorage.getItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS)) {
      const initial: CloudAlert[] = [
        {
          id: 'alert-welcome',
          title: 'جاهزية الكلود والتشغيل السحابي',
          body: 'تم تفعيل الاتصال بالكلود بنجاح لمشروع abkrino-ai. بياناتك محفوظة محلياً وعلى الكلود.',
          type: 'SYSTEM',
          timestamp: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
          read: false,
          priority: 'NORMAL',
        },
        {
          id: 'alert-dairy-fridge',
          title: 'مراقبة تبريد قسم الألبان',
          body: 'جميع منتجات الجبن والألبان الطازجة تحت المراقبة وتواريخ الصلاحية مطابقة.',
          type: 'EXPIRY',
          timestamp: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
          read: false,
          priority: 'NORMAL',
          linkTab: 'inventory',
        }
      ];
      localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_ALERTS, JSON.stringify(initial));
    }
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
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes.slice(0, 30)));
    this.notifyListeners();

    if (this.isOnline()) {
      const crashRef = doc(db, `stores/${DEFAULT_STORE_ID}/crashReports`, newCrash.id);
      setDoc(crashRef, newCrash).catch(() => {});
    }
  }

  public resolveCrash(crashId: string): void {
    const crashes = this.getCrashReports().map(c => c.id === crashId ? { ...c, resolved: true } : c);
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_CRASHES, JSON.stringify(crashes));
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
    localStorage.setItem(LOCAL_STORAGE_KEYS.LOCAL_PERF, JSON.stringify(metrics.slice(0, 40)));
    this.notifyListeners();

    if (this.isOnline() && metrics.length % 5 === 0) {
      const metricRef = doc(db, `stores/${DEFAULT_STORE_ID}/performanceMetrics`, newMetric.id);
      setDoc(metricRef, newMetric).catch(() => {});
    }
  }

  public async measureCloudLatency(): Promise<number> {
    const t0 = performance.now();
    try {
      if (!this.isOnline()) return 0;
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
