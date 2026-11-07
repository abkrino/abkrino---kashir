import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { 
  licenseService, 
  LicensePayload,
  stringToBase64Url,
  bytesToBase64Url
} from './licenseService';
import testPrivateKeyJwk from '../../tools/.dev-private-key.json';

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

const privateKey = crypto.createPrivateKey({ key: testPrivateKeyJwk, format: 'jwk' });

function signToken(payload: LicensePayload, tamperedPayload = false): string {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = stringToBase64Url(jsonStr);

  // IEEE-P1363 raw signature (64 bytes)
  const signature = crypto.sign('SHA256', Buffer.from(payloadB64, 'utf-8'), {
    key: privateKey,
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

  it('2. حمولة معدّلة (Tampered payload) - detection of tampered data and invalid signature', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId,
      mode: 'offline',
      plan: 'باقة احترافية',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    // Sign and then tamper with the payload string
    const tamperedToken = signToken(payload, true);
    const result = await licenseService.verifyAndStoreLicense(tamperedToken);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('tampered');
  });

  it('3. جهاز مختلف (Wrong device) - license signature is valid but deviceId mismatches', async () => {
    const differentDeviceId = 'different-machine-device-999';
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-test',
      branchId: 'branch-1',
      deviceId: differentDeviceId,
      mode: 'offline',
      plan: 'باقة احترافية',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const token = signToken(payload);
    const result = await licenseService.verifyAndStoreLicense(token);

    expect(result.success).toBe(false);
    expect(result.error).toContain('الترخيص مخصص لجهاز آخر');
  });

  it('4. ترخيص منتهي (Expired license beyond grace period) - correctly identifies expired status', async () => {
    const deviceId = licenseService.getDeviceId();
    // Issued 60 days ago, expired 20 days ago (past the 7 days grace)
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

  it('5. داخل فترة السماح (Inside grace period) - identifies grace period and remaining grace days', async () => {
    const deviceId = licenseService.getDeviceId();
    // Expired 2 days ago, but within 7 grace days -> 5 grace days remaining
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

  it('6. رجوع الساعة (Clock rollback) - detects system clock turned backward by more than 5 minutes', () => {
    // Record a future timestamp into lastSeenAt (e.g. 2 hours in the future)
    const futureTime = Date.now() + 2 * 60 * 60 * 1000;
    localStorage.setItem('app_license_last_seen_at', String(futureTime));

    const rollbackDetected = licenseService.checkClockRollback();
    expect(rollbackDetected).toBe(true);

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('clock-rollback');
    expect(state.message).toContain('تم تعديل أو إرجاع وقت وتاريخ الجهاز إلى الوراء');
  });
});
