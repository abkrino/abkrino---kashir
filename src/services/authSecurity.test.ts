import { describe, it, expect, beforeEach } from 'vitest';
import { 
  authSecurityService, 
  hashPasswordWithPbkdf2, 
  verifyPasswordWithPbkdf2, 
  checkUserPermission 
} from './authSecurityService';
import { storage } from './storageService';
import { User } from '../types';

// In-memory localStorage mock for node environment
const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
  });
}

describe('AuthSecurityService & Local Users Security Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    authSecurityService.resetLockoutForTesting();
  });

  // 1. Hash & Verify with PBKDF2-SHA256 (100,000 iterations)
  it('(1) تشفير PBKDF2-SHA256 والتحقق الصحيح من كلمة المرور', async () => {
    const password = 'SecurePassword#2026';
    const { hashHex, saltHex } = await hashPasswordWithPbkdf2(password);

    expect(hashHex).toBeDefined();
    expect(hashHex.length).toBe(64); // 256 bits = 64 hex characters
    expect(saltHex).toBeDefined();
    expect(saltHex.length).toBe(32); // 128 bits = 32 hex characters

    // Correct verification
    const isValid = await verifyPasswordWithPbkdf2(password, hashHex, saltHex);
    expect(isValid).toBe(true);

    // Wrong password fails
    const isInvalid = await verifyPasswordWithPbkdf2('WrongPassword123', hashHex, saltHex);
    expect(isInvalid).toBe(false);
  });

  // 2. Authentication with wrong PIN fails and tracks attempts
  it('(2) محاولة الدخول برقم سري (PIN) خاطئ تفشل وتزيد عداد الأخطاء', async () => {
    const admin = await authSecurityService.setupInitialAdmin({
      fullName: 'مدير النظام',
      username: 'admin',
      password: 'MyAdminPassword99',
    });

    const result = await authSecurityService.authenticate(admin.id, 'WrongPIN123');
    expect(result.success).toBe(false);
    expect(result.error).toContain('الرقم السري غير صحيح');

    const lockoutStatus = authSecurityService.getLockoutStatus(admin.id);
    expect(lockoutStatus.failedAttempts).toBe(1);
    expect(lockoutStatus.isLocked).toBe(false);
  });

  // 3. Lockout triggers after 5 failed attempts and persists across simulated reload
  it('(3) قفل تسجيل الدخول بعد 5 محاولات خاطئة واستمرار القفل بعد إعادة التحميل', async () => {
    const admin = await authSecurityService.setupInitialAdmin({
      fullName: 'مدير المتجر',
      username: 'storeadmin',
      password: 'StrongStorePassword2026',
    });

    // 4 wrong attempts
    for (let i = 0; i < 4; i++) {
      const res = await authSecurityService.authenticate(admin.id, `bad_${i}`);
      expect(res.success).toBe(false);
      expect(res.isLockedOut).toBeFalsy();
    }

    // 5th wrong attempt triggers 2-minute lockout
    const fifthRes = await authSecurityService.authenticate(admin.id, 'bad_5');
    expect(fifthRes.success).toBe(false);
    expect(fifthRes.isLockedOut).toBe(true);
    expect(fifthRes.remainingSeconds).toBeGreaterThan(115); // ~120s

    // Verify lockout status
    const statusBefore = authSecurityService.getLockoutStatus(admin.id);
    expect(statusBefore.isLocked).toBe(true);
    expect(statusBefore.lockoutCycle).toBe(1);

    // Simulate page reload (reading persisted lockout from localStorage)
    const rawStored = localStorage.getItem('pos_auth_lockout_v1');
    expect(rawStored).toBeTruthy();

    const freshServiceStatus = authSecurityService.getLockoutStatus(admin.id);
    expect(freshServiceStatus.isLocked).toBe(true);
    expect(freshServiceStatus.remainingSeconds).toBeGreaterThan(110);

    // Attempting even correct password during lockout is blocked
    const blockedRes = await authSecurityService.authenticate(admin.id, 'StrongStorePassword2026');
    expect(blockedRes.success).toBe(false);
    expect(blockedRes.isLockedOut).toBe(true);
  });

  // 4. Migration of legacy plaintext PIN to PBKDF2 hash on first successful login and deletion of plaintext
  it('(4) ترحيل الرقم السري القديم النصي وتشفيره بـ PBKDF2 وحذف النص الصريح', async () => {
    // Seed a legacy user who only has plaintext pinCode
    const legacyUser: User = {
      id: 'legacy-cashier-1',
      username: 'cashier99',
      fullName: 'كاشير قديم',
      role: 'SALES',
      isActive: true,
      pinCode: '7890', // non-default custom PIN
    };
    storage.saveUser(legacyUser);

    // First login with old PIN
    const authRes = await authSecurityService.authenticate(legacyUser.id, '7890');
    expect(authRes.success).toBe(true);
    expect(authRes.mustChangePin).toBeFalsy();

    // Verify user in storage: pinCode is deleted, pinHash and pinSalt are set
    const updatedUser = storage.getUsers().find(u => u.id === legacyUser.id)!;
    expect(updatedUser.pinCode).toBeUndefined();
    expect(updatedUser.pinHash).toBeDefined();
    expect(updatedUser.pinSalt).toBeDefined();

    // Verify subsequent login works with the PBKDF2 hash
    const secondLogin = await authSecurityService.authenticate(legacyUser.id, '7890');
    expect(secondLogin.success).toBe(true);
  });

  // 5. Force change when legacy PIN was 1234 or 1111
  it('(5) إجبار المستخدم على تغيير الرقم السري إذا كان الرقم القديم 1234 أو 1111', async () => {
    const legacyDefaultUser: User = {
      id: 'legacy-admin-default',
      username: 'oldadmin',
      fullName: 'مدير قديم',
      role: 'ADMIN',
      isActive: true,
      pinCode: '1234', // Known default PIN!
    };
    storage.saveUser(legacyDefaultUser);

    // Login with default 1234
    const res = await authSecurityService.authenticate(legacyDefaultUser.id, '1234');
    expect(res.success).toBe(true);
    expect(res.mustChangePin).toBe(true);

    const userInStorage = storage.getUsers().find(u => u.id === legacyDefaultUser.id)!;
    expect(userInStorage.pinCode).toBeUndefined(); // plaintext wiped
    expect(userInStorage.mustChangePin).toBe(true);

    // Attempting to change to another default like 1111 fails
    const badChange = await authSecurityService.changeUserPin(legacyDefaultUser.id, '1234', '1111');
    expect(badChange.success).toBe(false);
    expect(badChange.error).toContain('لا يمكن');

    // Changing to a strong unique password succeeds
    const goodChange = await authSecurityService.changeUserPin(legacyDefaultUser.id, '1234', 'NewSuperSecret#2026');
    expect(goodChange.success).toBe(true);

    const verifiedUser = storage.getUsers().find(u => u.id === legacyDefaultUser.id)!;
    expect(verifiedUser.mustChangePin).toBeFalsy();

    // Now login succeeds normally without force flag
    const normalLogin = await authSecurityService.authenticate(legacyDefaultUser.id, 'NewSuperSecret#2026');
    expect(normalLogin.success).toBe(true);
    expect(normalLogin.mustChangePin).toBeFalsy();
  });

  // 6. Centralized permission check denying user without permission (and allowing admin)
  it('(6) دالة التحقق المركزية تمنع المستخدم بلا صلاحية وتسمح للمدير', () => {
    const admin: User = {
      id: 'admin-1',
      username: 'boss',
      fullName: 'المدير العام',
      role: 'ADMIN',
      isActive: true,
    };

    const cashierRestricted: User = {
      id: 'cashier-1',
      username: 'sales',
      fullName: 'كاشير مبيعات',
      role: 'SALES',
      isActive: true,
      permissions: {
        canEditPrice: false,
        canGiveDiscount: false,
        canSellNegativeStock: false,
        canDeleteInvoice: false,
        canEditInvoice: false,
        canViewProfits: false,
        canManageProducts: false,
        canManagePurchases: false,
        canManageCash: false,
      },
    };

    const cashierWithDiscount: User = {
      id: 'cashier-2',
      username: 'sales2',
      fullName: 'كاشير متميز',
      role: 'SALES',
      isActive: true,
      permissions: {
        canEditPrice: false,
        canGiveDiscount: true,
        canSellNegativeStock: false,
        canDeleteInvoice: false,
        canEditInvoice: false,
        canViewProfits: false,
        canManageProducts: false,
        canManagePurchases: false,
        canManageCash: false,
      },
    };

    // Admin has full permissions for all sensitive operations
    expect(checkUserPermission(admin, 'delete_invoice')).toBe(true);
    expect(checkUserPermission(admin, 'edit_price')).toBe(true);
    expect(checkUserPermission(admin, 'give_discount')).toBe(true);
    expect(checkUserPermission(admin, 'sell_negative_stock')).toBe(true);
    expect(checkUserPermission(admin, 'manage_users')).toBe(true);

    // Restricted cashier is denied
    expect(checkUserPermission(cashierRestricted, 'delete_invoice')).toBe(false);
    expect(checkUserPermission(cashierRestricted, 'give_discount')).toBe(false);
    expect(checkUserPermission(cashierRestricted, 'edit_price')).toBe(false);
    expect(checkUserPermission(cashierRestricted, 'sell_negative_stock')).toBe(false);
    expect(checkUserPermission(cashierRestricted, 'manage_users')).toBe(false);

    // Cashier with permission gets allowed only for permitted operation
    expect(checkUserPermission(cashierWithDiscount, 'give_discount')).toBe(true);
    expect(checkUserPermission(cashierWithDiscount, 'delete_invoice')).toBe(false);

    // Inactive user is denied everything
    const inactiveUser: User = { ...cashierWithDiscount, isActive: false };
    expect(checkUserPermission(inactiveUser, 'give_discount')).toBe(false);
  });

  // 7. Per-user lockout: Locking cashier A does not block cashier B or admin
  it('(7) القفل لكل مستخدم: قفل كاشير معين لا يمنع المدير ولا بقية الكاشيرية', async () => {
    const admin: User = {
      id: 'u-admin-test',
      username: 'adminboss',
      fullName: 'المدير',
      role: 'ADMIN',
      isActive: true,
      pinCode: '998877',
    };
    const cashier1: User = {
      id: 'u-cashier-1',
      username: 'cashier1',
      fullName: 'كاشير 1',
      role: 'SALES',
      isActive: true,
      pinCode: '4321',
    };
    const cashier2: User = {
      id: 'u-cashier-2',
      username: 'cashier2',
      fullName: 'كاشير 2',
      role: 'SALES',
      isActive: true,
      pinCode: '5678',
    };

    storage.saveUser(admin);
    storage.saveUser(cashier1);
    storage.saveUser(cashier2);

    // Fail cashier1 5 times -> locks cashier1
    for (let i = 0; i < 5; i++) {
      await authSecurityService.authenticate(cashier1.id, 'wrong_pin');
    }

    // Cashier 1 is locked
    const cashier1Status = authSecurityService.getLockoutStatus(cashier1.id);
    expect(cashier1Status.isLocked).toBe(true);

    // Cashier 2 is NOT locked!
    const cashier2Status = authSecurityService.getLockoutStatus(cashier2.id);
    expect(cashier2Status.isLocked).toBe(false);

    // Admin is NOT locked!
    const adminStatus = authSecurityService.getLockoutStatus(admin.id);
    expect(adminStatus.isLocked).toBe(false);

    // Cashier 2 can authenticate normally
    const c2Auth = await authSecurityService.authenticate(cashier2.id, '5678');
    expect(c2Auth.success).toBe(true);

    // Admin can authenticate normally
    const adminAuth = await authSecurityService.authenticate(admin.id, '998877');
    expect(adminAuth.success).toBe(true);
  });

  // 8. 15-minute cap on lockout duration
  it('(8) سقف مدة القفل الأمني هو 15 دقيقة مهما تكررت دورات القفل المتتالية', () => {
    const testUserId = 'user-ceiling-test';

    // Cycle 1: 2 minutes
    for (let i = 0; i < 5; i++) authSecurityService.recordFailedAttempt(testUserId);
    let status = authSecurityService.getLockoutStatus(testUserId);
    expect(status.isLocked).toBe(true);
    expect(status.remainingSeconds).toBe(2 * 60);

    // Cycle 2: 4 minutes
    for (let i = 0; i < 5; i++) authSecurityService.recordFailedAttempt(testUserId);
    status = authSecurityService.getLockoutStatus(testUserId);
    expect(status.isLocked).toBe(true);
    expect(status.remainingSeconds).toBe(4 * 60);

    // Cycle 3: 8 minutes
    for (let i = 0; i < 5; i++) authSecurityService.recordFailedAttempt(testUserId);
    status = authSecurityService.getLockoutStatus(testUserId);
    expect(status.isLocked).toBe(true);
    expect(status.remainingSeconds).toBe(8 * 60);

    // Cycle 4: 2 * 2^3 = 16 -> capped at 15 minutes!
    for (let i = 0; i < 5; i++) authSecurityService.recordFailedAttempt(testUserId);
    status = authSecurityService.getLockoutStatus(testUserId);
    expect(status.isLocked).toBe(true);
    expect(status.remainingSeconds).toBe(15 * 60);

    // Cycle 5: 2 * 2^4 = 32 -> still capped at 15 minutes!
    for (let i = 0; i < 5; i++) authSecurityService.recordFailedAttempt(testUserId);
    status = authSecurityService.getLockoutStatus(testUserId);
    expect(status.isLocked).toBe(true);
    expect(status.remainingSeconds).toBe(15 * 60);
  });

  // 9. Admin unlocking a cashier
  it('(9) المدير يستطيع فك قفل أي كاشير من شاشة المستخدمين وتصفير القفل له', async () => {
    const admin: User = {
      id: 'admin-unlocker',
      username: 'bossman',
      fullName: 'المدير الفاتح',
      role: 'ADMIN',
      isActive: true,
    };
    const cashier: User = {
      id: 'cashier-locked',
      username: 'cashierlock',
      fullName: 'كاشير مقفول',
      role: 'SALES',
      isActive: true,
      pinCode: '6543',
    };
    storage.saveUser(admin);
    storage.saveUser(cashier);

    // Lock the cashier with 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await authSecurityService.authenticate(cashier.id, 'wrong');
    }
    expect(authSecurityService.getLockoutStatus(cashier.id).isLocked).toBe(true);

    // Non-admin cannot unlock
    const nonAdminAttempt = authSecurityService.unlockUserByAdmin(cashier, cashier.id);
    expect(nonAdminAttempt.success).toBe(false);
    expect(nonAdminAttempt.error).toContain('غير مصرح');
    expect(authSecurityService.getLockoutStatus(cashier.id).isLocked).toBe(true);

    // Admin unlocks cashier successfully
    const adminUnlock = authSecurityService.unlockUserByAdmin(admin, cashier.id);
    expect(adminUnlock.success).toBe(true);

    // Cashier is now immediately unlocked
    expect(authSecurityService.getLockoutStatus(cashier.id).isLocked).toBe(false);

    // Cashier can log in right away with correct PIN
    const loginRes = await authSecurityService.authenticate(cashier.id, '6543');
    expect(loginRes.success).toBe(true);
  });

  // 10. getActiveUser() returns null when no active user is set (no fallback to users[0])
  it('(10) getActiveUser() بدون مستخدم نشط تُرجع null ولا تُرجع users[0]', () => {
    localStorage.removeItem('pos_active_user_id');

    // Add some users
    const userA: User = { id: 'u-a', fullName: 'المستخدم الأول', username: 'usera', role: 'ADMIN', isActive: true };
    const userB: User = { id: 'u-b', fullName: 'المستخدم الثاني', username: 'userb', role: 'SALES', isActive: true };
    storage.saveUser(userA);
    storage.saveUser(userB);

    // Ensure no active user ID is set
    localStorage.removeItem('pos_active_user_id');

    // Must return null, NOT users[0] (userA)!
    const active = storage.getActiveUser();
    expect(active).toBeNull();

    // When an active user is explicitly set
    storage.setActiveUser(userB.id);
    const updatedActive = storage.getActiveUser();
    expect(updatedActive).not.toBeNull();
    expect(updatedActive?.id).toBe(userB.id);

    // If activeId points to non-existent user, it still returns null
    storage.setActiveUser('non-existent-user-id');
    expect(storage.getActiveUser()).toBeNull();
  });
});
