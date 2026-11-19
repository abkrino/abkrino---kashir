import { LICENSE_PUBLIC_KEY_JWK } from '../config/licensePublicKey';
import { detectEnvironment } from './environmentService';
import { APP_VERSION, CloudBudgetLimits } from '../config/appConfig';

export interface LicenseFeatures {
  cloudBudget?: Partial<CloudBudgetLimits>;
  [key: string]: unknown;
}

export interface LicensePayload {
  v: number;
  orgId: string;
  branchId: string;
  deviceId: string;
  mode: 'offline' | 'online';
  plan: string;
  issuedAt: string;
  validUntil: string;
  graceDays: number;
  maxOfflineDays: number;
  features?: LicenseFeatures;
}

export type LicenseStatus =
  | 'checking'
  | 'unlicensed'
  | 'valid'
  | 'grace'
  | 'expired'
  | 'tampered'
  | 'wrong-device'
  | 'clock-rollback';

export interface LicenseStateResult {
  status: LicenseStatus;
  daysRemaining: number;
  payload: LicensePayload | null;
  message: string;
  canOperate: boolean;
}

// Default to false so developers are not locked during development
export let LICENSE_ENFORCEMENT = false;

export const setLicenseEnforcement = (val: boolean): void => {
  LICENSE_ENFORCEMENT = val;
};

export const TRIAL_BYPASS_KEY = 'app_license_trial_bypass';

const STORAGE_KEYS = {
  DEVICE_ID: 'app_device_id',
  LICENSE_TOKEN: 'app_license_token',
  LICENSE_PAYLOAD: 'app_license_payload', // Wiped on init; never trusted
  LAST_SEEN_AT: 'app_license_last_seen_at',
  TRIAL_BYPASS: TRIAL_BYPASS_KEY,
};

// Base64URL Helpers
export function stringToBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return bytesToBase64Url(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToString(base64url: string): string {
  const bytes = base64UrlToBytes(base64url);
  return new TextDecoder().decode(bytes);
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

class LicenseService {
  private cachedCryptoKey: CryptoKey | null = null;
  private verifiedPayload: LicensePayload | null = null;
  private isChecking: boolean = false;
  private isTamperedOnBoot: boolean = false;
  private clockWarning: string | null = null;
  private listeners: (() => void)[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.initClockProtection();
    // In browser environment, initiate cryptographic verification on startup
    if (typeof window !== 'undefined') {
      this.initLicense().catch(() => {});
    }
  }

  // --- Clock Rollback Protection ---
  private initClockProtection() {
    this.recordHeartbeat();
    if (typeof window !== 'undefined') {
      this.heartbeatInterval = setInterval(() => {
        this.recordHeartbeat();
      }, 60 * 1000); // Check and record every minute
    }
  }

  public recordHeartbeat(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const now = Date.now();
      const lastSeenStr = localStorage.getItem(STORAGE_KEYS.LAST_SEEN_AT);
      if (!lastSeenStr) {
        localStorage.setItem(STORAGE_KEYS.LAST_SEEN_AT, String(now));
        return;
      }

      const lastSeen = Number(lastSeenStr);
      // If current time is less than lastSeen by more than 5 minutes -> clock rollback
      if (now < lastSeen - 5 * 60 * 1000) {
        // Clock rollback detected, preserve lastSeen to keep detecting
        return;
      }

      // If time advanced normally, record new max time
      if (now > lastSeen) {
        localStorage.setItem(STORAGE_KEYS.LAST_SEEN_AT, String(now));
      }
    } catch {
      // Storage access error handling
    }
  }

  public checkClockRollback(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const lastSeenStr = localStorage.getItem(STORAGE_KEYS.LAST_SEEN_AT);
      if (!lastSeenStr) return false;
      const lastSeen = Number(lastSeenStr);
      const now = Date.now();
      return now < lastSeen - 5 * 60 * 1000;
    } catch {
      return false;
    }
  }

  // Reconcile clock with server (Server is authority)
  public reconcileClockWithServer(serverTimestampMs: number): {
    reconciled: boolean;
    warning?: string;
  } {
    const deviceNow = Date.now();
    const diffMs = Math.abs(serverTimestampMs - deviceNow);
    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    const prevClockWarning = this.clockWarning;
    const prevRollback = this.checkClockRollback();

    if (diffMs <= FIVE_MINUTES_MS) {
      // Within 5 minutes: Fix local lastSeenAt = deviceNow even if less than stored
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEYS.LAST_SEEN_AT, String(deviceNow));
        } catch {}
      }
      this.clockWarning = null;
      const nextRollback = this.checkClockRollback();
      if (prevClockWarning !== this.clockWarning || prevRollback !== nextRollback) {
        this.notifyListeners();
      }
      return { reconciled: true };
    } else {
      // Server diff is greater than 5 minutes: do not change lastSeenAt, show warning
      this.clockWarning = 'ساعة الجهاز تختلف عن الوقت الحقيقي';
      const nextRollback = this.checkClockRollback();
      if (prevClockWarning !== this.clockWarning || prevRollback !== nextRollback) {
        this.notifyListeners();
      }
      return {
        reconciled: false,
        warning: 'ساعة الجهاز تختلف عن الوقت الحقيقي',
      };
    }
  }

  public getClockWarning(): string | null {
    return this.clockWarning;
  }

  // --- Device ID ---
  public getDeviceId(): string {
    // Swappable interface: If running in Electron with machine ID API
    if (typeof window !== 'undefined') {
      const electronAPI = (window as unknown as { electronAPI?: { getMachineId?: () => string } }).electronAPI;
      if (electronAPI?.getMachineId) {
        return electronAPI.getMachineId();
      }
    }

    if (typeof localStorage === 'undefined') {
      return 'dev-default-node-device';
    }

    try {
      let deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
      if (!deviceId) {
        const randomPart = typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID().slice(0, 13)
          : Math.random().toString(36).substring(2, 12);
        deviceId = `dev-${randomPart}`;
        localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
      }
      return deviceId;
    } catch {
      return 'dev-fallback-device';
    }
  }

  // --- Request Code ---
  public getRequestCode(): string {
    const deviceId = this.getDeviceId();
    const env = detectEnvironment();
    const payload = {
      deviceId,
      appVersion: APP_VERSION,
      windowsVersion: env.windowsVersion,
      createdAt: new Date().toISOString(),
    };
    return stringToBase64Url(JSON.stringify(payload));
  }

  // --- Test Key Injection (Test Mode Only) ---
  private testPublicKeyJwk: JsonWebKey | null = null;

  public setPublicKeyForTesting(keyJwk: JsonWebKey | null): void {
    this.testPublicKeyJwk = keyJwk;
    this.cachedCryptoKey = null; // Clear cached key so next call re-imports
  }

  // --- Crypto Key Import ---
  private async getPublicKey(): Promise<CryptoKey> {
    if (this.cachedCryptoKey) {
      return this.cachedCryptoKey;
    }

    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error('WebCrypto subtle is not available in this environment');
    }

    const jwkToImport = this.testPublicKeyJwk || LICENSE_PUBLIC_KEY_JWK;

    this.cachedCryptoKey = await subtle.importKey(
      'jwk',
      jwkToImport,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    return this.cachedCryptoKey;
  }

  // --- Verify License Token Cryptographically ---
  public async verifyLicenseToken(token: string): Promise<{
    valid: boolean;
    payload?: LicensePayload;
    error?: string;
  }> {
    const cleanToken = token.trim();
    const parts = cleanToken.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'صيغة كود الترخيص غير صحيحة (يجب أن يحتوي على جزئين مفصولين بنقطة).' };
    }

    const [payloadB64, sigB64] = parts;
    let payload: LicensePayload;

    try {
      const jsonStr = base64UrlToString(payloadB64);
      payload = JSON.parse(jsonStr);
    } catch {
      return { valid: false, error: 'تعذر قراءة بيانات الترخيص. البيانات تالفة أو غير متوافقة.' };
    }

    // Verify required fields
    if (!payload.deviceId || !payload.validUntil || !payload.plan || !payload.mode) {
      return { valid: false, error: 'بيانات الترخيص ناقصة أو غير مكتملة.' };
    }

    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) {
        return { valid: false, error: 'نظام التشفير WebCrypto غير متاح في المتصفح.' };
      }

      const pubKey = await this.getPublicKey();
      const sigBytes = base64UrlToBytes(sigB64);

      if (sigBytes.length !== 64) {
        return { valid: false, error: 'توقيع الترخيص تالف (طول التوقيع غير متطابق مع معيار IEEE-P1363).' };
      }

      const dataBytes = new TextEncoder().encode(payloadB64);
      const isSignatureValid = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        sigBytes as BufferSource,
        dataBytes
      );

      if (!isSignatureValid) {
        return { valid: false, error: 'توقيع الترخيص غير صحيح أو تم التلاعب ببيانات الملف.' };
      }

      return { valid: true, payload };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `فشل التحقق المشفر من الترخيص: ${message}` };
    }
  }

  // --- Startup Initialization ---
  public async initLicense(): Promise<void> {
    this.isChecking = true;
    this.isTamperedOnBoot = false;

    // Permanently wipe app_license_payload and legacy tampered flags
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEYS.LICENSE_PAYLOAD);
        localStorage.removeItem('app_license_tampered_flag');
      } catch {}
    }

    const token = this.getStoredToken();
    if (!token) {
      this.verifiedPayload = null;
      this.isChecking = false;
      this.notifyListeners();
      return;
    }

    // Verify stored token signature cryptographically
    const verification = await this.verifyLicenseToken(token);
    if (!verification.valid || !verification.payload) {
      // Signature failure on boot = 'tampered'
      this.verifiedPayload = null;
      this.isTamperedOnBoot = true;
      this.isChecking = false;
      this.notifyListeners();
      return;
    }

    // Verified successfully: store in memory ONLY
    this.verifiedPayload = verification.payload;
    this.isChecking = false;
    this.recordHeartbeat();
    this.notifyListeners();
  }

  // --- Verify and Store License ---
  public async verifyAndStoreLicense(token: string): Promise<{
    success: boolean;
    payload?: LicensePayload;
    error?: string;
  }> {
    const verification = await this.verifyLicenseToken(token);
    if (!verification.valid || !verification.payload) {
      // STRICT: Return error only! Do NOT write any flag, do NOT replace the stored token.
      return { success: false, error: verification.error || 'فشل التحقق من الترخيص' };
    }

    const payload = verification.payload;
    const currentDeviceId = this.getDeviceId();

    if (payload.deviceId !== currentDeviceId) {
      // STRICT: Return error only! Do NOT overwrite stored token.
      return {
        success: false,
        error: `الترخيص مخصص لجهاز آخر (${payload.deviceId}) ولا يتطابق مع هذا الجهاز (${currentDeviceId}).`,
      };
    }

    // Verified and matches device: store token in localStorage and payload in memory ONLY
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.LICENSE_TOKEN, token.trim());
        localStorage.removeItem(STORAGE_KEYS.LICENSE_PAYLOAD);
        this.recordHeartbeat();
      } catch {
        return { success: false, error: 'تعذر حفظ الترخيص في الذاكرة المحلية للجهاز.' };
      }
    }

    this.verifiedPayload = payload;
    this.isTamperedOnBoot = false;
    this.isChecking = false;
    this.notifyListeners();
    return { success: true, payload };
  }

  // --- Get License State ---
  public getLicenseState(): LicenseStateResult {
    // 0. Before verification completes
    if (this.isChecking) {
      return {
        status: 'checking',
        daysRemaining: 0,
        payload: null,
        message: 'جاري التحقق من الترخيص المشفر...',
        canOperate: true,
      };
    }

    // 1. Check Clock Rollback First
    if (this.checkClockRollback()) {
      return {
        status: 'clock-rollback',
        daysRemaining: 0,
        payload: this.verifiedPayload,
        message: 'تم تعديل أو إرجاع وقت وتاريخ الجهاز إلى الوراء! يلزم ضبط الساعة للمتابعة.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 2. Check if Stored Token Failed Signature on Boot
    if (this.isTamperedOnBoot) {
      return {
        status: 'tampered',
        daysRemaining: 0,
        payload: null,
        message: 'تم التلاعب ببيانات ملف الترخيص أو التوقيع الرقمي غير صالح.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 3. Check Verified Payload in Memory
    const token = this.getStoredToken();
    const payload = this.verifiedPayload;

    if (!token || !payload) {
      return {
        status: 'unlicensed',
        daysRemaining: 0,
        payload: null,
        message: 'الجهاز غير مرخص حالياً. يرجى إدخال كود الترخيص لتفعيل النظام.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 4. Check Device Matching
    const currentDeviceId = this.getDeviceId();
    if (payload.deviceId !== currentDeviceId) {
      return {
        status: 'wrong-device',
        daysRemaining: 0,
        payload,
        message: 'هذا الترخيص مسجل لجهاز آخر ولا يطابق معرّف هذا الجهاز.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 5. Check Expiration & Grace Period
    const now = Date.now();
    const validUntilMs = new Date(payload.validUntil).getTime();
    const graceDays = payload.graceDays || 0;
    const graceUntilMs = validUntilMs + graceDays * 24 * 60 * 60 * 1000;

    let warningMsg = '';
    if (this.clockWarning) {
      warningMsg = ` (${this.clockWarning})`;
    }

    // Normal Valid License
    if (now <= validUntilMs) {
      const daysRemaining = Math.max(0, Math.ceil((validUntilMs - now) / (1000 * 60 * 60 * 24)));
      return {
        status: 'valid',
        daysRemaining,
        payload,
        message: `الترخيص سارٍ بنجاح (متبقي ${daysRemaining} يوم).${warningMsg}`,
        canOperate: true,
      };
    }

    // Grace Period
    if (now > validUntilMs && now <= graceUntilMs) {
      const graceDaysRemaining = Math.max(0, Math.ceil((graceUntilMs - now) / (1000 * 60 * 60 * 24)));
      return {
        status: 'grace',
        daysRemaining: graceDaysRemaining,
        payload,
        message: `انتهت صلاحية الترخيص، ويعمل النظام حالياً ضمن فترة السماح (متبقي ${graceDaysRemaining} يوم).${warningMsg}`,
        canOperate: true,
      };
    }

    // Fully Expired
    return {
      status: 'expired',
      daysRemaining: 0,
      payload,
      message: `انتهت صلاحية الترخيص وفترة السماح. يرجى تجديد الترخيص لمتابعة إصدار الفواتير.${warningMsg}`,
      canOperate: !LICENSE_ENFORCEMENT,
    };
  }

  public getStoredToken(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEYS.LICENSE_TOKEN);
  }

  // Returns verified in-memory payload only (never trusts localStorage)
  public getStoredPayload(): LicensePayload | null {
    return this.verifiedPayload;
  }

  // --- Can Create Sales Invoice Check ---
  public canCreateSalesInvoice(): boolean {
    if (!LICENSE_ENFORCEMENT) {
      return true;
    }
    const state = this.getLicenseState();
    return state.status === 'valid' || state.status === 'grace' || state.status === 'checking';
  }

  public enableTrialBypass(): boolean {
    if (LICENSE_ENFORCEMENT) {
      return false;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.TRIAL_BYPASS, 'true');
      } catch {}
    }
    this.notifyListeners();
    return true;
  }

  public clearTrialBypass(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEYS.TRIAL_BYPASS);
      } catch {}
    }
    this.notifyListeners();
  }

  public isStoreActivated(): boolean {
    const state = this.getLicenseState();
    if (state.status === 'valid' || state.status === 'grace') {
      return true;
    }
    if (!LICENSE_ENFORCEMENT && typeof localStorage !== 'undefined') {
      try {
        return localStorage.getItem(STORAGE_KEYS.TRIAL_BYPASS) === 'true';
      } catch {
        return false;
      }
    }
    return false;
  }

  public removeLicense(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEYS.LICENSE_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.LICENSE_PAYLOAD);
        localStorage.removeItem(STORAGE_KEYS.TRIAL_BYPASS);
        localStorage.removeItem('app_license_tampered_flag');
      } catch {}
    }
    this.verifiedPayload = null;
    this.isTamperedOnBoot = false;
    this.isChecking = false;
    this.clockWarning = null;
    this.notifyListeners();
  }

  // --- Reactive Subscriptions for UI ---
  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore subscriber error
      }
    }
  }
}

export const licenseService = new LicenseService();
export const initLicense = () => licenseService.initLicense();
export const isStoreActivated = () => licenseService.isStoreActivated();

export function getEffectiveLicenseFingerprint(state: LicenseStateResult): string {
  const payload = state.payload;
  const isOperational =
    (state.status === 'valid' || state.status === 'grace') &&
    Boolean(payload?.orgId && payload?.branchId);

  if (!isOperational || !payload) {
    return `inactive:${state.status}`;
  }

  return JSON.stringify({
    status: state.status,
    orgId: payload.orgId,
    branchId: payload.branchId,
    validUntil: payload.validUntil,
    features: payload.features ?? null,
  });
}
