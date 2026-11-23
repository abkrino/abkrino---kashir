import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage before importing services
const lsStore: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
      setItem: (k: string, v: string) => {
        lsStore[k] = String(v);
      },
      removeItem: (k: string) => {
        delete lsStore[k];
      },
      clear: () => {
        for (const k of Object.keys(lsStore)) delete lsStore[k];
      },
    },
    writable: true,
  });
}

import { isFirebaseConfigComplete, firestoreDatabaseId } from '../config/firebaseConfig';
import { translateFirebaseError } from './firebaseErrorTranslator';

const UNCONFIGURED_MOCK_CONFIG = {
  apiKey: 'PUT_HERE',
  authDomain: 'PUT_HERE',
  projectId: 'PUT_HERE',
  storageBucket: 'PUT_HERE',
  messagingSenderId: 'PUT_HERE',
  appId: 'PUT_HERE',
};

describe('Cloud Config, Error Translation, Password Safety & No Boot Network Requests', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('../config/firebaseConfig');
    vi.doUnmock('firebase/auth');
    vi.restoreAllMocks();
  });

  it('1) استيراد cloudService لا يرسل أي طلب شبكة (fetch أو XHR) ولا يستدعي testConnection عند الإقلاع', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected fetch call on cloudService import');
    });

    vi.resetModules();
    vi.doMock('../config/firebaseConfig', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config/firebaseConfig')>();
      return {
        ...actual,
        firebaseConfig: { ...UNCONFIGURED_MOCK_CONFIG },
      };
    });

    const mod = await import('./cloudService');

    expect(mod.isCloudConfigured).toBe(false);
    expect(mod.db).toBeNull();
    expect(mod.auth).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Verify zero network/Firebase calls when calling service methods while unconfigured
    const backups = await mod.cloudService.getCloudBackupsList();
    expect(Array.isArray(backups)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const latency = await mod.cloudService.measureCloudLatency();
    expect(latency).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('2) غياب أو عدم اكتمال إعدادات Firebase (PUT_HERE أو فارغ) يعطّل نداءات orgSyncService بلا أخطاء', async () => {
    expect(firestoreDatabaseId).toBe('(default)');

    // 1. كائن فيه PUT_HERE
    expect(isFirebaseConfigComplete(UNCONFIGURED_MOCK_CONFIG, '(default)')).toBe(false);

    // 2. كائن بقيمة فارغة
    expect(
      isFirebaseConfigComplete(
        {
          apiKey: '',
          authDomain: 'a.firebaseapp.com',
          projectId: 'proj',
          storageBucket: 'proj.appspot.com',
          messagingSenderId: '123',
          appId: '1:123:web:abc',
        },
        '(default)'
      )
    ).toBe(false);

    // 3. كائن مكتمل
    expect(
      isFirebaseConfigComplete(
        {
          apiKey: 'AIzaTest',
          authDomain: 'a.firebaseapp.com',
          projectId: 'proj',
          storageBucket: 'proj.appspot.com',
          messagingSenderId: '123',
          appId: '1:123:web:abc',
        },
        '(default)'
      )
    ).toBe(true);

    vi.resetModules();
    vi.doMock('../config/firebaseConfig', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config/firebaseConfig')>();
      return {
        ...actual,
        firebaseConfig: { ...UNCONFIGURED_MOCK_CONFIG },
      };
    });

    const { storage } = await import('./storageService');
    await storage.init();
    const { orgSyncService } = await import('./orgSyncService');
    const hb = await orgSyncService.sendHeartbeat();
    expect(hb.success).toBe(false);
    expect(hb.error).toContain('غير مُعدّة');

    const sum = await orgSyncService.pushDailySummary(true);
    expect(sum.success).toBe(false);
    expect(sum.error).toContain('غير مُعدّة');

    const testConn = await orgSyncService.testConnection();
    expect(testConn.success).toBe(false);
    expect(testConn.message).toContain('غير مُعدّة');

    const loginRes = await orgSyncService.signInStore('owner@store.com', 'SecretPass#123');
    expect(loginRes.success).toBe(false);
    expect(loginRes.error).toContain('غير مُعدّة');
  });

  it('3) ترجمة أخطاء Firebase إلى رسائل عربية واضحة ومحددة', () => {
    const invalidCred = translateFirebaseError({ code: 'auth/invalid-credential', message: 'Invalid login credentials' });
    expect(invalidCred).toContain('بيانات الدخول غير صحيحة');

    const userNotFound = translateFirebaseError({ code: 'auth/user-not-found', message: 'User not found' });
    expect(userNotFound).toContain('لم يتم العثور على حساب');

    const tooMany = translateFirebaseError({ code: 'auth/too-many-requests', message: 'Too many requests' });
    expect(tooMany).toContain('كثرة المحاولات');

    const permDenied = translateFirebaseError({ code: 'permission-denied', message: 'Missing or insufficient permissions' });
    expect(permDenied).toContain('الاشتراك');
    expect(permDenied).toContain('إنشاء');

    const notFound = translateFirebaseError({ code: 'not-found', message: 'No document to update' });
    expect(notFound).toContain('لم يتم العثور على سجل المحل أو الفرع');

    const unavailable = translateFirebaseError({ code: 'unavailable', message: 'The service is currently unavailable' });
    expect(unavailable).toContain('غير متاحة');
  });

  it('4) عدم تخزين كلمة المرور نهائياً في localStorage أو CloudSettings ورفض حساب لا يطابق orgId', async () => {
    vi.resetModules();

    const signOutMock = vi.fn().mockResolvedValue(undefined);
    const signInMock = vi.fn().mockResolvedValue({
      user: { uid: 'DIFFERENT_ORG_UID', email: 'other@store.com' },
    });

    vi.doMock('../config/firebaseConfig', () => ({
      firebaseConfig: {
        apiKey: 'AIzaRealKeyForTest',
        authDomain: 'test-proj.firebaseapp.com',
        projectId: 'test-proj',
        storageBucket: 'test-proj.firebasestorage.app',
        messagingSenderId: '123456',
        appId: '1:123456:web:abcdef',
      },
      firestoreDatabaseId: '(default)',
      isFirebaseConfigComplete: () => true,
    }));

    vi.doMock('firebase/auth', async (importOriginal) => {
      const actual = await importOriginal<typeof import('firebase/auth')>();
      return {
        ...actual,
        getAuth: () => ({ currentUser: null }),
        onAuthStateChanged: () => () => {},
        signInWithEmailAndPassword: signInMock,
        signOut: signOutMock,
      };
    });

    const { orgSyncService } = await import('./orgSyncService');
    const { cloudService } = await import('./cloudService');

    vi.spyOn(orgSyncService, 'getContext').mockReturnValue({
      orgId: 'EXPECTED_ORG_123',
      branchId: 'BRANCH_01',
      mode: 'offline',
    });

    const secretPassword = 'SuperSecretPassword!987';
    const res = await orgSyncService.signInStore('cashier@store.com', secretPassword);

    // Must reject mismatched UID against orgId and sign out immediately
    expect(res.success).toBe(false);
    expect(res.error).toContain('لا يطابق');
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(orgSyncService.getSyncState()).toBe('wrong-account');

    // Verify password is NEVER persisted in localStorage or cloudSettings or lastError
    const serializedStorage = JSON.stringify(lsStore);
    const serializedSettings = JSON.stringify(cloudService.getCloudSettings());
    expect(serializedStorage).not.toContain(secretPassword);
    expect(serializedSettings).not.toContain(secretPassword);
    expect(orgSyncService.getLastError() || '').not.toContain(secretPassword);
  });
});
