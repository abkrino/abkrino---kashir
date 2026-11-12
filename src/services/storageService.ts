import {
  Product, Customer, Supplier, SalesInvoice, PurchaseInvoice,
  CashMovement, Expense, AuditLog, SystemShift, User, StockAdjustment, ParkedCart,
  StoreProfile, DEFAULT_STORE_PROFILE, LEGACY_STORE_PROFILE
} from '../types';
import {
  INITIAL_PRODUCTS, INITIAL_CUSTOMERS, INITIAL_SUPPLIERS, INITIAL_SHIFT,
  INITIAL_EXPENSES, INITIAL_CASH_MOVEMENTS, INITIAL_INVOICES, INITIAL_USERS
} from '../data/initialData';
import { licenseService } from './licenseService';
import { idb, type KVRecord } from './idbStore';

export const STORAGE_KEYS = {
  PRODUCTS: 'sm_products_v3',
  CUSTOMERS: 'sm_customers_v3',
  SUPPLIERS: 'sm_suppliers_v3',
  INVOICES: 'sm_invoices_v3',
  PURCHASES: 'sm_purchases_v3',
  CASH_MOVEMENTS: 'sm_cash_movements_v3',
  EXPENSES: 'sm_expenses_v3',
  AUDIT_LOGS: 'sm_audit_logs_v3',
  STOCK_ADJUSTMENTS: 'sm_stock_adjustments_v3',
  SHIFT: 'sm_current_shift_v3',
  USERS: 'sm_users_v3',
  ACTIVE_USER_ID: 'pos_active_user_id',
  PARKED_CARTS: 'sm_parked_carts_v3',
  STORE_PROFILE: 'sm_store_profile_v1',
  STORE_PROFILE_REVIEWED: 'sm_store_profile_reviewed',
};

export const BUSINESS_KEYS = [
  STORAGE_KEYS.PRODUCTS,
  STORAGE_KEYS.CUSTOMERS,
  STORAGE_KEYS.SUPPLIERS,
  STORAGE_KEYS.INVOICES,
  STORAGE_KEYS.PURCHASES,
  STORAGE_KEYS.CASH_MOVEMENTS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.AUDIT_LOGS,
  STORAGE_KEYS.STOCK_ADJUSTMENTS,
  STORAGE_KEYS.SHIFT,
  STORAGE_KEYS.USERS,
  STORAGE_KEYS.ACTIVE_USER_ID,
  STORAGE_KEYS.PARKED_CARTS,
  STORAGE_KEYS.STORE_PROFILE,
];

class StorageService {
  private cache: Map<string, any> = new Map();
  private pendingWrites: Map<string, any> = new Map();
  private batchTimer: any = null;
  private activeCommitPromise: Promise<any> | null = null;
  private writeError: string | null = null;
  private writeErrorListeners: ((error: string | null) => void)[] = [];
  private migrationWarning: string | null = null;
  private isPersisted: boolean = false;
  private isFallback: boolean = false;
  private isReady: boolean = false;
  private migrationRecoveryRequired: boolean = false;
  private legacyBackupTimestamp: number = 0;
  private onActionCallbacks: ((actionName: string) => void)[] = [];
  private initPromise: Promise<void> | null = null;

  public onAction(cb: (actionName: string) => void): () => void {
    this.onActionCallbacks.push(cb);
    return () => {
      this.onActionCallbacks = this.onActionCallbacks.filter(c => c !== cb);
    };
  }

  public notifyAction(actionName: string): void {
    this.onActionCallbacks.forEach(cb => {
      try {
        cb(actionName);
      } catch (err) {
        console.error('Error in onAction callback:', err);
      }
    });
  }

  public getWriteError(): string | null {
    return this.writeError;
  }

  public setWriteError(error: string | null): void {
    this.writeError = error;
    this.writeErrorListeners.forEach(listener => {
      try { listener(error); } catch {}
    });
  }

  public onWriteError(cb: (error: string | null) => void): () => void {
    this.writeErrorListeners.push(cb);
    return () => {
      this.writeErrorListeners = this.writeErrorListeners.filter(l => l !== cb);
    };
  }

  public getMigrationWarning(): string | null {
    return this.migrationWarning;
  }

  public isStorageFallback(): boolean {
    return this.isFallback;
  }

  public isStoragePersisted(): boolean {
    return this.isPersisted;
  }

  public isStorageReady(): boolean {
    return this.isReady;
  }

  public hasLoadedData(): boolean {
    return this.cache.size > 0;
  }

  public isMigrationRecoveryRequired(): boolean {
    return this.migrationRecoveryRequired;
  }

  public getLegacyBackupTimestamp(): number {
    return this.legacyBackupTimestamp;
  }

  public getItem<T>(key: string, defaultValue: T): T {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.cache.set(key, parsed);
          return parsed as T;
        }
      } catch {
        // ignore
      }
    }
    return defaultValue;
  }

  public setItem<T>(key: string, value: T): void {
    // 1. Synchronously update in-memory cache
    this.cache.set(key, value);

    // 2. Synchronous write to localStorage if fallback mode is active
    if (this.isFallback && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err: any) {
        this.setWriteError('فشل التخزين في localStorage: ' + (err?.message || 'مساحة ممتلئة'));
      }
    }

    // 3. Queue asynchronous write-through to IndexedDB
    this.pendingWrites.set(key, value);
    this.scheduleBatchWrite();
  }

  private scheduleBatchWrite(): void {
    if (this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.commitPendingWrites().catch(err => {
        console.error('Error committing pending writes to IDB:', err);
      });
    }, 15);
  }

  private async commitPendingWrites(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const records: KVRecord[] = entries.map(([key, value]) => ({
      key,
      value,
      updatedAt: Date.now(),
    }));

    if (typeof indexedDB === 'undefined' || this.isFallback) {
      if (typeof localStorage !== 'undefined') {
        try {
          for (const rec of records) {
            localStorage.setItem(rec.key, JSON.stringify(rec.value));
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    try {
      this.activeCommitPromise = idb.kv.bulkPut(records);
      await this.activeCommitPromise;
    } catch (err: any) {
      console.error('IndexedDB write failure:', err);
      this.setWriteError(err?.message || 'تعذر حفظ البيانات في IndexedDB');
      // Emergency write to localStorage so data isn't lost from this session
      if (typeof localStorage !== 'undefined') {
        try {
          for (const rec of records) {
            localStorage.setItem(rec.key, JSON.stringify(rec.value));
          }
        } catch {
          // ignore
        }
      }
    } finally {
      this.activeCommitPromise = null;
    }
  }

  public async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await this.commitPendingWrites();
    }
    if (this.activeCommitPromise) {
      await this.activeCommitPromise;
    }
  }

  public init(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.internalInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async internalInit(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') {
        this.isFallback = true;
        this.migrationWarning = 'قاعدة بيانات IndexedDB غير متوفرة في هذا المتصفح، يعمل النظام عبر localStorage';
        this.loadFromLocalStorageIntoCache();
        this.initDatabase();
        this.isReady = true;
        return;
      }

      let idbCount = 0;
      let idbAvailable = true;

      try {
        idbCount = await idb.kv.count();
      } catch (err) {
        console.warn('IndexedDB not available or failed to open:', err);
        idbAvailable = false;
      }

      if (!idbAvailable) {
        this.isFallback = true;
        this.migrationWarning = 'قاعدة بيانات IndexedDB غير متوفرة في هذا المتصفح، يعمل النظام عبر localStorage';
        this.loadFromLocalStorageIntoCache();
        this.initDatabase();
        this.isReady = true;
        return;
      }

      let hasLocalStorageData = false;
      let migratedAtTimestamp: number | null = null;
      let migratedKeysCount = BUSINESS_KEYS.length;
      if (typeof localStorage !== 'undefined') {
        try {
          hasLocalStorageData = Boolean(localStorage.getItem(STORAGE_KEYS.PRODUCTS));
          const rawMigratedAt = localStorage.getItem('idb_migrated_at');
          if (rawMigratedAt) {
            migratedAtTimestamp = Number(rawMigratedAt);
          }
          const rawCount = localStorage.getItem('idb_migrated_keys_count');
          if (rawCount) {
            migratedKeysCount = Number(rawCount);
          }
        } catch {
          hasLocalStorageData = false;
        }
      }

      // REQUIREMENT 2: Anti-Regression Migration Protection
      // If idb_migrated_at is found AND IndexedDB is empty or incomplete (< migratedKeysCount),
      // DO NOT automatically copy from localStorage! Show explicit recovery alert screen.
      if (migratedAtTimestamp && (idbCount === 0 || idbCount < migratedKeysCount)) {
        this.migrationRecoveryRequired = true;
        this.legacyBackupTimestamp = migratedAtTimestamp;
        this.isReady = false;
        return;
      }

      // CASE 1: IndexedDB is empty, no previous migration recorded, and business data exists in localStorage -> ONE-TIME INITIAL MIGRATION
      if (idbCount === 0 && hasLocalStorageData && !migratedAtTimestamp) {
        const toMigrate: KVRecord[] = [];
        for (const key of BUSINESS_KEYS) {
          try {
            const raw = localStorage.getItem(key);
            if (raw !== null) {
              const val = JSON.parse(raw);
              toMigrate.push({
                key,
                value: val,
                updatedAt: Date.now(),
              });
            }
          } catch (e) {
            console.error(`Failed to read/parse ${key} from localStorage:`, e);
          }
        }

        if (toMigrate.length > 0) {
          try {
            await idb.kv.bulkPut(toMigrate);

            // Verification of record counts and integrity
            let verificationPassed = true;
            for (const rec of toMigrate) {
              const saved = await idb.kv.get(rec.key);
              if (!saved) {
                verificationPassed = false;
                break;
              }
              if (Array.isArray(rec.value)) {
                if (!Array.isArray(saved.value) || saved.value.length !== rec.value.length) {
                  verificationPassed = false;
                  break;
                }
              }
            }

            if (verificationPassed) {
              try {
                localStorage.setItem('idb_migrated_at', String(Date.now()));
                localStorage.setItem('idb_migrated_keys_count', String(toMigrate.length));
              } catch {}
              for (const rec of toMigrate) {
                this.cache.set(rec.key, rec.value);
              }
              this.isFallback = false;
            } else {
              // Verification failed! Fall back to localStorage with warning
              this.isFallback = true;
              this.migrationWarning = 'فشل التحقق من تطابق نقل البيانات إلى IndexedDB، يعمل النظام الآن من التخزين المحلي (localStorage)';
              this.loadFromLocalStorageIntoCache();
            }
          } catch (err: any) {
            console.error('Migration to IDB failed:', err);
            this.isFallback = true;
            this.migrationWarning = 'تعذر نسخ البيانات إلى IndexedDB، يعمل النظام الآن من التخزين المحلي (localStorage)';
            this.loadFromLocalStorageIntoCache();
          }
        } else {
          this.initDatabase();
        }
      } else if (idbCount > 0) {
        // CASE 2: IndexedDB has records -> Read all into in-memory cache
        const allRecords = await idb.kv.toArray();
        for (const rec of allRecords) {
          this.cache.set(rec.key, rec.value);
        }
        this.isFallback = false;

        // Clean up old localStorage business data ONLY after 30 days of documented successful migration
        if (typeof localStorage !== 'undefined') {
          try {
            const migratedAt = Number(localStorage.getItem('idb_migrated_at'));
            if (migratedAt && (Date.now() - migratedAt >= 30 * 24 * 60 * 60 * 1000)) {
              for (const k of BUSINESS_KEYS) {
                localStorage.removeItem(k);
              }
            }
          } catch {
            // ignore
          }
        }
      } else {
        // CASE 3: Both empty -> Seed database
        this.initDatabase();
        await this.flush();
      }

      // Check and request persistence
      if (typeof navigator !== 'undefined' && navigator.storage) {
        try {
          if (navigator.storage.persist) {
            this.isPersisted = await navigator.storage.persist();
          }
        } catch {
          // ignore
        }
      }

      this.isReady = true;
    } catch (err: any) {
      console.error('storage.init() critical error:', err);
      throw err;
    }
  }

  private loadFromLocalStorageIntoCache(): void {
    if (typeof localStorage === 'undefined') return;
    for (const key of BUSINESS_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          this.cache.set(key, JSON.parse(raw));
        }
      } catch {
        // ignore
      }
    }
  }

  public async restoreFromLegacyLocalStorage(): Promise<{ success: boolean; error?: string }> {
    const toMigrate: KVRecord[] = [];
    if (typeof localStorage === 'undefined') {
      return { success: false, error: 'التخزين المحلي غير متاح في هذا المتصفح' };
    }

    for (const key of BUSINESS_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          const val = JSON.parse(raw);
          toMigrate.push({
            key,
            value: val,
            updatedAt: Date.now(),
          });
        }
      } catch (e) {
        console.error(`Failed to read/parse ${key} from localStorage:`, e);
      }
    }

    if (toMigrate.length === 0) {
      return { success: false, error: 'لا توجد بيانات صالحة في النسخة القديمة للتخزين المحلي' };
    }

    try {
      if (typeof indexedDB !== 'undefined') {
        await idb.kv.bulkPut(toMigrate);
      }
      for (const rec of toMigrate) {
        this.cache.set(rec.key, rec.value);
      }
      try {
        localStorage.setItem('idb_migrated_at', String(Date.now()));
        localStorage.setItem('idb_migrated_keys_count', String(toMigrate.length));
      } catch {}

      this.migrationRecoveryRequired = false;
      this.isReady = true;
      this.isFallback = false;
      await this.flush();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'فشلت عملية الاستعادة إلى IndexedDB' };
    }
  }

  public async getStorageStatus(): Promise<{
    persisted: boolean;
    usageBytes: number;
    quotaBytes: number;
    migrationDate: string | null;
    isFallback: boolean;
    migrationWarning: string | null;
  }> {
    let persisted = this.isPersisted;
    let usageBytes = 0;
    let quotaBytes = 0;

    if (typeof navigator !== 'undefined' && navigator.storage) {
      try {
        if (navigator.storage.persisted) {
          persisted = await navigator.storage.persisted();
          this.isPersisted = persisted;
        }
        if (navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          usageBytes = est.usage || 0;
          quotaBytes = est.quota || 0;
        }
      } catch {
        // ignore
      }
    }

    let migrationDate: string | null = null;
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('idb_migrated_at');
      if (raw) {
        migrationDate = new Date(Number(raw)).toLocaleString('ar-EG');
      }
    }

    return {
      persisted,
      usageBytes,
      quotaBytes,
      migrationDate,
      isFallback: this.isFallback,
      migrationWarning: this.migrationWarning,
    };
  }

  public async requestPersistence(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      try {
        this.isPersisted = await navigator.storage.persist();
        return this.isPersisted;
      } catch {
        return false;
      }
    }
    return false;
  }

  // --- INITIALIZATION ---
  public initDatabase(seedDemoData: boolean = false): void {
    if (!this.cache.has(STORAGE_KEYS.PRODUCTS)) {
      this.setItem(STORAGE_KEYS.PRODUCTS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_PRODUCTS)) : []);
      this.setItem(STORAGE_KEYS.CUSTOMERS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_CUSTOMERS)) : []);
      this.setItem(STORAGE_KEYS.SUPPLIERS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_SUPPLIERS)) : []);
      this.setItem(STORAGE_KEYS.INVOICES, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_INVOICES)) : []);
      this.setItem(STORAGE_KEYS.PURCHASES, []);
      this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_CASH_MOVEMENTS)) : []);
      this.setItem(STORAGE_KEYS.EXPENSES, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_EXPENSES)) : []);
      this.setItem(STORAGE_KEYS.SHIFT, seedDemoData ? JSON.parse(JSON.stringify(INITIAL_SHIFT)) : null);
      this.setItem(STORAGE_KEYS.USERS, []);
      this.setItem(STORAGE_KEYS.PARKED_CARTS, []);
      this.setItem(STORAGE_KEYS.AUDIT_LOGS, []);
      this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, []);
      this.setItem(STORAGE_KEYS.STORE_PROFILE, seedDemoData ? JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE)) : JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE)));
      this.addAuditLog('SYSTEM', 'إعداد النظام', 'النظام', 'sys-0', 'تمت تهيئة نظام الكاشير وإدارة المبيعات');
    }
  }

  public loadDemoData(): void {
    this.setItem(STORAGE_KEYS.PRODUCTS, JSON.parse(JSON.stringify(INITIAL_PRODUCTS)));
    this.setItem(STORAGE_KEYS.CUSTOMERS, JSON.parse(JSON.stringify(INITIAL_CUSTOMERS)));
    this.setItem(STORAGE_KEYS.SUPPLIERS, JSON.parse(JSON.stringify(INITIAL_SUPPLIERS)));
    this.addAuditLog('SYSTEM', 'تحميل بيانات تجريبية', 'النظام', 'sys-demo', 'تم استيراد الأصناف والعملاء والموردين التجريبيين');
    this.notifyAction('تحميل بيانات تجريبية');
  }

  // --- STORE PROFILE MANAGEMENT ---
  public getStoreProfile(): StoreProfile {
    if (this.cache.has(STORAGE_KEYS.STORE_PROFILE)) {
      const cached = this.cache.get(STORAGE_KEYS.STORE_PROFILE);
      if (cached && typeof cached === 'object' && cached.name) {
        return cached as StoreProfile;
      }
    }

    // Check if we have an existing installation with business data
    const existingProducts = this.getItem<Product[]>(STORAGE_KEYS.PRODUCTS, []);
    const existingInvoices = this.getItem<SalesInvoice[]>(STORAGE_KEYS.INVOICES, []);
    const existingUsers = this.getItem<User[]>(STORAGE_KEYS.USERS, []);

    const hasLegacyData = (Array.isArray(existingProducts) && existingProducts.length > 0) ||
                          (Array.isArray(existingInvoices) && existingInvoices.length > 0) ||
                          (Array.isArray(existingUsers) && existingUsers.length > 0);

    if (hasLegacyData) {
      // Auto-create from legacy defaults with dairy & weighingScale enabled
      const legacyProfile: StoreProfile = JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE));
      this.setItem(STORAGE_KEYS.STORE_PROFILE, legacyProfile);
      // Mark as not reviewed so non-blocking banner is shown
      if (!this.cache.has(STORAGE_KEYS.STORE_PROFILE_REVIEWED)) {
        this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, false);
      }
      return legacyProfile;
    }

    // New installation: default store profile
    const defaultProfile: StoreProfile = JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE));
    return defaultProfile;
  }

  public saveStoreProfile(profile: StoreProfile): { success: boolean; error?: string } {
    if (!profile.name || !profile.name.trim()) {
      return { success: false, error: 'اسم المحل مطلوب' };
    }

    // Validate logo size (<= 100KB: 100 * 1024 bytes)
    if (profile.logo) {
      const approxBytes = Math.round((profile.logo.length * 3) / 4);
      if (approxBytes > 105 * 1024) {
        return { success: false, error: 'حجم اللوجو يتجاوز 100 كيلوبايت. يرجى اختيار صورة أصغر حجماً.' };
      }
    }

    // Ensure currency has a default
    if (!profile.currency || !profile.currency.trim()) {
      profile.currency = 'EGP';
    }

    // Ensure modules object exists with booleans
    profile.modules = {
      dairy: Boolean(profile.modules?.dairy),
      weighingScale: Boolean(profile.modules?.weighingScale),
      delivery: Boolean(profile.modules?.delivery),
    };

    this.setItem(STORAGE_KEYS.STORE_PROFILE, profile);
    this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
    this.addAuditLog('SYSTEM', 'تعديل بيانات المحل', 'الإعدادات', 'admin', `تم تحديث بيانات المحل: ${profile.name}`);
    this.notifyAction(`تحديث بيانات المحل: ${profile.name}`);
    return { success: true };
  }

  public isStoreProfileReviewed(): boolean {
    return this.getItem<boolean>(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
  }

  public setStoreProfileReviewed(reviewed: boolean): void {
    this.setItem(STORAGE_KEYS.STORE_PROFILE_REVIEWED, reviewed);
  }

  public hasConfiguredStoreProfile(): boolean {
    if (!this.cache.has(STORAGE_KEYS.STORE_PROFILE)) return false;
    const profile = this.cache.get(STORAGE_KEYS.STORE_PROFILE) as StoreProfile;
    return Boolean(profile && profile.name && profile.name.trim() !== '' && profile.name !== 'اسم المحل');
  }

  // --- USERS & ROLES MANAGEMENT ---
  public getUsers(): User[] {
    const users = this.getItem<User[]>(STORAGE_KEYS.USERS, []);
    let migrated = false;
    for (const u of users) {
      if (!u.permissions) {
        u.permissions = {
          canEditPrice: true,
          canGiveDiscount: true,
          canSellNegativeStock: true,
          canDeleteInvoice: u.role === 'ADMIN',
          canEditInvoice: true,
          canViewProfits: u.role === 'ADMIN',
          canManageProducts: u.role === 'ADMIN',
          canManagePurchases: u.role === 'ADMIN',
          canManageCash: u.role === 'ADMIN',
        };
        migrated = true;
      }
    }
    if (migrated) {
      this.setItem(STORAGE_KEYS.USERS, users);
    }
    return users;
  }

  public getActiveUser(): User | null {
    const users = this.getUsers();
    if (!users || users.length === 0) return null;
    let activeId: string | null = null;
    if (typeof localStorage !== 'undefined') {
      const storedActive = localStorage.getItem(STORAGE_KEYS.ACTIVE_USER_ID);
      if (!storedActive) {
        this.cache.delete(STORAGE_KEYS.ACTIVE_USER_ID);
        return null;
      }
      activeId = storedActive;
    } else {
      activeId = this.getItem<string>(STORAGE_KEYS.ACTIVE_USER_ID, '');
    }
    if (!activeId) return null;
    const found = users.find(u => u.id === activeId);
    return found || null;
  }

  public setActiveUser(userId: string): void {
    this.setItem(STORAGE_KEYS.ACTIVE_USER_ID, userId);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_USER_ID, userId);
      } catch {}
    }
  }

  public saveUser(user: User): { success: boolean; error?: string } {
    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      users[idx] = user;
    } else {
      // Check duplicate username
      if (users.some(u => u.username.toLowerCase() === user.username.toLowerCase())) {
        return { success: false, error: 'اسم المستخدم مسجل مسبقاً' };
      }
      users.push(user);
    }
    this.setItem(STORAGE_KEYS.USERS, users);
    return { success: true };
  }

  public deleteUser(userId: string): { success: boolean; error?: string } {
    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    
    // Prevent deleting last admin
    const admins = users.filter(u => u.role === 'ADMIN' && u.isActive !== false);
    if (user.role === 'ADMIN' && admins.length <= 1) {
      return { success: false, error: 'لا يمكن حذف آخر مدير نظام متبقي في البرنامج' };
    }

    const filtered = users.filter(u => u.id !== userId);
    this.setItem(STORAGE_KEYS.USERS, filtered);
    this.addAuditLog('USER', 'حذف مستخدم', 'المستخدمين', userId, `تم حذف المستخدم: ${user.fullName}`);
    return { success: true };
  }

  public authenticate(userId: string, pin: string): { success: boolean; error?: string; user?: User } {
    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    if (user.isActive === false) return { success: false, error: 'هذا الحساب معطل حالياً' };
    
    // Legacy fallback check if pinCode exists
    if (user.pinCode && user.pinCode.trim() === pin.trim()) {
      this.setActiveUser(user.id);
      return { success: true, user };
    }
    return { success: false, error: 'الرقم السري غير صحيح أو يتطلب تحقق أمني' };
  }

  public changeUserPin(userId: string, oldPin: string, newPin: string): { success: boolean; error?: string } {
    const users = this.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    if (user.pinCode && user.pinCode !== oldPin) return { success: false, error: 'الرقم السري الحالي غير صحيح' };
    if (newPin.trim().length < 4) return { success: false, error: 'الرقم السري يجب ألا يقل عن 4 خانات' };

    user.pinCode = newPin.trim();
    this.setItem(STORAGE_KEYS.USERS, users);
    this.addAuditLog('AUTH', 'تعديل الباسورد', 'الأمان', user.id, `تم تغيير الرقم السري للمستخدم: ${user.fullName}`);
    return { success: true };
  }

  // --- PRODUCTS (SINGLE WAREHOUSE) ---
  public getProducts(): Product[] {
    let products = this.getItem<Product[]>(STORAGE_KEYS.PRODUCTS, []);
    if (!products || !Array.isArray(products)) {
      products = [];
      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }
    // Backward compatibility migration for single warehouse
    let migrated = false;
    for (const p of products) {
      if (p.stockPieces === undefined) {
        p.stockPieces = ((p as any).stockShopPieces || 0) + ((p as any).stockWarehousePieces || 0);
        migrated = true;
      }
    }
    if (migrated) {
      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }
    return products;
  }

  public saveProduct(product: Product): void {
    const products = this.getProducts();
    const index = products.findIndex(p => p.id === product.id);
    if (index >= 0) {
      products[index] = product;
    } else {
      products.unshift(product);
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);
    this.addAuditLog('PRODUCT', 'حفظ صنف', 'الأصناف', product.id, `حفظ الصنف: ${product.name} (المخزن: ${product.stockPieces} قطعة)`);
    this.notifyAction(`حفظ صنف: ${product.name}`);
  }

  public deleteProduct(productId: string): { success: boolean; error?: string } {
    const products = this.getProducts();
    const prod = products.find(p => p.id === productId);
    if (!prod) return { success: false, error: 'الصنف غير موجود' };

    const filtered = products.filter(p => p.id !== productId);
    this.setItem(STORAGE_KEYS.PRODUCTS, filtered);
    this.addAuditLog('PRODUCT', 'حذف صنف', 'الأصناف', productId, `تم حذف الصنف: ${prod.name}`);
    this.notifyAction(`حذف صنف: ${prod.name}`);
    return { success: true };
  }

  // --- CUSTOMERS & STATEMENTS ---
  public getCustomers(): Customer[] {
    const custs = this.getItem<Customer[]>(STORAGE_KEYS.CUSTOMERS, []);
    if (!custs || !Array.isArray(custs)) {
      this.setItem(STORAGE_KEYS.CUSTOMERS, []);
      return [];
    }
    return custs;
  }

  public saveCustomer(customer: Customer): void {
    const customers = this.getCustomers();
    const index = customers.findIndex(c => c.id === customer.id);
    if (index >= 0) {
      customers[index] = customer;
    } else {
      customers.unshift(customer);
    }
    this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    this.addAuditLog('CUSTOMER', 'حفظ عميل', 'العملاء', customer.id, `حفظ بيانات العميل: ${customer.name}`);
    this.notifyAction(`حفظ عميل: ${customer.name}`);
  }

  public deleteCustomer(customerId: string, clearDebtAndForce: boolean = false): { success: boolean; error?: string } {
    const customers = this.getCustomers();
    const cust = customers.find(c => c.id === customerId);
    if (!cust) return { success: false, error: 'العميل غير موجود' };
    
    if (cust.currentBalance > 0 && !clearDebtAndForce) {
      return { success: false, error: `لا يمكن حذف العميل لأن عليه مديونية قائمة قدرها ${cust.currentBalance} ج.م` };
    }

    const filtered = customers.filter(c => c.id !== customerId);
    this.setItem(STORAGE_KEYS.CUSTOMERS, filtered);
    this.addAuditLog('CUSTOMER', 'حذف عميل', 'العملاء', customerId, `تم حذف العميل: ${cust.name} ${cust.currentBalance > 0 ? `(تم إسقاط مديونية قدرها ${cust.currentBalance} ج.م)` : ''}`);
    return { success: true };
  }

  public getCustomerStatement(customerId: string): {
    customer: Customer;
    invoices: SalesInvoice[];
    payments: CashMovement[];
  } | null {
    const cust = this.getCustomers().find(c => c.id === customerId);
    if (!cust) return null;

    const invoices = this.getSalesInvoices().filter(inv => inv.customerId === customerId);
    const payments = this.getCashMovements().filter(
      m => m.category === 'CUSTOMER_COLLECTION' && m.description.includes(cust.name)
    );

    return { customer: cust, invoices, payments };
  }

  // --- SUPPLIERS ---
  public getSuppliers(): Supplier[] {
    const suppliers = this.getItem<Supplier[]>(STORAGE_KEYS.SUPPLIERS, []);
    if (!suppliers || !Array.isArray(suppliers)) {
      this.setItem(STORAGE_KEYS.SUPPLIERS, []);
      return [];
    }
    return suppliers;
  }

  public saveSupplier(supplier: Supplier): void {
    const suppliers = this.getSuppliers();
    const index = suppliers.findIndex(s => s.id === supplier.id);
    if (index >= 0) {
      suppliers[index] = supplier;
    } else {
      suppliers.unshift(supplier);
    }
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
  }

  public deleteSupplier(supplierId: string): { success: boolean; error?: string } {
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === supplierId);
    if (!supp) return { success: false, error: 'المورد غير موجود' };
    if (supp.currentBalance > 0) {
      return { success: false, error: `لا يمكن حذف المورد لأن له مستحقات قائمة قدرها ${supp.currentBalance} ج.م` };
    }
    const filtered = suppliers.filter(s => s.id !== supplierId);
    this.setItem(STORAGE_KEYS.SUPPLIERS, filtered);
    return { success: true };
  }

  // --- SHIFTS & DRAWER CASH ---
  public getCurrentShift(): SystemShift {
    return this.getItem<SystemShift>(STORAGE_KEYS.SHIFT, INITIAL_SHIFT);
  }

  public saveCurrentShift(shift: SystemShift): void {
    this.setItem(STORAGE_KEYS.SHIFT, shift);
    if (shift.status === 'CLOSED') {
      this.notifyAction('SHIFT_CLOSED');
    }
  }

  public calculateCurrentCashInDrawer(): number {
    const movements = this.getCashMovements();
    return movements.reduce((acc, m) => {
      return m.type === 'IN' ? acc + m.amount : acc - m.amount;
    }, 0);
  }

  // --- CASH MOVEMENTS ---
  public getCashMovements(): CashMovement[] {
    return this.getItem<CashMovement[]>(STORAGE_KEYS.CASH_MOVEMENTS, INITIAL_CASH_MOVEMENTS);
  }

  public addCashMovement(movement: CashMovement): void {
    const movements = this.getCashMovements();
    movements.unshift(movement);
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);
  }

  // --- EXPENSES ---
  public getExpenses(): Expense[] {
    return this.getItem<Expense[]>(STORAGE_KEYS.EXPENSES, INITIAL_EXPENSES);
  }

  public recordExpense(expense: Expense): void {
    const expenses = this.getExpenses();
    expenses.unshift(expense);
    this.setItem(STORAGE_KEYS.EXPENSES, expenses);

    this.addCashMovement({
      id: `cm-${Date.now()}`,
      date: expense.date,
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      type: 'OUT',
      category: 'EXPENSE',
      categoryLabelArabic: expense.categoryLabelArabic,
      amount: expense.amount,
      referenceId: expense.id,
      description: `مصروف: ${expense.categoryLabelArabic} - ${expense.notes}`,
      performedBy: expense.recordedBy,
    });

    this.addAuditLog('EXPENSE', 'تسجيل مصروف', 'المصروفات', expense.id, `تسجيل مصروف بقيمة ${expense.amount} ج.م - ${expense.categoryLabelArabic}`);
    this.notifyAction(`تسجيل مصروف: ${expense.categoryLabelArabic}`);
  }

  // --- SALES INVOICES: POST, UPDATE, DELETE & NEGATIVE STOCK ---
  public getSalesInvoices(): SalesInvoice[] {
    return this.getItem<SalesInvoice[]>(STORAGE_KEYS.INVOICES, INITIAL_INVOICES);
  }

  public postSalesInvoice(invoice: SalesInvoice): { success: boolean; error?: string; hasNegativeStock?: boolean } {
    // License verification check (enforced only when LICENSE_ENFORCEMENT is true)
    if (!licenseService.canCreateSalesInvoice()) {
      const state = licenseService.getLicenseState();
      return {
        success: false,
        error: `لا يمكن إنشاء فاتورة بيع جديدة: ${state.message}`,
      };
    }

    const products = this.getProducts();
    const customers = this.getCustomers();

    // Check negative stock flag
    let hasNegativeStock = false;
    for (const item of invoice.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        if (prod.stockPieces < item.piecesCount) {
          hasNegativeStock = true;
        }
      }
    }
    invoice.hasNegativeStockItem = hasNegativeStock;

    // Apply Deductions to Single Warehouse (permits negative stock as requested)
    for (const item of invoice.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        prod.stockPieces -= item.piecesCount;
      }
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    // Update Customer Balance
    const cust = customers.find(c => c.id === invoice.customerId);
    const previousDebt = cust ? cust.currentBalance : 0;
    invoice.previousCustomerBalance = previousDebt;

    if (invoice.remainingAmount > 0 && cust) {
      cust.currentBalance += invoice.remainingAmount;
      this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    }
    invoice.newCustomerBalance = cust ? cust.currentBalance : 0;

    // Record Cash Movement if cash was paid
    if (invoice.paidAmount > 0) {
      this.addCashMovement({
        id: `cm-${Date.now()}`,
        date: invoice.date,
        time: invoice.time,
        type: 'IN',
        category: 'SALES_CASH',
        categoryLabelArabic: 'مبيعات نقدية',
        amount: invoice.paidAmount,
        referenceId: invoice.invoiceNumber,
        description: `تحصيل فاتورة مبيعات ${invoice.invoiceNumber} - العميل: ${invoice.customerName}`,
        performedBy: invoice.salespersonName,
      });
    }

    // Save Invoice
    const invoices = this.getSalesInvoices();
    invoices.unshift(invoice);
    this.setItem(STORAGE_KEYS.INVOICES, invoices);

    this.addAuditLog(
      'SALES',
      'إصدار فاتورة مبيعات',
      'فواتير المبيعات',
      invoice.invoiceNumber,
      `فاتورة ${invoice.invoiceNumber} بقيمة ${invoice.total} ج.م للعميل: ${invoice.customerName} (ربح الفاتورة: ${invoice.totalProfit} ج.م)`
    );
    this.notifyAction(`فاتورة مبيعات: ${invoice.invoiceNumber}`);

    return { success: true, hasNegativeStock };
  }

  // DELETE SALES INVOICE (With full stock restoration and customer debt deletion)
  public deleteSalesInvoice(invoiceId: string): { success: boolean; error?: string } {
    const invoices = this.getSalesInvoices();
    const invoice = invoices.find(inv => inv.id === invoiceId || inv.invoiceNumber === invoiceId);
    if (!invoice) return { success: false, error: 'الفاتورة غير موجودة' };

    const products = this.getProducts();
    const customers = this.getCustomers();

    // 1. Restore Stock (إعادة الأصناف للمخزن)
    for (const item of invoice.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        prod.stockPieces += item.piecesCount;
      }
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    // 2. Remove Customer Debt (حذف مديونية الفاتورة من العميل)
    const cust = customers.find(c => c.id === invoice.customerId);
    if (cust && invoice.remainingAmount > 0) {
      cust.currentBalance = Math.max(0, cust.currentBalance - invoice.remainingAmount);
      this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
    }

    // 3. Reverse Cash if paid (إلغاء النقدية المحصلة)
    if (invoice.paidAmount > 0) {
      this.addCashMovement({
        id: `cm-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'OUT',
        category: 'INVOICE_REVERSAL',
        categoryLabelArabic: 'إلغاء فاتورة مبيعات',
        amount: invoice.paidAmount,
        referenceId: invoice.invoiceNumber,
        description: `رد نقدية لحذف فاتورة المبيعات رقم ${invoice.invoiceNumber}`,
        performedBy: this.getActiveUser()?.fullName || 'النظام',
      });
    }

    // 4. Remove invoice from list
    const filteredInvoices = invoices.filter(inv => inv.id !== invoice.id);
    this.setItem(STORAGE_KEYS.INVOICES, filteredInvoices);

    this.addAuditLog(
      'SALES',
      'حذف فاتورة مبيعات',
      'فواتير المبيعات',
      invoice.invoiceNumber,
      `تم حذف الفاتورة ${invoice.invoiceNumber} وإرجاع بضاعة الأصناف للمخزن وحذف مديونية العميل (${invoice.remainingAmount} ج.م)`
    );
    this.notifyAction(`حذف فاتورة: ${invoice.invoiceNumber}`);

    return { success: true };
  }

  // UPDATE SALES INVOICE (Edit existing invoice)
  public updateSalesInvoice(updatedInvoice: SalesInvoice): { success: boolean; error?: string } {
    const invoices = this.getSalesInvoices();
    const oldIndex = invoices.findIndex(inv => inv.id === updatedInvoice.id);
    if (oldIndex === -1) return { success: false, error: 'الفاتورة غير موجودة' };

    const oldInvoice = invoices[oldIndex];
    const products = this.getProducts();
    const customers = this.getCustomers();

    // Revert old stock
    for (const item of oldInvoice.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) prod.stockPieces += item.piecesCount;
    }

    // Apply new stock deductions
    for (const item of updatedInvoice.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) prod.stockPieces -= item.piecesCount;
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    // Revert old debt and apply new debt
    const cust = customers.find(c => c.id === updatedInvoice.customerId);
    if (cust) {
      cust.currentBalance -= oldInvoice.remainingAmount;
      cust.currentBalance += updatedInvoice.remainingAmount;
      this.setItem(STORAGE_KEYS.CUSTOMERS, customers);
      updatedInvoice.newCustomerBalance = cust.currentBalance;
    }

    updatedInvoice.status = 'MODIFIED';
    invoices[oldIndex] = updatedInvoice;
    this.setItem(STORAGE_KEYS.INVOICES, invoices);

    this.addAuditLog(
      'SALES',
      'تعديل فاتورة مبيعات',
      'فواتير المبيعات',
      updatedInvoice.invoiceNumber,
      `تم تعديل الفاتورة ${updatedInvoice.invoiceNumber} بقيمة جديدة ${updatedInvoice.total} ج.م`
    );
    this.notifyAction(`تعديل فاتورة: ${updatedInvoice.invoiceNumber}`);

    return { success: true };
  }

  // --- CUSTOMER DEBT COLLECTION (سند قبض) ---
  public recordCustomerCollection(params: {
    customerId: string;
    amount: number;
    notes?: string;
    collectedBy: string;
  }): { success: boolean; error?: string } {
    const customers = this.getCustomers();
    const cust = customers.find(c => c.id === params.customerId);
    if (!cust) return { success: false, error: 'العميل غير موجود' };
    if (params.amount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    cust.currentBalance -= params.amount;
    this.setItem(STORAGE_KEYS.CUSTOMERS, customers);

    const voucherNum = `RCV-${Date.now().toString().slice(-6)}`;
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    this.addCashMovement({
      id: `cm-${Date.now()}`,
      date: dateStr,
      time: timeStr,
      type: 'IN',
      category: 'CUSTOMER_COLLECTION',
      categoryLabelArabic: 'سند تحصيل مديونية عميل',
      amount: params.amount,
      referenceId: voucherNum,
      description: `سند قبض رقم ${voucherNum} من العميل: ${cust.name} ${params.notes ? `(${params.notes})` : ''}`,
      performedBy: params.collectedBy,
    });

    this.addAuditLog(
      'COLLECTION',
      'سند قبض عميل',
      'العملاء',
      cust.id,
      `تحصيل مبلغ ${params.amount} ج.م من العميل: ${cust.name}، الرصيد المتبقي: ${cust.currentBalance} ج.م`
    );
    this.notifyAction(`سند تحصيل عميل: ${cust.name}`);

    return { success: true };
  }

  // --- SUPPLIER PAYMENT (سند صرف مورد مع إمكانية السحب بالسالب ومصدر التمويل) ---
  public recordSupplierPayment(params: {
    supplierId: string;
    amount: number;
    notes?: string;
    paidBy: string;
    allowNegativeCash?: boolean;
    fundingSource?: 'DRAWER' | 'PERSONAL_LOAN' | 'DRAWER_NEGATIVE' | 'OTHER';
  }): { success: boolean; error?: string } {
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === params.supplierId);
    if (!supp) return { success: false, error: 'المورد غير موجود' };
    if (params.amount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };

    const currentCash = this.calculateCurrentCashInDrawer();
    const isNegativeCash = currentCash < params.amount;

    if (isNegativeCash && !params.allowNegativeCash) {
      return { 
        success: false, 
        error: `الرصيد النقدي بالدرج (${currentCash} ج.م) لا يكفي لصرف ${params.amount} ج.م. يمكنك تفعيل خيار السحب بالسالب لتسوية الوردية لاحقاً.` 
      };
    }

    supp.currentBalance -= params.amount;
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);

    const voucherNum = `PAY-${Date.now().toString().slice(-6)}`;
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    const funding = params.fundingSource || (isNegativeCash ? 'DRAWER_NEGATIVE' : 'DRAWER');
    const fundingLabel = funding === 'PERSONAL_LOAN' 
      ? 'سلفة / تمويل شخصي' 
      : funding === 'DRAWER_NEGATIVE' 
      ? 'سحب بالسالب من الدرج' 
      : 'نقدية الدرج';

    this.addCashMovement({
      id: `cm-${Date.now()}`,
      date: dateStr,
      time: timeStr,
      type: 'OUT',
      category: 'SUPPLIER_PAYMENT',
      categoryLabelArabic: 'سند صرف مورد',
      amount: params.amount,
      referenceId: voucherNum,
      supplierId: supp.id,
      supplierName: supp.name,
      fundingSource: funding,
      description: `سند صرف للمورد: ${supp.name} (${fundingLabel}) ${params.notes ? `• ${params.notes}` : ''}`,
      performedBy: params.paidBy,
    });

    this.addAuditLog(
      'PAYMENT',
      'سند صرف مورد',
      'الموردين',
      supp.id,
      `صرف مبلغ ${params.amount} ج.م للمورد: ${supp.name} (${fundingLabel})، المتبقي له: ${supp.currentBalance} ج.م`
    );
    this.notifyAction(`سند صرف مورد: ${supp.name}`);

    return { success: true };
  }

  // احضار سجل دفعات الموردين
  public getSupplierPayments(supplierId?: string): CashMovement[] {
    const movements = this.getCashMovements();
    return movements.filter(m => {
      if (m.category !== 'SUPPLIER_PAYMENT') return false;
      if (supplierId && m.supplierId !== supplierId) return false;
      return true;
    });
  }

  // تعديل دفعة مورد
  public updateSupplierPayment(movementId: string, newAmount: number, newNotes?: string): { success: boolean; error?: string } {
    if (newAmount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };
    const movements = this.getCashMovements();
    const idx = movements.findIndex(m => m.id === movementId);
    if (idx === -1) return { success: false, error: 'حركة الدفع غير موجودة' };

    const oldMovement = movements[idx];
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === oldMovement.supplierId);

    if (supp) {
      // الفرق في المبلغ: إذا زاد المبلغ المصروف يقل رصيد المورد، والعكس
      const diff = newAmount - oldMovement.amount;
      supp.currentBalance -= diff;
      this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    }

    oldMovement.amount = newAmount;
    if (newNotes) {
      oldMovement.description = `سند صرف للمورد: ${oldMovement.supplierName || ''} • ${newNotes}`;
    }
    movements[idx] = oldMovement;
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, movements);

    this.addAuditLog(
      'PAYMENT_UPDATE',
      'تعديل سند صرف مورد',
      'سندات الصرف',
      movementId,
      `تم تعديل سند صرف بقيمة ${newAmount} ج.م للمورد: ${oldMovement.supplierName || ''}`
    );

    return { success: true };
  }

  // حذف دفعة مورد (إلغاء سند الصرف ورد المديونية)
  public deleteSupplierPayment(movementId: string): { success: boolean; error?: string } {
    const movements = this.getCashMovements();
    const target = movements.find(m => m.id === movementId);
    if (!target) return { success: false, error: 'حركة الدفع غير موجودة' };

    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === target.supplierId);
    if (supp) {
      supp.currentBalance += target.amount; // إعادة المبلغ لمستحقات المورد
      this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    }

    const filtered = movements.filter(m => m.id !== movementId);
    this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, filtered);

    this.addAuditLog(
      'PAYMENT_DELETE',
      'حذف سند صرف مورد',
      'سندات الصرف',
      movementId,
      `تم حذف سند صرف بقيمة ${target.amount} ج.م وإعادة المبلغ لمستحقات المورد: ${target.supplierName || ''}`
    );

    return { success: true };
  }

  // كشف حساب المورد مع الفواتير والدفعات
  public getSupplierStatement(supplierId: string): {
    supplier: Supplier;
    purchases: PurchaseInvoice[];
    payments: CashMovement[];
  } | null {
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === supplierId);
    if (!supp) return null;

    const purchases = this.getPurchases().filter(p => p.supplierId === supplierId);
    const payments = this.getSupplierPayments(supplierId);

    return { supplier: supp, purchases, payments };
  }

  // --- PURCHASING (RECEIVING STOCK & INVOICE MANAGEMENT) ---
  public getPurchases(): PurchaseInvoice[] {
    return this.getItem<PurchaseInvoice[]>(STORAGE_KEYS.PURCHASES, []);
  }

  public postPurchaseInvoice(purchase: PurchaseInvoice): { success: boolean; error?: string } {
    const products = this.getProducts();
    const suppliers = this.getSuppliers();
    const supp = suppliers.find(s => s.id === purchase.supplierId);
    if (!supp) return { success: false, error: 'المورد غير محدد' };

    // حساب المديونيات
    purchase.previousSupplierBalance = supp.currentBalance;

    // إذا كانت البضاعة مدرجة في المخزن
    if (purchase.isStockInserted) {
      for (const item of purchase.items) {
        const prod = products.find(p => p.id === item.productId);
        if (prod) {
          const piecesPerUnit = item.unit === 'CARTON' 
            ? prod.piecesPerWholesaleUnit 
            : item.unit === 'PALLET' 
            ? (prod.piecesPerWholesaleUnit * 20) 
            : 1;

          const addedPieces = item.quantity * piecesPerUnit;
          const totalPiecesBefore = prod.stockPieces;
          
          prod.stockPieces += addedPieces;

          // Moving Weighted Average Cost update
          const totalOldValue = Math.max(0, totalPiecesBefore) * prod.costPricePerBase;
          const unitPieceCostReceived = item.unitCost / piecesPerUnit;
          const totalNewAddedValue = addedPieces * unitPieceCostReceived;
          
          const newTotalPieces = Math.max(0, totalPiecesBefore) + addedPieces;
          if (newTotalPieces > 0) {
            const newAvgBaseCost = (totalOldValue + totalNewAddedValue) / newTotalPieces;
            prod.costPricePerBase = Math.round(newAvgBaseCost * 100) / 100;
            prod.costPricePerCarton = Math.round(prod.costPricePerBase * prod.piecesPerWholesaleUnit * 100) / 100;
          }
          if (item.batchNumber) prod.batchNumber = item.batchNumber;
          if (item.expiryDate) prod.expiryDate = item.expiryDate;
        }
      }

      // إذا كان هناك بونص بضاعة مجانية: يتم إضافتها للمخزن بتكلفة صفر
      if (purchase.bonusType === 'GOODS' && purchase.bonusGoodsQuantity && purchase.items.length > 0) {
        const firstProd = products.find(p => p.id === purchase.items[0].productId);
        if (firstProd) {
          firstProd.stockPieces += (purchase.bonusGoodsQuantity * firstProd.piecesPerWholesaleUnit);
        }
      }

      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }

    // تحديث رصيد المورد
    if (purchase.remainingAmount > 0) {
      supp.currentBalance += purchase.remainingAmount;
    }
    purchase.newSupplierBalance = supp.currentBalance;
    this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);

    // سداد نقدي من الدرج إن وجد
    if (purchase.paidAmount > 0) {
      this.addCashMovement({
        id: `cm-${Date.now()}`,
        date: purchase.date,
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'OUT',
        category: 'SUPPLIER_PAYMENT',
        categoryLabelArabic: 'دفعة مشتريات نقدية',
        amount: purchase.paidAmount,
        referenceId: purchase.invoiceNumber,
        supplierId: supp.id,
        supplierName: supp.name,
        description: `سداد نقدي لفاتورة شراء ${purchase.invoiceNumber} من ${supp.name}`,
        performedBy: this.getActiveUser()?.fullName || 'النظام',
      });
    }

    const purchases = this.getPurchases();
    purchases.unshift(purchase);
    this.setItem(STORAGE_KEYS.PURCHASES, purchases);

    this.addAuditLog(
      'PURCHASE',
      'تسجيل فاتورة شراء',
      'فواتير الشراء',
      purchase.invoiceNumber,
      `فاتورة شراء رقم ${purchase.invoiceNumber} بقيمة إجمالية ${purchase.totalCost} ج.م من ${supp.name} ${purchase.isStockInserted ? '(أُدرجت بالمخزن)' : '(مسودة غير مدرجة بالمخزن)'}`
    );

    return { success: true };
  }

  // حذف فاتورة مشتريات وإلغاء إدراجها من المخزن إن تم إدراجها
  public deletePurchaseInvoice(invoiceId: string): { success: boolean; error?: string } {
    const purchases = this.getPurchases();
    const purchase = purchases.find(p => p.id === invoiceId || p.invoiceNumber === invoiceId);
    if (!purchase) return { success: false, error: 'فاتورة الشراء غير موجودة' };

    const products = this.getProducts();
    const suppliers = this.getSuppliers();

    // 1. إذا كانت البضاعة قد أُدرجت بالمخزن: خصم كمياتها من المخزن
    if (purchase.isStockInserted) {
      for (const item of purchase.items) {
        const prod = products.find(p => p.id === item.productId);
        if (prod) {
          const piecesPerUnit = item.unit === 'CARTON' 
            ? prod.piecesPerWholesaleUnit 
            : item.unit === 'PALLET' 
            ? (prod.piecesPerWholesaleUnit * 20) 
            : 1;
          prod.stockPieces -= (item.quantity * piecesPerUnit);
        }
      }

      // خصم بونص البضاعة المجانية إن وجد
      if (purchase.bonusType === 'GOODS' && purchase.bonusGoodsQuantity && purchase.items.length > 0) {
        const firstProd = products.find(p => p.id === purchase.items[0].productId);
        if (firstProd) {
          firstProd.stockPieces -= (purchase.bonusGoodsQuantity * firstProd.piecesPerWholesaleUnit);
        }
      }

      this.setItem(STORAGE_KEYS.PRODUCTS, products);
    }

    // 2. إلغاء مديونية المورد
    const supp = suppliers.find(s => s.id === purchase.supplierId);
    if (supp && purchase.remainingAmount > 0) {
      supp.currentBalance = Math.max(0, supp.currentBalance - purchase.remainingAmount);
      this.setItem(STORAGE_KEYS.SUPPLIERS, suppliers);
    }

    // 3. رد النقدية المسددة إن وجدت
    if (purchase.paidAmount > 0) {
      this.addCashMovement({
        id: `cm-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        type: 'IN',
        category: 'DRAWER_ADJUSTMENT',
        categoryLabelArabic: 'إلغاء فاتورة شراء',
        amount: purchase.paidAmount,
        referenceId: purchase.invoiceNumber,
        description: `رد نقدية لحذف فاتورة الشراء رقم ${purchase.invoiceNumber} من ${purchase.supplierName}`,
        performedBy: this.getActiveUser()?.fullName || 'النظام',
      });
    }

    const filtered = purchases.filter(p => p.id !== purchase.id);
    this.setItem(STORAGE_KEYS.PURCHASES, filtered);

    this.addAuditLog(
      'PURCHASE_DELETE',
      'حذف فاتورة شراء',
      'فواتير الشراء',
      purchase.invoiceNumber,
      `تم حذف فاتورة الشراء ${purchase.invoiceNumber} وخصم بضاعتها من المخزن وإلغاء مديونية المورد`
    );

    return { success: true };
  }

  // إدراج فاتورة شراء في المخزن إذا لم تكن مدرجة
  public insertPurchaseIntoStock(invoiceId: string): { success: boolean; error?: string } {
    const purchases = this.getPurchases();
    const purchase = purchases.find(p => p.id === invoiceId);
    if (!purchase) return { success: false, error: 'فاتورة الشراء غير موجودة' };
    if (purchase.isStockInserted) return { success: false, error: 'الفاتورة مدرجة بالمخزن بالفعل' };

    const products = this.getProducts();
    for (const item of purchase.items) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        const piecesPerUnit = item.unit === 'CARTON' 
          ? prod.piecesPerWholesaleUnit 
          : item.unit === 'PALLET' 
          ? (prod.piecesPerWholesaleUnit * 20) 
          : 1;

        prod.stockPieces += (item.quantity * piecesPerUnit);
      }
    }
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    purchase.isStockInserted = true;
    this.setItem(STORAGE_KEYS.PURCHASES, purchases);

    this.addAuditLog(
      'PURCHASE_STOCK',
      'إدراج بضاعة شراء بالمخزن',
      'المخزن',
      purchase.invoiceNumber,
      `تم إدراج بضاعة فاتورة الشراء ${purchase.invoiceNumber} في المخزن الموحد بنجاح`
    );

    return { success: true };
  }

  // --- STOCK ADJUSTMENTS (نظام تسوية المخزون: جرد / عجز / زيادة / تلف) ---
  public getStockAdjustments(): StockAdjustment[] {
    return this.getItem<StockAdjustment[]>(STORAGE_KEYS.STOCK_ADJUSTMENTS, []);
  }

  public recordStockAdjustment(params: {
    productId: string;
    differencePieces: number; // + or -
    reason: 'AUDIT' | 'DAMAGE' | 'EXPIRY' | 'BONUS' | 'CORRECTION' | 'OTHER';
    reasonArabic: string;
    notes?: string;
    performedBy: string;
  }): { success: boolean; error?: string } {
    const products = this.getProducts();
    const prod = products.find(p => p.id === params.productId);
    if (!prod) return { success: false, error: 'الصنف غير موجود' };

    const prevPieces = prod.stockPieces;
    const newPieces = prevPieces + params.differencePieces;
    prod.stockPieces = newPieces;
    this.setItem(STORAGE_KEYS.PRODUCTS, products);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    const adjustment: StockAdjustment = {
      id: `adj-${Date.now()}`,
      date: dateStr,
      time: timeStr,
      productId: prod.id,
      productName: prod.name,
      productCode: prod.code,
      previousPieces: prevPieces,
      differencePieces: params.differencePieces,
      newPieces: newPieces,
      reason: params.reason,
      reasonArabic: params.reasonArabic,
      notes: params.notes,
      performedBy: params.performedBy,
    };

    const adjustments = this.getStockAdjustments();
    adjustments.unshift(adjustment);
    this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, adjustments);

    const diffType = params.differencePieces >= 0 ? 'زيادة' : 'عجز/خصم';
    this.addAuditLog(
      'STOCK_ADJUST',
      'تسوية مخزون',
      'المخزن الموحد',
      prod.code,
      `تسوية رصيد الصنف (${prod.name}): ${diffType} ${Math.abs(params.differencePieces)} قطعة [السبب: ${params.reasonArabic}] • الرصيد السابق: ${prevPieces} ق، الرصيد الجديد: ${newPieces} ق`
    );

    return { success: true };
  }

  // --- AUDIT LOGS ---
  public getAuditLogs(): AuditLog[] {
    return this.getItem<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
  }

  public addAuditLog(entity: string, actionArabic: string, entityArabic: string, entityId: string, details: string): void {
    const activeUser = this.getActiveUser();
    const logs = this.getAuditLogs();
    const newLog: AuditLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      timestamp: new Date().toLocaleString('ar-EG'),
      userId: activeUser ? activeUser.id : 'unauthenticated',
      username: activeUser ? activeUser.fullName : 'غير مسجّل (النظام)',
      action: entity,
      actionArabic,
      entity: entityArabic,
      entityId,
      details,
    };
    logs.unshift(newLog);
    if (logs.length > 500) logs.pop();
    this.setItem(STORAGE_KEYS.AUDIT_LOGS, logs);
  }

  // --- PARKED CARTS (تعليق الفواتير للكاشير) ---
  public getParkedCarts(): ParkedCart[] {
    return this.getItem<ParkedCart[]>(STORAGE_KEYS.PARKED_CARTS, []);
  }

  public saveParkedCart(cart: ParkedCart): void {
    const carts = this.getParkedCarts();
    carts.unshift(cart);
    this.setItem(STORAGE_KEYS.PARKED_CARTS, carts);
    this.addAuditLog('SALES', 'تعليق فاتورة', 'نقطة البيع', cart.id, `تم تعليق فاتورة باسم: ${cart.customerName} (${cart.items.length} أصناف)`);
  }

  public removeParkedCart(id: string): void {
    const carts = this.getParkedCarts();
    const filtered = carts.filter(c => c.id !== id);
    this.setItem(STORAGE_KEYS.PARKED_CARTS, filtered);
  }

  // --- BACKUP & RESTORE ---
  public exportFullBackupJson(): string {
    const backupData = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      app: 'WholesaleFoodSystem_Egypt',
      data: {
        products: this.getProducts(),
        customers: this.getCustomers(),
        suppliers: this.getSuppliers(),
        invoices: this.getSalesInvoices(),
        purchases: this.getPurchases(),
        cashMovements: this.getCashMovements(),
        expenses: this.getExpenses(),
        auditLogs: this.getAuditLogs(),
        stockAdjustments: this.getStockAdjustments(),
        currentShift: this.getCurrentShift(),
        users: this.getUsers(),
      }
    };
    return JSON.stringify(backupData, null, 2);
  }

  public restoreBackupJson(jsonString: string): { success: boolean; error?: string } {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed.data || !parsed.data.products || !parsed.data.customers) {
        return { success: false, error: 'الملف غير صالح أو لا يحتوي على بنية البيانات المطلوبة' };
      }

      this.setItem(STORAGE_KEYS.PRODUCTS, parsed.data.products);
      this.setItem(STORAGE_KEYS.CUSTOMERS, parsed.data.customers);
      this.setItem(STORAGE_KEYS.SUPPLIERS, parsed.data.suppliers || []);
      this.setItem(STORAGE_KEYS.INVOICES, parsed.data.invoices || []);
      this.setItem(STORAGE_KEYS.PURCHASES, parsed.data.purchases || []);
      this.setItem(STORAGE_KEYS.CASH_MOVEMENTS, parsed.data.cashMovements || []);
      this.setItem(STORAGE_KEYS.EXPENSES, parsed.data.expenses || []);
      this.setItem(STORAGE_KEYS.AUDIT_LOGS, parsed.data.auditLogs || []);
      if (parsed.data.stockAdjustments) this.setItem(STORAGE_KEYS.STOCK_ADJUSTMENTS, parsed.data.stockAdjustments);
      if (parsed.data.users) this.setItem(STORAGE_KEYS.USERS, parsed.data.users);

      this.addAuditLog('RESTORE', 'استعادة نسخة احتياطية', 'النظام', 'restore', 'تمت استعادة قاعدة البيانات بنجاح من ملف خارجي');

      // Asynchronously flush writes to IndexedDB
      this.flush().catch(err => {
        console.error('Error flushing restored backup to IDB:', err);
      });

      this.migrationRecoveryRequired = false;
      this.isReady = true;

      return { success: true };
    } catch {
      return { success: false, error: 'فشل في قراءة ملف النسخة الاحتياطية' };
    }
  }

  /**
   * Updates memory cache with transactional restored payload without re-queueing IDB writes
   */
  public applyRestoredMemoryPayload(rawInput: Record<string, any>): void {
    const data = (rawInput && typeof rawInput === 'object' && rawInput.data && typeof rawInput.data === 'object' && !Array.isArray(rawInput.data))
      ? rawInput.data
      : rawInput;
    if (data.products !== undefined) this.cache.set(STORAGE_KEYS.PRODUCTS, data.products);
    if (data.customers !== undefined) this.cache.set(STORAGE_KEYS.CUSTOMERS, data.customers);
    if (data.suppliers !== undefined) this.cache.set(STORAGE_KEYS.SUPPLIERS, data.suppliers);
    if (data.invoices !== undefined) this.cache.set(STORAGE_KEYS.INVOICES, data.invoices);
    if (data.purchases !== undefined) this.cache.set(STORAGE_KEYS.PURCHASES, data.purchases);
    if (data.cashMovements !== undefined) this.cache.set(STORAGE_KEYS.CASH_MOVEMENTS, data.cashMovements);
    if (data.expenses !== undefined) this.cache.set(STORAGE_KEYS.EXPENSES, data.expenses);
    if (data.auditLogs !== undefined) this.cache.set(STORAGE_KEYS.AUDIT_LOGS, data.auditLogs);
    if (data.stockAdjustments !== undefined) this.cache.set(STORAGE_KEYS.STOCK_ADJUSTMENTS, data.stockAdjustments);
    if (data.users !== undefined) this.cache.set(STORAGE_KEYS.USERS, data.users);
    if (data.currentShift !== undefined) this.cache.set(STORAGE_KEYS.SHIFT, data.currentShift);
    if (data.parkedCarts !== undefined) this.cache.set(STORAGE_KEYS.PARKED_CARTS, data.parkedCarts);

    if (data.storeProfile !== undefined) {
      this.cache.set(STORAGE_KEYS.STORE_PROFILE, data.storeProfile);
      this.cache.set(STORAGE_KEYS.STORE_PROFILE_REVIEWED, true);
    } else {
      // Legacy backup without StoreProfile: determine appropriate profile
      const hasProducts = Array.isArray(data.products) && data.products.length > 0;
      const fallbackProfile = hasProducts ? JSON.parse(JSON.stringify(LEGACY_STORE_PROFILE)) : JSON.parse(JSON.stringify(DEFAULT_STORE_PROFILE));
      this.cache.set(STORAGE_KEYS.STORE_PROFILE, fallbackProfile);
      this.cache.set(STORAGE_KEYS.STORE_PROFILE_REVIEWED, false);
    }

    this.pendingWrites.clear();
    this.migrationRecoveryRequired = false;
    this.isReady = true;
  }

  public resetToFactoryDefault(): void {
    this.cache.clear();
    this.pendingWrites.clear();
    this.initPromise = null;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    idb.kv.clear().catch(e => console.error('Failed to clear IDB:', e));
    if (typeof localStorage !== 'undefined') {
      for (const k of BUSINESS_KEYS) {
        try { localStorage.removeItem(k); } catch {}
      }
      try { localStorage.removeItem('idb_migrated_at'); } catch {}
    }
    this.initDatabase();
    this.flush().catch(err => console.error('Error flushing default seeds to IDB:', err));
  }
}

export const storage = new StorageService();

// Requirement 3: Automatically flush pending writes on visibilitychange (hidden) and pagehide
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      storage.flush().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    storage.flush().catch(() => {});
  });
}
