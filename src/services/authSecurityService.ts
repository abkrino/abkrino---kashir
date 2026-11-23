import { User, Role, UserPermissions, TabType } from '../types';
import { storage } from './storageService';

export type SensitiveOperation =
  | 'delete_invoice'
  | 'edit_price'
  | 'give_discount'
  | 'sell_negative_stock'
  | 'edit_invoice'
  | 'view_profits'
  | 'manage_products'
  | 'manage_purchases'
  | 'manage_cash'
  | 'withdraw_negative_cash'
  | 'process_returns'
  | 'manage_users'
  | 'view_hr'
  | 'manage_hr'
  | 'manage_attendance'
  | 'manage_payroll';

export interface LockoutRecord {
  failedAttempts: number;
  lockoutCycle: number;
  lockedUntil: number | null;
}

export interface LockoutStatus {
  isLocked: boolean;
  remainingSeconds: number;
  failedAttempts: number;
  lockoutCycle: number;
}

export interface SecuritySettings {
  autoLockMinutes: number; // default: 10
}

export interface AuthResult {
  success: boolean;
  error?: string;
  user?: User;
  isLockedOut?: boolean;
  remainingSeconds?: number;
  mustChangePin?: boolean;
}

export const KNOWN_DEFAULT_PINS = ['1234', '1111', '0000', '123456', '9999', '1122', '0123'];

// Convert any Arabic-Indic numerals (٠-٩) or Eastern Arabic/Persian numerals (۰-۹) to standard Western digits (0-9)
export function normalizeArabicDigits(str: string): string {
  if (!str) return '';
  return str
    .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
    .replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
}

const STORAGE_KEYS = {
  LOCKOUT: 'pos_auth_lockout_v1',
  SECURITY_SETTINGS: 'pos_security_settings_v1',
};

// --- HELPER UTILITIES: HEX & BYTES ---
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  const match = cleanHex.match(/.{1,2}/g) || [];
  return new Uint8Array(match.map(byte => parseInt(byte, 16)));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- PBKDF2-SHA256 WITH 100,000 ITERATIONS ---
export async function hashPasswordWithPbkdf2(
  password: string,
  saltHex?: string,
  iterations: number = 100000
): Promise<{ hashHex: string; saltHex: string }> {
  const enc = new TextEncoder();
  const saltBytes = saltHex
    ? hexToBytes(saltHex)
    : crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256 // 32 bytes (256 bits)
  );

  return {
    hashHex: bytesToHex(new Uint8Array(derivedBits)),
    saltHex: bytesToHex(saltBytes),
  };
}

export async function verifyPasswordWithPbkdf2(
  password: string,
  storedHashHex: string,
  storedSaltHex: string
): Promise<boolean> {
  if (!storedHashHex || !storedSaltHex) return false;
  try {
    const { hashHex } = await hashPasswordWithPbkdf2(password, storedSaltHex, 100000);
    return timingSafeEqualHex(hashHex, storedHashHex);
  } catch {
    return false;
  }
}

export function isKnownDefaultPin(pin: string): boolean {
  const clean = normalizeArabicDigits(pin).trim();
  return KNOWN_DEFAULT_PINS.includes(clean);
}

export function userHasCredentials(user: User | null | undefined): boolean {
  if (!user) return false;
  return Boolean((user.pinHash && user.pinSalt) || (user.pinCode && user.pinCode.trim()));
}

// --- CENTRALIZED PERMISSIONS CHECK ---
export function checkUserPermission(
  user: User | null | undefined,
  operation: SensitiveOperation
): boolean {
  if (!user || user.isActive === false) {
    return false;
  }

  // Admin has full system permissions
  if (user.role === 'ADMIN') {
    return true;
  }

  const perms = user.permissions;
  if (!perms) {
    return false;
  }

  switch (operation) {
    case 'delete_invoice':
      return Boolean(perms.canDeleteInvoice);
    case 'edit_price':
      return Boolean(perms.canEditPrice);
    case 'give_discount':
      return Boolean(perms.canGiveDiscount);
    case 'sell_negative_stock':
      return Boolean(perms.canSellNegativeStock);
    case 'edit_invoice':
      return Boolean(perms.canEditInvoice);
    case 'view_profits':
      return Boolean(perms.canViewProfits);
    case 'manage_products':
      return Boolean(perms.canManageProducts);
    case 'manage_purchases':
      return Boolean(perms.canManagePurchases);
    case 'manage_cash':
      return Boolean(perms.canManageCash);
    case 'withdraw_negative_cash':
      return Boolean(perms.canWithdrawNegativeCash);
    case 'process_returns':
      return Boolean(perms.canProcessReturns);
    case 'manage_users':
      return false; // Cashiers can never manage users
    case 'view_hr': return Boolean(perms.canViewHR || perms.canManageHR || perms.canManageAttendance || perms.canManagePayroll);
    case 'manage_hr': return Boolean(perms.canManageHR);
    case 'manage_attendance': return Boolean(perms.canManageAttendance || perms.canManageHR);
    case 'manage_payroll': return Boolean(perms.canManagePayroll || perms.canManageHR);
    default:
      return false;
  }
}

/**
 * Validates whether the given user has permission to access a specific navigation tab.
 * Enforces strict role-based access control (RBAC):
 * - Admins have access to all tabs.
 * - Inactive users have no access.
 * - Cashiers are restricted from Administration, Users, Settings, Backups, and Cloud.
 * - Cashiers can access operational tabs based on their granted permissions.
 */
export function canAccessTab(user: User | null | undefined, tab: TabType): boolean {
  if (!user || user.isActive === false) {
    return false;
  }

  // Admin has full system access to all tabs
  if (user.role === 'ADMIN') {
    return true;
  }

  switch (tab) {
    case 'dashboard':
    case 'pos':
    case 'invoices':
    case 'customers':
      return true;
    case 'cash':
      return checkUserPermission(user, 'manage_cash');
    case 'announcer':
      return true;
    case 'inventory':
      return checkUserPermission(user, 'manage_products');
    case 'purchasing':
    case 'suppliers':
      return checkUserPermission(user, 'manage_purchases');
    case 'reports':
      return checkUserPermission(user, 'view_profits');
    case 'hr':
      return checkUserPermission(user, 'view_hr');
    case 'users':
    case 'settings':
    case 'store-profile':
    case 'backup':
    case 'cloud':
    case 'audit':
      // Cashiers can never access management or configuration
      return false;
    default:
      return false;
  }
}

// --- AUTHENTICATION & SECURITY SERVICE ---
class AuthSecurityService {
  // Lockout Management (Per-User Store with 15-minute cap)
  private getLockoutStore(): Record<string, LockoutRecord> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCKOUT);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.failedAttempts === 'number') {
        return { global: parsed };
      }
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveLockoutStore(store: Record<string, LockoutRecord>): void {
    try {
      localStorage.setItem(STORAGE_KEYS.LOCKOUT, JSON.stringify(store));
    } catch {
      // ignore
    }
  }

  public getLockoutStatus(userId?: string): LockoutStatus {
    const key = userId || 'system';
    const store = this.getLockoutStore();
    const record = store[key];
    if (!record) {
      return { isLocked: false, remainingSeconds: 0, failedAttempts: 0, lockoutCycle: 0 };
    }

    if (record.lockedUntil) {
      const diffMs = record.lockedUntil - Date.now();
      if (diffMs > 0) {
        return {
          isLocked: true,
          remainingSeconds: Math.ceil(diffMs / 1000),
          failedAttempts: record.failedAttempts || 0,
          lockoutCycle: record.lockoutCycle || 0,
        };
      }
      // Lockout expired
      record.lockedUntil = null;
      record.failedAttempts = 0;
      this.saveLockoutStore(store);
    }

    return {
      isLocked: false,
      remainingSeconds: 0,
      failedAttempts: record.failedAttempts || 0,
      lockoutCycle: record.lockoutCycle || 0,
    };
  }

  public recordFailedAttempt(userId?: string): { isLocked: boolean; remainingSeconds: number; lockoutMinutes: number } {
    const key = userId || 'system';
    const store = this.getLockoutStore();
    const record: LockoutRecord = store[key] || { failedAttempts: 0, lockoutCycle: 0, lockedUntil: null };

    record.failedAttempts = (record.failedAttempts || 0) + 1;

    // After 5 failed attempts -> Lockout starts at 2 minutes and doubles each cycle, with max cap of 15 minutes
    if (record.failedAttempts >= 5) {
      record.lockoutCycle = (record.lockoutCycle || 0) + 1;
      const rawMinutes = 2 * Math.pow(2, record.lockoutCycle - 1); // 2, 4, 8, 16...
      const durationMinutes = Math.min(15, rawMinutes); // Capped at 15 minutes!
      record.lockedUntil = Date.now() + durationMinutes * 60 * 1000;
      record.failedAttempts = 0; // Reset counter for next cycle

      store[key] = record;
      this.saveLockoutStore(store);

      storage.addAuditLog(
        'AUTH',
        'قفل أمني للحساب',
        'الأمان',
        key,
        `تم قفل تسجيل الدخول للمستخدم (${key}) لمدة ${durationMinutes} دقيقة بسبب تكرار 5 محاولات خاطئة متتالية (دورة القفل رقم ${record.lockoutCycle})`
      );

      return {
        isLocked: true,
        remainingSeconds: durationMinutes * 60,
        lockoutMinutes: durationMinutes,
      };
    }

    store[key] = record;
    this.saveLockoutStore(store);
    return { isLocked: false, remainingSeconds: 0, lockoutMinutes: 0 };
  }

  public recordSuccessfulLogin(user: User): void {
    const store = this.getLockoutStore();
    delete store[user.id];
    delete store['system'];
    this.saveLockoutStore(store);
    storage.setActiveUser(user.id);
  }

  // Admin unlocks any cashier from UsersManager screen (Requirement 2)
  public unlockUserByAdmin(adminUser: User, targetUserId: string): { success: boolean; error?: string } {
    if (adminUser.role !== 'ADMIN') {
      return { success: false, error: 'غير مصرح: فك قفل الحسابات مقتصر على مدير النظام فقط' };
    }

    const store = this.getLockoutStore();
    delete store[targetUserId];
    this.saveLockoutStore(store);

    storage.addAuditLog(
      'AUTH',
      'فك قفل الحساب',
      'الأمان',
      targetUserId,
      `قام المدير (${adminUser.fullName}) بفك قفل تسجيل الدخول للمستخدم`
    );

    return { success: true };
  }

  public resetLockoutForTesting(userId?: string): void {
    if (userId) {
      const store = this.getLockoutStore();
      delete store[userId];
      this.saveLockoutStore(store);
    } else {
      localStorage.removeItem(STORAGE_KEYS.LOCKOUT);
    }
  }

  // Security Settings (Auto-Lock timeout)
  public getSecuritySettings(): SecuritySettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SECURITY_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.autoLockMinutes === 'number') {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return { autoLockMinutes: 10 }; // Default 10 minutes
  }

  public updateSecuritySettings(updates: Partial<SecuritySettings>): void {
    const current = this.getSecuritySettings();
    const updated = { ...current, ...updates };
    try {
      localStorage.setItem(STORAGE_KEYS.SECURITY_SETTINGS, JSON.stringify(updated));
    } catch {}
    storage.addAuditLog(
      'SETTINGS',
      'تعديل إعدادات الأمان',
      'الأمان',
      'system',
      `تم تحديث مدة القفل التلقائي إلى: ${updated.autoLockMinutes} دقيقة`
    );
  }

  // Authenticate user with PBKDF2 hash, migration from legacy PIN, and default PIN enforcement
  public async authenticate(userId: string, pin: string): Promise<AuthResult> {
    const lockout = this.getLockoutStatus(userId);
    if (lockout.isLocked) {
      return {
        success: false,
        error: `تم قفل تسجيل الدخول لهذا المستخدم مؤقتاً بسبب تكرار المحاولات الخاطئة. يرجى الانتظار ${lockout.remainingSeconds} ثانية.`,
        isLockedOut: true,
        remainingSeconds: lockout.remainingSeconds,
      };
    }

    const cleanPin = normalizeArabicDigits(pin).trim();
    if (!cleanPin) {
      return { success: false, error: 'يرجى إدخال الرقم السري (PIN)' };
    }

    const users = storage.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      this.recordFailedAttempt(userId);
      return { success: false, error: 'المستخدم غير موجود' };
    }

    if (user.isActive === false) {
      return {
        success: false,
        error: 'تم تعطيل هذا الحساب من قبل مدير النظام. يرجى مراجعة الإدارة.',
      };
    }

    // CASE 1: Migrated or Modern user with PBKDF2 hash
    if (user.pinHash && user.pinSalt) {
      const isMatch = await verifyPasswordWithPbkdf2(cleanPin, user.pinHash, user.pinSalt);
      if (!isMatch) {
        const failResult = this.recordFailedAttempt(user.id);
        storage.addAuditLog(
          'AUTH',
          'محاولة دخول فاشلة',
          'الأمان',
          user.id,
          `محاولة دخول فاشلة برقم سري غير صحيح للمستخدم: ${user.fullName}`
        );

        if (failResult.isLocked) {
          return {
            success: false,
            error: `تم قفل تسجيل الدخول لمدة ${failResult.lockoutMinutes} دقيقة بسبب 5 محاولات خاطئة متتالية.`,
            isLockedOut: true,
            remainingSeconds: failResult.remainingSeconds,
          };
        }
        return { success: false, error: 'الرقم السري غير صحيح، حاول مرة أخرى' };
      }

      // If user was flagged to change default PIN (e.g. 1234 or 1111)
      if (user.mustChangePin) {
        return {
          success: true,
          user,
          mustChangePin: true,
        };
      }

      // Success
      this.recordSuccessfulLogin(user);
      storage.addAuditLog(
        'AUTH',
        'تسجيل دخول ناجح',
        'الأمان',
        user.id,
        `تسجيل دخول ناجح للمستخدم: ${user.fullName} (${user.role === 'ADMIN' ? 'مدير عام' : 'كاشير مبيعات'})`
      );
      return { success: true, user };
    }

    // CASE 2: Legacy user with plaintext pinCode
    if (user.pinCode) {
      const isLegacyMatch = normalizeArabicDigits(user.pinCode).trim() === cleanPin;
      if (!isLegacyMatch) {
        const failResult = this.recordFailedAttempt(user.id);
        storage.addAuditLog(
          'AUTH',
          'محاولة دخول فاشلة',
          'الأمان',
          user.id,
          `محاولة دخول فاشلة برقم سري قديم غير صحيح للمستخدم: ${user.fullName}`
        );

        if (failResult.isLocked) {
          return {
            success: false,
            error: `تم قفل تسجيل الدخول لمدة ${failResult.lockoutMinutes} دقيقة بسبب 5 محاولات خاطئة متتالية.`,
            isLockedOut: true,
            remainingSeconds: failResult.remainingSeconds,
          };
        }
        return { success: false, error: 'الرقم السري غير صحيح، حاول مرة أخرى' };
      }

      // Verified legacy PIN! Migrate to PBKDF2 hash and delete plaintext
      const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanPin);
      user.pinHash = hashHex;
      user.pinSalt = saltHex;
      delete user.pinCode;

      // Check if was a known default PIN (e.g. 1234 or 1111)
      const isDefault = isKnownDefaultPin(cleanPin);
      if (isDefault) {
        user.mustChangePin = true;
      }

      storage.saveUser(user, { bypassLicenseCheck: true });

      storage.addAuditLog(
        'AUTH',
        'ترحيل أمان الرقم السري',
        'الأمان',
        user.id,
        `تم ترحيل وتشفير الرقم السري بـ PBKDF2 للمستخدم: ${user.fullName} وحذف النص الصريح`
      );

      if (user.mustChangePin) {
        return {
          success: true,
          user,
          mustChangePin: true,
        };
      }

      this.recordSuccessfulLogin(user);
      storage.addAuditLog(
        'AUTH',
        'تسجيل دخول ناجح',
        'الأمان',
        user.id,
        `تسجيل دخول ناجح للمستخدم: ${user.fullName} (${user.role === 'ADMIN' ? 'مدير عام' : 'كاشير مبيعات'})`
      );
      return { success: true, user };
    }

    // No password set at all
    if (user.role === 'SALES') {
      return {
        success: false,
        error: 'لم يتم تعيين رقم سري (PIN) لهذا الكاشير بعد. يرجى من المدير تعيين رقم سري من شاشة إدارة المستخدمين.',
      };
    }
    if (this.isCredentialsResetRequired()) {
      return {
        success: false,
        error: 'يلزم تعيين كلمة مرور جديدة لحساب المدير لإكمال الاستعادة السحابية.',
      };
    }
    return { success: false, error: 'لم يتم تعيين رقم سري لهذا المستخدم بعد' };
  }

  public isCredentialsResetRequired(): boolean {
    return storage.getCredentialsResetRequired();
  }

  public setCredentialsResetRequired(required: boolean): void {
    storage.setCredentialsResetRequired(required);
  }

  /**
   * Post-cloud-restore Admin password onboarding.
   * Strictly permitted ONLY when `credentialsResetRequired` is true AND the target active ADMIN has no stored credentials.
   */
  public async completePostRestoreAdminSetup(
    adminUserId: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string; user?: User }> {
    if (!this.isCredentialsResetRequired()) {
      return {
        success: false,
        error: 'هذه العملية متاحة فقط بعد استعادة نسخة سحابية تتطلب إعداد كلمة مرور جديدة للمدير.',
      };
    }

    const users = storage.getUsers();
    const target = users.find(u => u.id === adminUserId);
    if (!target) {
      return { success: false, error: 'حساب المدير المحدد غير موجود' };
    }
    if (target.isActive === false) {
      return { success: false, error: 'حساب المدير المحدد معطل حالياً' };
    }
    if (target.role !== 'ADMIN') {
      return { success: false, error: 'تعيين كلمة المرور بعد الاستعادة مقتصر على حساب المدير العام فقط' };
    }
    if (userHasCredentials(target)) {
      return { success: false, error: 'هذا الحساب يمتلك كلمة مرور مسجلة بالفعل' };
    }

    const cleanNew = normalizeArabicDigits(newPassword || '').trim();
    if (cleanNew.length < 6) {
      return { success: false, error: 'كلمة مرور المدير يجب ألا تقل عن 6 خانات' };
    }
    if (isKnownDefaultPin(cleanNew)) {
      return {
        success: false,
        error: 'لا يمكن استخدام كلمة مرور افتراضية شائعة (مثل 1234 أو 1111 أو 123456). يرجى اختيار كلمة مرور قوية.',
      };
    }

    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanNew);
    const updatedAdmin: User = {
      ...target,
      pinHash: hashHex,
      pinSalt: saltHex,
    };
    delete updatedAdmin.pinCode;
    delete updatedAdmin.mustChangePin;

    const saveRes = storage.saveUser(updatedAdmin, { bypassLicenseCheck: true });
    if (!saveRes.success) {
      return { success: false, error: saveRes.error || 'تعذر حفظ كلمة مرور المدير' };
    }

    // Clear reset flag now that an active admin has valid credentials set
    storage.setCredentialsResetRequired(false);
    this.recordSuccessfulLogin(updatedAdmin);

    try {
      await storage.flush();
    } catch {}

    storage.addAuditLog(
      'AUTH',
      'إعداد كلمة مرور المدير بعد الاستعادة السحابية',
      'الأمان',
      updatedAdmin.id,
      `تم تعيين كلمة مرور جديدة مشفرة بـ PBKDF2 لحساب المدير (${updatedAdmin.fullName}) بعد استعادة النسخة السحابية`
    );

    return { success: true, user: updatedAdmin };
  }

  /**
   * Re-verifies a user's password/PIN without resetting active user session or triggering full login flow.
   * Used for sensitive operations like switching AccountingMode.
   */
  public async verifyUserPassword(userId: string, passwordOrPin: string): Promise<{ valid: boolean; error?: string }> {
    const cleanPin = normalizeArabicDigits(passwordOrPin || '').trim();
    if (!cleanPin) {
      return { valid: false, error: 'يرجى إدخال كلمة مرور / الرقم السري للمدير للتأكيد' };
    }

    const users = storage.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      return { valid: false, error: 'المستخدم غير موجود' };
    }
    if (user.isActive === false) {
      return { valid: false, error: 'حساب المدير معطل حالياً' };
    }

    if (user.pinHash && user.pinSalt) {
      const isMatch = await verifyPasswordWithPbkdf2(cleanPin, user.pinHash, user.pinSalt);
      return isMatch ? { valid: true } : { valid: false, error: 'كلمة مرور المدير غير صحيحة' };
    }

    if (user.pinCode) {
      const isMatch = normalizeArabicDigits(user.pinCode).trim() === cleanPin;
      return isMatch ? { valid: true } : { valid: false, error: 'كلمة مرور المدير غير صحيحة' };
    }

    return { valid: false, error: 'لم يتم تعيين كلمة مرور لهذا الحساب' };
  }

  // Change user PIN/Password
  public async changeUserPin(
    userId: string,
    oldPin: string,
    newPin: string
  ): Promise<{ success: boolean; error?: string }> {
    const users = storage.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };

    const cleanOld = normalizeArabicDigits(oldPin).trim();
    const cleanNew = normalizeArabicDigits(newPin).trim();

    // Verify old PIN
    if (user.pinHash && user.pinSalt) {
      const match = await verifyPasswordWithPbkdf2(cleanOld, user.pinHash, user.pinSalt);
      if (!match) return { success: false, error: 'الرقم السري الحالي غير صحيح' };
    } else if (user.pinCode) {
      if (normalizeArabicDigits(user.pinCode).trim() !== cleanOld) return { success: false, error: 'الرقم السري الحالي غير صحيح' };
    } else {
      return { success: false, error: 'تعذر التحقق من الرقم السري القديم' };
    }

    // Check known default PIN first
    if (isKnownDefaultPin(cleanNew)) {
      return {
        success: false,
        error: 'لا يمكن استخدام رقم سري افتراضي شائع (مثل 1234 أو 1111 أو 123456). يرجى اختيار رقم قوي.',
      };
    }

    // Validate new PIN rules
    if (user.role === 'ADMIN') {
      if (cleanNew.length < 6) {
        return { success: false, error: 'كلمة مرور المدير يجب ألا تقل عن 6 خانات' };
      }
    } else {
      if (!/^\d{4,6}$/.test(cleanNew)) {
        return { success: false, error: 'الرقم السري للكاشير يجب أن يتكون من 4 إلى 6 أرقام' };
      }
    }

    // Hash and store
    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanNew);
    user.pinHash = hashHex;
    user.pinSalt = saltHex;
    delete user.pinCode;
    delete user.mustChangePin;

    storage.saveUser(user);
    storage.addAuditLog(
      'AUTH',
      'تغيير الرقم السري',
      'الأمان',
      user.id,
      `تم تغيير وتحديث الرقم السري بنجاح للمستخدم: ${user.fullName} وتشفيره بـ PBKDF2`
    );

    return { success: true };
  }

  // Initial Admin Setup (on first run when no admin exists)
  public async setupInitialAdmin(data: {
    fullName: string;
    username: string;
    password: string;
    phone?: string;
  }): Promise<User> {
    const cleanName = data.fullName.trim();
    const cleanUsername = data.username.toLowerCase().trim();
    const cleanPassword = normalizeArabicDigits(data.password).trim();

    if (!cleanName) {
      throw new Error('يرجى إدخال اسم المدير بالكامل');
    }
    if (!cleanUsername) {
      throw new Error('يرجى إدخال اسم المستخدم للدخول');
    }
    if (cleanPassword.length < 6) {
      throw new Error('كلمة مرور المدير يجب ألا تقل عن 6 خانات');
    }
    if (isKnownDefaultPin(cleanPassword)) {
      throw new Error('لا يمكن استخدام كلمة مرور افتراضية شائعة. اختر كلمة مرور قوية وفريدة.');
    }

    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanPassword);

    const fullPermissions: UserPermissions = {
      canEditPrice: true,
      canGiveDiscount: true,
      canSellNegativeStock: true,
      canDeleteInvoice: true,
      canEditInvoice: true,
      canViewProfits: true,
      canManageProducts: true,
      canManagePurchases: true,
      canManageCash: true,
      canWithdrawNegativeCash: true,
      canProcessReturns: true,
    };

    const newAdmin: User = {
      id: `admin-${Date.now()}`,
      fullName: cleanName,
      username: cleanUsername,
      role: 'ADMIN',
      isActive: true,
      pinHash: hashHex,
      pinSalt: saltHex,
      phone: data.phone?.trim() || '',
      avatarColor: 'bg-emerald-600',
      permissions: fullPermissions,
    };

    storage.saveUser(newAdmin);
    storage.setActiveUser(newAdmin.id);

    storage.addAuditLog(
      'USER',
      'إعداد المدير المسؤول',
      'الأمان',
      newAdmin.id,
      `تم إعداد حساب المدير المسؤول الأول للنظام: ${newAdmin.fullName} وتشفير كلمة المرور بـ PBKDF2`
    );

    return newAdmin;
  }

  // Admin creating or updating cashier with 4-6 digit PIN
  public async saveCashier(
    adminUser: User,
    cashierData: {
      id?: string;
      fullName: string;
      username: string;
      role: Role;
      pin?: string;
      phone?: string;
      isActive: boolean;
      permissions: UserPermissions;
    }
  ): Promise<{ success: boolean; error?: string; user?: User }> {
    if (adminUser.role !== 'ADMIN') {
      return { success: false, error: 'غير مصرح: هذه العملية مقتصرة على مدير النظام فقط' };
    }

    const cleanName = cashierData.fullName.trim();
    const cleanUsername = cashierData.username.toLowerCase().trim();

    if (!cleanName) return { success: false, error: 'يرجى إدخال الاسم بالكامل' };
    if (!cleanUsername) return { success: false, error: 'يرجى إدخال اسم المستخدم' };

    const isEdit = Boolean(cashierData.id);
    const users = storage.getUsers();

    // Check duplicate username
    const duplicate = users.find(
      u => u.username.toLowerCase() === cleanUsername && (!isEdit || u.id !== cashierData.id)
    );
    if (duplicate) {
      return { success: false, error: 'اسم المستخدم مسجل مسبقاً لمستخدم آخر' };
    }

    let targetUser: User;

    if (isEdit) {
      const existing = users.find(u => u.id === cashierData.id);
      if (!existing) return { success: false, error: 'المستخدم غير موجود' };
      targetUser = { ...existing };
      targetUser.fullName = cleanName;
      targetUser.username = cleanUsername;
      targetUser.role = cashierData.role;
      targetUser.phone = cashierData.phone?.trim() || '';
      targetUser.isActive = cashierData.isActive;
      targetUser.permissions = cashierData.permissions;

      // If new PIN provided
      if (cashierData.pin && cashierData.pin.trim()) {
        const cleanPin = normalizeArabicDigits(cashierData.pin).trim();
        if (targetUser.role === 'ADMIN') {
          if (cleanPin.length < 6) return { success: false, error: 'كلمة مرور المدير يجب ألا تقل عن 6 خانات' };
        } else {
          if (!/^\d{4,6}$/.test(cleanPin)) {
            return { success: false, error: 'الرقم السري للكاشير يجب أن يتكون من 4 إلى 6 أرقام' };
          }
        }
        if (isKnownDefaultPin(cleanPin)) {
          return { success: false, error: 'لا يمكن تعيين رقم سري افتراضي شائع (مثل 1234 أو 1111)' };
        }
        const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanPin);
        targetUser.pinHash = hashHex;
        targetUser.pinSalt = saltHex;
        delete targetUser.pinCode;
        delete targetUser.mustChangePin;
      }
    } else {
      // New user requires PIN
      const cleanPin = normalizeArabicDigits(cashierData.pin || '').trim();
      if (!cleanPin) {
        return { success: false, error: 'يرجى تحديد الرقم السري للمستخدم الجديد' };
      }
      if (cashierData.role === 'ADMIN') {
        if (cleanPin.length < 6) return { success: false, error: 'كلمة مرور المدير يجب ألا تقل عن 6 خانات' };
      } else {
        if (!/^\d{4,6}$/.test(cleanPin)) {
          return { success: false, error: 'الرقم السري للكاشير يجب أن يتكون من 4 إلى 6 أرقام' };
        }
      }
      if (isKnownDefaultPin(cleanPin)) {
        return { success: false, error: 'لا يمكن تعيين رقم سري افتراضي شائع (مثل 1234 أو 1111)' };
      }

      const { hashHex, saltHex } = await hashPasswordWithPbkdf2(cleanPin);

      targetUser = {
        id: `u-${Date.now()}`,
        fullName: cleanName,
        username: cleanUsername,
        role: cashierData.role,
        isActive: cashierData.isActive,
        pinHash: hashHex,
        pinSalt: saltHex,
        phone: cashierData.phone?.trim() || '',
        avatarColor: cashierData.role === 'ADMIN' ? 'bg-emerald-600' : 'bg-blue-600',
        permissions: cashierData.permissions,
      };
    }

    const saveRes = storage.saveUser(targetUser);
    if (!saveRes.success) {
      return { success: false, error: saveRes.error };
    }

    storage.addAuditLog(
      'USER',
      isEdit ? 'تعديل مستخدم' : 'إضافة مستخدم',
      'المستخدمين',
      targetUser.id,
      `تم ${isEdit ? 'تعديل بيانات' : 'إضافة'} المستخدم: ${targetUser.fullName} (${targetUser.role}) بواسطة المدير`
    );

    return { success: true, user: targetUser };
  }

  // Toggle user activation state (disable / enable)
  public toggleUserActive(
    adminUser: User,
    targetUserId: string
  ): { success: boolean; error?: string; user?: User } {
    if (adminUser.role !== 'ADMIN') {
      return { success: false, error: 'غير مصرح: تعطيل الحسابات مقتصر على المدير العام فقط' };
    }

    if (adminUser.id === targetUserId) {
      return { success: false, error: 'لا يمكن للمدير تعطيل حسابه الشخصي المسجل به حالياً' };
    }

    const users = storage.getUsers();
    const target = users.find(u => u.id === targetUserId);
    if (!target) return { success: false, error: 'المستخدم غير موجود' };

    // Prevent disabling last active admin
    if (target.role === 'ADMIN' && target.isActive) {
      const activeAdmins = users.filter(u => u.role === 'ADMIN' && u.isActive && u.id !== targetUserId);
      if (activeAdmins.length === 0) {
        return { success: false, error: 'لا يمكن تعطيل آخر مدير نشط في النظام' };
      }
    }

    target.isActive = !target.isActive;
    storage.saveUser(target);

    storage.addAuditLog(
      'USER',
      target.isActive ? 'تفعيل مستخدم' : 'تعطيل مستخدم',
      'المستخدمين',
      target.id,
      `تم ${target.isActive ? 'إعادة تفعيل' : 'تعطيل'} حساب المستخدم: ${target.fullName}`
    );

    return { success: true, user: target };
  }
}

export const authSecurityService = new AuthSecurityService();
