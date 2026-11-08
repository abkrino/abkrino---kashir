import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import crypto from 'node:crypto';
import {
  licenseService,
  LicensePayload,
  isStoreActivated,
  LICENSE_ENFORCEMENT,
  setLicenseEnforcement,
  stringToBase64Url,
  bytesToBase64Url,
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

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    writable: true,
  });
}

const privateKey = crypto.createPrivateKey({ key: testPrivateKeyJwk, format: 'jwk' });

function signToken(payload: LicensePayload): string {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = stringToBase64Url(jsonStr);

  const signature = crypto.sign('SHA256', Buffer.from(payloadB64, 'utf-8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  return `${payloadB64}.${sigB64}`;
}

// Helper to recursively collect all source files
function getAllSourceFiles(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) {
      getAllSourceFiles(fullPath, fileList);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

describe('LicenseGate & Authentication Architecture Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    licenseService.removeLicense();
    licenseService.clearTrialBypass();
    setLicenseEnforcement(false);
  });

  it('(أ) جهاز غير مفعّل يرى LicenseGate ولا يرى شاشة PIN', () => {
    // When no license is installed and no trial bypass is active
    expect(licenseService.isStoreActivated()).toBe(false);
    expect(isStoreActivated()).toBe(false);

    const state = licenseService.getLicenseState();
    expect(state.status).toBe('unlicensed');
    // Store is locked at gatekeeper: user cannot bypass to PIN screen without activating or trial bypass
  });

  it('(ب) تفعيل ترخيص صالح ينقل لشاشة PIN بنجاح', async () => {
    const deviceId = licenseService.getDeviceId();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload: LicensePayload = {
      v: 1,
      orgId: 'org-market-1',
      branchId: 'branch-main',
      deviceId,
      mode: 'offline',
      plan: 'باقة السوبر ماركت الشاملة',
      issuedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
      graceDays: 7,
      maxOfflineDays: 30,
    };

    const validToken = signToken(payload);

    // Initial state: not activated
    expect(isStoreActivated()).toBe(false);

    // Verify and store valid license
    const result = await licenseService.verifyAndStoreLicense(validToken);
    expect(result.success).toBe(true);

    // After activation: store is officially activated
    expect(isStoreActivated()).toBe(true);
    const state = licenseService.getLicenseState();
    expect(state.status).toBe('valid');
    expect(state.daysRemaining).toBeGreaterThanOrEqual(29);
  });

  it('(ج) وضع التجربة لا يظهر ولا يعمل إلا عندما LICENSE_ENFORCEMENT=false', () => {
    // 1. When LICENSE_ENFORCEMENT is false (development / trial permitted)
    setLicenseEnforcement(false);
    expect(LICENSE_ENFORCEMENT).toBe(false);

    const trialEnabled = licenseService.enableTrialBypass();
    expect(trialEnabled).toBe(true);
    expect(isStoreActivated()).toBe(true);

    // 2. When LICENSE_ENFORCEMENT is true (production enforcement)
    setLicenseEnforcement(true);
    expect(LICENSE_ENFORCEMENT).toBe(true);

    // Attempting to enable trial bypass is rejected
    const blockedTrial = licenseService.enableTrialBypass();
    expect(blockedTrial).toBe(false);

    // Even if trial_bypass flag exists in localStorage, isStoreActivated returns false
    localStorage.setItem('app_license_trial_bypass', 'true');
    expect(isStoreActivated()).toBe(false);

    // Reset back to false
    setLicenseEnforcement(false);
  });

  it('(د) لا يوجد في الكود أي استيراد لـ createUserWithEmailAndPassword ولا نص cachedPassword ولا PRIMARY_OWNER_EMAIL', () => {
    const srcDir = resolve(__dirname, '..');
    const files = getAllSourceFiles(srcDir);

    const forbiddenTerms = [
      'createUserWithEmailAndPassword',
      'cachedPassword',
      'PRIMARY_OWNER_EMAIL',
    ];

    for (const filePath of files) {
      // Exclude this test file itself from the search
      if (filePath.endsWith('licenseGate.test.ts')) continue;

      const content = readFileSync(filePath, 'utf-8');
      for (const term of forbiddenTerms) {
        const found = content.includes(term);
        expect(
          found,
          `Found forbidden legacy symbol "${term}" in file: ${filePath}`
        ).toBe(false);
      }
    }
  });
});
