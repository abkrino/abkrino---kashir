import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { 
  licenseService, 
  LicensePayload,
  stringToBase64Url,
  bytesToBase64Url
} from './licenseService';
import { beforeAll, afterAll } from 'vitest';

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

// Attach localStorage mock if not available
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
  });
}

let testPrivateKeyObj: crypto.KeyObject;

beforeAll(async () => {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  licenseService.setPublicKeyForTesting(publicJwk as JsonWebKey);
  testPrivateKeyObj = crypto.createPrivateKey({ key: privateJwk as any, format: 'jwk' });
});

afterAll(() => {
  licenseService.setPublicKeyForTesting(null);
});

function signToken(payload: LicensePayload, tamperedPayload = false): string {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = stringToBase64Url(jsonStr);

  // IEEE-P1363 raw signature (64 bytes)
  const signature = crypto.sign('SHA256', Buffer.from(payloadB64, 'utf-8'), {
    key: testPrivateKeyObj,
    dsaEncoding: 'ieee-p1363',
  });

  const sigB64 = bytesToBase64Url(new Uint8Array(signature));

  if (tamperedPayload) {
    // Tamper the payload part by flipping the first character
    const tamperedB64 = (payloadB64[0] === 'e' ? 'f' : 'e') + payloadB64.slice(1);
    return `${tamperedB64}.${sigB64}`;
  }

  return `${payloadB64}.${sigB64}`;
}

describe('licenseService Unit Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    licenseService.removeLicense();
  });

  it('1. ترخيص صحيح (Valid license) - activates successfully and returns valid status', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days valid

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة المحل المتكاملة',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    const result = await licenseService.verifyAndStoreLicense(token);

    expect(result.success).toBe(true);
    expect(result.payload?.plan).toBe('باقة المحل المتكاملة');

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('valid');
    expect(state.daysRemaining).toBeGreaterThanOrEqual(29);
    expect(state.canOperate).toBe(true);
  });

  it('2. (أ) تعديل localStorage يدوياً لا يغيّر الحالة - الـ payload لا يؤخذ أبداً من التخزين بل من التوكن المشفر', async () => {
    // First, verify a valid license
    const deviceId = licenseService.getDeviceId();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-real',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة أصلية',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    await licenseService.verifyAndStoreLicense(token);

    // Attacker modifies localStorage directly
    localStorage.setItem('app_license_payload', JSON.stringify({
      ...payload,
      plan: 'باقة مخترقة وغير مصرح بها VIP',
      validUntil: new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    // getLicenseState should completely ignore app_license_payload in localStorage
    const state = licenseService.getLicenseState();
    expect(state.payload?.plan).toBe('باقة أصلية');

    // Startup with a tampered token in localStorage yields 'tampered'
    localStorage.setItem('app_license_token', 'tampered.token.data');
    await licenseService.initLicense();
    const stateAfterInit = licenseService.getLicenseState();
    expect(stateAfterInit.status).toBe('tampered');
    expect(stateAfterInit.payload).toBeNull();
  });

  it('3. (ب) لصق كود خاطئ فوق ترخيص صالح لا يغيّره ولا يستبدل التوكن السليم', async () => {
    // 1. Activate valid license first
    const deviceId = licenseService.getDeviceId();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة المحل الأساسية',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const validToken = signToken(payload);
    const validResult = await licenseService.verifyAndStoreLicense(validToken);
    expect(validResult.success).toBe(true);

    const stateBefore = licenseService.getLicenseState();
    expect(stateBefore.status).toBe('valid');
    expect(stateBefore.payload?.plan).toBe('باقة المحل الأساسية');

    // 2. User pastes a bad token with invalid signature
    const badToken = signToken(payload, true);
    const badResult = await licenseService.verifyAndStoreLicense(badToken);
    expect(badResult.success).toBe(false);

    // 3. User pastes malformed string
    const malformedResult = await licenseService.verifyAndStoreLicense('garbage_data_without_dot');
    expect(malformedResult.success).toBe(false);

    // 4. User pastes token for different device
    const wrongDeviceToken = signToken({ ...payload, deviceId: 'other-machine-456' });
    const wrongDevResult = await licenseService.verifyAndStoreLicense(wrongDeviceToken);
    expect(wrongDevResult.success).toBe(false);

    // The existing valid license remains 100% active and untouched
    const stateAfter = licenseService.getLicenseState();
    expect(stateAfter.status).toBe('valid');
    expect(stateAfter.payload?.plan).toBe('باقة المحل الأساسية');
    expect(licenseService.getStoredToken()).toBe(validToken);
    expect(localStorage.getItem('app_license_tampered_flag')).toBeNull();
  });

  it('4. (ج) ضبط الساعة 30 يوماً للأمام ثم إرجاعها مع heartbeat سليم لا يقفل (السيرفر هو الحكم)', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = Date.now();
    const validUntil = new Date(now + 365 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة سنوية',
      issuedAt: new Date(now).toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    await licenseService.verifyAndStoreLicense(token);

    // Simulate clock set ahead 30 days in the past, storing a future timestamp
    const future30Days = now + 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem('app_license_last_seen_at', String(future30Days));

    // Clock rollback is detected initially because now < future30Days - 5 min
    expect(licenseService.checkClockRollback()).toBe(true);
    expect(licenseService.getLicenseState().status).toBe('clock-rollback');

    // Server heartbeat arrives: server time confirms real time is within 5 minutes of device now
    const serverTimestampMs = now + 1000; // 1 second difference with device
    const reconcileResult = licenseService.reconcileClockWithServer(serverTimestampMs);

    expect(reconcileResult.reconciled).toBe(true);
    expect(licenseService.checkClockRollback()).toBe(false);

    // System is unlocked and functions normally without lockout
    const state = licenseService.getLicenseState();
    expect(state.status).toBe('valid');
    expect(state.canOperate).toBe(true);

    // If server time difference > 5 minutes, clock does not reconcile and warning is emitted
    const distantServerTime = now + 15 * 60 * 1000; // 15 minutes difference
    const badReconcile = licenseService.reconcileClockWithServer(distantServerTime);
    expect(badReconcile.reconciled).toBe(false);
    expect(badReconcile.warning).toBe('ساعة الجهاز تختلف عن الوقت الحقيقي');
  });

  it('5. ترخيص منتهي (Expired license beyond grace period)', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = Date.now();
    const issuedAt = new Date(now - 60 * 24 * 60 * 60 * 1000);
    const validUntil = new Date(now - 20 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة منتهية',
      issuedAt: issuedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    const result = await licenseService.verifyAndStoreLicense(token);
    expect(result.success).toBe(true);

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('expired');
    expect(state.daysRemaining).toBe(0);
  });

  it('6. داخل فترة السماح (Inside grace period)', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = Date.now();
    const issuedAt = new Date(now - 35 * 24 * 60 * 60 * 1000);
    const validUntil = new Date(now - 2 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة في فترة السماح',
      issuedAt: issuedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    const result = await licenseService.verifyAndStoreLicense(token);
    expect(result.success).toBe(true);

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('grace');
    expect(state.daysRemaining).toBeGreaterThanOrEqual(4);
    expect(state.canOperate).toBe(true);
  });

  it('7. reconcileClockWithServer لا تستدعي notifyListeners عند تكرار القيم نفسها وتستدعيها فقط عند تغيّر حالة الساعة', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = Date.now();
    const validUntil = new Date(now + 365 * 24 * 60 * 60 * 1000);

    const token = signToken({
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة سنوية',
      issuedAt: new Date(now).toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    });
    await licenseService.verifyAndStoreLicense(token);

    let listenerCalls = 0;
    const unsub = licenseService.subscribe(() => {
      listenerCalls++;
    });

    try {
      // Same valid state + matching server time -> NO notification emitted
      const res1 = licenseService.reconcileClockWithServer(Date.now());
      expect(res1.reconciled).toBe(true);
      expect(listenerCalls).toBe(0);

      // Simulate clock rollback -> reconcile unlocks rollback -> notifies ONCE
      localStorage.setItem('app_license_last_seen_at', String(Date.now() + 10 * 24 * 60 * 60 * 1000));
      expect(licenseService.checkClockRollback()).toBe(true);

      const res2 = licenseService.reconcileClockWithServer(Date.now());
      expect(res2.reconciled).toBe(true);
      expect(licenseService.checkClockRollback()).toBe(false);
      expect(listenerCalls).toBe(1);

      // Repeating matching reconcile again -> NO extra notifications
      licenseService.reconcileClockWithServer(Date.now());
      licenseService.reconcileClockWithServer(Date.now());
      expect(listenerCalls).toBe(1);

      // Crossing 5m skew threshold introduces clockWarning -> notifies ONCE, then silent on repeat
      licenseService.reconcileClockWithServer(Date.now() + 15 * 60 * 1000);
      expect(listenerCalls).toBe(2);
      licenseService.reconcileClockWithServer(Date.now() + 15 * 60 * 1000);
      expect(listenerCalls).toBe(2);

      // Recovering back within 5m clears clockWarning -> notifies ONCE
      licenseService.reconcileClockWithServer(Date.now());
      expect(listenerCalls).toBe(3);
    } finally {
      unsub();
    }
  });
});
