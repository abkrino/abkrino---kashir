import { LICENSE_PUBLIC_KEY_JWK } from '../config/licensePublicKey';
import { detectEnvironment } from './environmentService';
import { APP_VERSION, CloudBudgetLimits } from '../config/appConfig';

export type SubscriptionPhase = 'ACTIVE' | 'EXPIRING' | 'GRACE' | 'EXPIRED';

export type WriteOperationCategory =
  | 'SALES'
  | 'RETURNS'
  | 'PURCHASES'
  | 'COLLECTIONS'
  | 'SUPPLIER_PAYMENTS'
  | 'SHIFT'
  | 'CASH_OPS'
  | 'ADMIN_DATA';

export interface WriteGateContext {
  targetShift?: { id?: string; status?: 'OPEN' | 'CLOSED' } | null;
  isShiftClose?: boolean; // Untrusted hint — NEVER sufficient on its own; real shift state is always verified
}

export type LicenseFeatureKey =
  | 'cloudSummary'
  | 'cloudBackup'
  | 'journal'
  | 'multiBranch';

export interface LicenseFeatures {
  cloudSummary?: boolean;
  cloudBackup?: boolean;
  journal?: boolean;
  multiBranch?: boolean;
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
  subscriptionPhase?: SubscriptionPhase;
  daysRemaining: number;
  daysToExpiry?: number;
  graceDaysLeft?: number;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_THRESHOLD_DAYS = 7;
const DEFAULT_GRACE_DAYS = 7;

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

function getResolvedGraceDays(payload: LicensePayload | null | undefined): number {
  const raw = payload?.graceDays;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_GRACE_DAYS;
}

class LicenseService {
  private cachedCryptoKey: CryptoKey | null = null;
  private verifiedPayload: LicensePayload | null = null;
  private isChecking: boolean = false;
  private isTamperedOnBoot: boolean = false;
  private clockWarning: string | null = null;
  private listeners: (() => void)[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private simulatedDateMs: number | null = null;
  private shiftStateReader: (() => { id?: string; status?: 'OPEN' | 'CLOSED' } | null) | null = null;

  public registerShiftStateReader(
    reader: () => { id?: string; status?: 'OPEN' | 'CLOSED' } | null
  ): void {
    this.shiftStateReader = reader;
  }

  constructor() {
    this.initClockProtection();
    // In browser environment, initiate cryptographic verification on startup
    if (typeof window !== 'undefined') {
      this.initLicense().catch(() => {});
    }
  }

  private isSimulationAllowed(): boolean {
    const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } })?.env?.DEV);
    const isTest = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
    return isDev || isTest;
  }

  public simulateLicenseDate(date: Date | string | number | null): void {
    if (!this.isSimulationAllowed()) {
      return;
    }
    if (date === null) {
      this.simulatedDateMs = null;
      this.notifyListeners();
      return;
    }
    const ms =
      date instanceof Date
        ? date.getTime()
        : typeof date === 'number'
        ? date
        : new Date(date).getTime();
    if (!Number.isFinite(ms)) {
      return;
    }
    this.simulatedDateMs = ms;
    this.notifyListeners();
  }

  public getSimulatedDateMs(): number | null {
    if (!this.isSimulationAllowed()) {
      return null;
    }
    return this.simulatedDateMs;
  }

  public getEffectiveNowMs(): number {
    if (this.simulatedDateMs !== null && this.isSimulationAllowed()) {
      return this.simulatedDateMs;
    }
    return Date.now();
  }

  // --- Clock Rollback Protection ---
  private initClockProtection() {
    this.recordHeartbeat();
    if (typeof window !== 'undefined') {
      this.heartbeatInterval = setInterval(() => {
        this.recordHeartbeat();
      }, 60 * 1000); // Check and record every minute using real system clock
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
      throw new Error('خدمة التشفير الرقمي غير متاحة في هذا المتصفح');
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
        return { valid: false, error: 'نظام التشفير غير متاح في المتصفح.' };
      }

      const pubKey = await this.getPublicKey();
      const sigBytes = base64UrlToBytes(sigB64);

      if (sigBytes.length !== 64) {
        return { valid: false, error: 'توقيع الترخيص تالف أو غير متوافق.' };
      }

      const dataBytes = new TextEncoder().encode(payloadB64);
      const isSignatureValid = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        sigBytes as BufferSource,
        dataBytes
      );

      if (!isSignatureValid) {
        return { valid: false, error: 'توقيع الترخيص غير صحيح أو تم التلاعب بالبيانات.' };
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

  // --- Verify and Store License (with Anti-Downgrade check) ---
  public async verifyAndStoreLicense(token: string): Promise<{
    success: boolean;
    payload?: LicensePayload;
    error?: string;
  }> {
    const verification = await this.verifyLicenseToken(token);
    if (!verification.valid || !verification.payload) {
      // STRICT: Return error only! Do NOT write any flag, do NOT replace the stored token.
      return { success: false, error: verification.error || 'فشل التحقق من كود الترخيص.' };
    }

    const payload = verification.payload;
    const currentDeviceId = this.getDeviceId();

    if (payload.deviceId !== currentDeviceId) {
      // STRICT: Return error only! Do NOT overwrite stored token.
      return {
        success: false,
        error: `كود الترخيص مخصص لجهاز آخر ولا يتطابق مع معرّف هذا الجهاز.`,
      };
    }

    const newValidUntilMs = new Date(payload.validUntil).getTime();
    if (!Number.isFinite(newValidUntilMs)) {
      return {
        success: false,
        error: 'تاريخ صلاحية كود الترخيص غير صالح.',
      };
    }

    // Anti-Downgrade: refuse older validUntil than the currently installed device-matched token
    if (this.verifiedPayload && this.verifiedPayload.deviceId === currentDeviceId) {
      const currentValidUntilMs = new Date(this.verifiedPayload.validUntil).getTime();
      if (Number.isFinite(currentValidUntilMs) && newValidUntilMs < currentValidUntilMs) {
        return {
          success: false,
          error: 'لا يمكن تثبيت كود ترخيص بتاريخ انتهاء أقدم من الاشتراك الحالي.',
        };
      }
    }

    // Verified and matches device: store token in localStorage and payload in memory ONLY
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.LICENSE_TOKEN, token.trim());
        localStorage.removeItem(STORAGE_KEYS.LICENSE_PAYLOAD);
        localStorage.removeItem(STORAGE_KEYS.TRIAL_BYPASS);
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

  /**
   * Online Branch Doc Auto-Renewal:
   * Verifies signature, matches deviceId, and installs ONLY if strictly newer (`validUntil` > current).
   * Ignores any non-signed fields on the Firestore document completely.
   */
  public async tryAutoInstallBranchToken(token: string): Promise<{
    updated: boolean;
    reason?: 'invalid' | 'wrong-device' | 'not-newer' | 'error';
    payload?: LicensePayload;
  }> {
    if (!token || typeof token !== 'string' || !token.trim()) {
      return { updated: false, reason: 'invalid' };
    }

    const verification = await this.verifyLicenseToken(token);
    if (!verification.valid || !verification.payload) {
      return { updated: false, reason: 'invalid' };
    }

    const payload = verification.payload;
    const currentDeviceId = this.getDeviceId();
    if (payload.deviceId !== currentDeviceId) {
      return { updated: false, reason: 'wrong-device' };
    }

    const newValidUntilMs = new Date(payload.validUntil).getTime();
    if (!Number.isFinite(newValidUntilMs)) {
      return { updated: false, reason: 'invalid' };
    }

    if (this.verifiedPayload && this.verifiedPayload.deviceId === currentDeviceId) {
      const currentValidUntilMs = new Date(this.verifiedPayload.validUntil).getTime();
      if (Number.isFinite(currentValidUntilMs) && newValidUntilMs <= currentValidUntilMs) {
        return { updated: false, reason: 'not-newer' };
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.LICENSE_TOKEN, token.trim());
        localStorage.removeItem(STORAGE_KEYS.LICENSE_PAYLOAD);
        localStorage.removeItem(STORAGE_KEYS.TRIAL_BYPASS);
        this.recordHeartbeat();
      } catch {
        return { updated: false, reason: 'error' };
      }
    }

    this.verifiedPayload = payload;
    this.isTamperedOnBoot = false;
    this.isChecking = false;
    this.notifyListeners();
    return { updated: true, payload };
  }

  // --- Feature Flag Helpers (legacy licenses without features default to true) ---
  public isFeatureEnabled(feature: LicenseFeatureKey): boolean {
    const state = this.getLicenseState();
    const features = state.payload?.features;
    if (!features || typeof features !== 'object') {
      return true;
    }
    const val = features[feature];
    return val !== false;
  }

  // --- Get License State (with derived subscriptionPhase, daysToExpiry, graceDaysLeft) ---
  public getLicenseState(): LicenseStateResult {
    // 0. Before verification completes
    if (this.isChecking) {
      return {
        status: 'checking',
        subscriptionPhase: 'ACTIVE',
        daysRemaining: 0,
        daysToExpiry: 0,
        graceDaysLeft: 0,
        payload: null,
        message: 'جاري التحقق من ترخيص النظام...',
        canOperate: true,
      };
    }

    // 1. Check Clock Rollback First (uses real system clock)
    if (this.checkClockRollback()) {
      return {
        status: 'clock-rollback',
        subscriptionPhase: 'EXPIRED',
        daysRemaining: 0,
        daysToExpiry: 0,
        graceDaysLeft: 0,
        payload: this.verifiedPayload,
        message: 'تم تعديل أو إرجاع وقت وتاريخ الجهاز إلى الوراء! يلزم ضبط الساعة للمتابعة.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 2. Check if Stored Token Failed Signature on Boot
    if (this.isTamperedOnBoot) {
      return {
        status: 'tampered',
        subscriptionPhase: 'EXPIRED',
        daysRemaining: 0,
        daysToExpiry: 0,
        graceDaysLeft: 0,
        payload: null,
        message: 'تم التلاعب ببيانات الترخيص أو التوقيع الرقمي غير صالح.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 3. Check Verified Payload in Memory
    const token = this.getStoredToken();
    const payload = this.verifiedPayload;

    if (!token || !payload) {
      return {
        status: 'unlicensed',
        subscriptionPhase: 'EXPIRED',
        daysRemaining: 0,
        daysToExpiry: 0,
        graceDaysLeft: 0,
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
        subscriptionPhase: 'EXPIRED',
        daysRemaining: 0,
        daysToExpiry: 0,
        graceDaysLeft: 0,
        payload,
        message: 'هذا الترخيص مسجل لجهاز آخر ولا يطابق معرّف هذا الجهاز.',
        canOperate: !LICENSE_ENFORCEMENT,
      };
    }

    // 5. Check Expiration, Expiring Window & Grace Period
    const now = this.getEffectiveNowMs();
    const validUntilMs = new Date(payload.validUntil).getTime();
    const graceDays = getResolvedGraceDays(payload);
    const graceUntilMs = validUntilMs + graceDays * DAY_MS;

    let warningMsg = '';
    if (this.clockWarning) {
      warningMsg = ` (${this.clockWarning})`;
    }

    // Active or Expiring (before or on validUntil)
    if (now <= validUntilMs) {
      const daysToExpiry = Math.max(0, Math.ceil((validUntilMs - now) / DAY_MS));
      const subscriptionPhase: SubscriptionPhase =
        daysToExpiry <= EXPIRING_THRESHOLD_DAYS ? 'EXPIRING' : 'ACTIVE';
      return {
        status: 'valid',
        subscriptionPhase,
        daysRemaining: daysToExpiry,
        daysToExpiry,
        graceDaysLeft: graceDays,
        payload,
        message:
          subscriptionPhase === 'EXPIRING'
            ? `اشتراكك ينتهي خلال ${daysToExpiry} يوم.${warningMsg}`
            : `الترخيص سارٍ بنجاح (متبقي ${daysToExpiry} يوم).${warningMsg}`,
        canOperate: true,
      };
    }

    // Grace Period (after expiry up to validUntil + graceDays)
    if (now > validUntilMs && now <= graceUntilMs) {
      const graceDaysLeft = Math.max(0, Math.ceil((graceUntilMs - now) / DAY_MS));
      return {
        status: 'grace',
        subscriptionPhase: 'GRACE',
        daysRemaining: graceDaysLeft,
        daysToExpiry: 0,
        graceDaysLeft,
        payload,
        message: `أنت الآن في فترة السماح، متبقي ${graceDaysLeft} يوم.${warningMsg}`,
        canOperate: true,
      };
    }

    // Fully Expired
    return {
      status: 'expired',
      subscriptionPhase: 'EXPIRED',
      daysRemaining: 0,
      daysToExpiry: 0,
      graceDaysLeft: 0,
      payload,
      message: `انتهت صلاحية الاشتراك وفترة السماح. يرجى إدخال كود التجديد لمتابعة العمل.${warningMsg}`,
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

  // --- Centralized Service-Layer Write Matrix Enforcement ---
  public canPerformWrite(
    category: WriteOperationCategory,
    context?: WriteGateContext
  ): {
    allowed: boolean;
    phase: SubscriptionPhase;
    reason?: string;
  } {
    const state = this.getLicenseState();
    const phase: SubscriptionPhase = state.subscriptionPhase ?? 'EXPIRED';

    if (state.status === 'checking') {
      return { allowed: true, phase };
    }

    if (!LICENSE_ENFORCEMENT && state.status === 'unlicensed') {
      return { allowed: true, phase: 'ACTIVE' };
    }

    if (
      state.status === 'unlicensed' ||
      state.status === 'tampered' ||
      state.status === 'wrong-device' ||
      state.status === 'clock-rollback'
    ) {
      if (!LICENSE_ENFORCEMENT) {
        return { allowed: true, phase };
      }
      return {
        allowed: false,
        phase,
        reason: state.message,
      };
    }

    if (phase === 'ACTIVE' || phase === 'EXPIRING') {
      return { allowed: true, phase };
    }

    if (phase === 'GRACE') {
      if (category === 'ADMIN_DATA') {
        return {
          allowed: false,
          phase,
          reason:
            'النظام في فترة السماح: يُسمح بعمليات البيع والمرتجعات والمشتريات والتحصيل وسداد الموردين والوردية وحركات الخزينة فقط، ولا يُسمح بالتعديلات الإدارية قبل تجديد الاشتراك.',
        };
      }
      return { allowed: true, phase };
    }

    // EXPIRED: everything blocked EXCEPT closing an actually-open shift.
    // Never honor a caller-supplied isShiftClose flag on its own; always verify real shift state.
    if (category === 'SHIFT') {
      const storedShift = this.shiftStateReader ? this.shiftStateReader() : null;
      const isStoredShiftActuallyOpen = Boolean(storedShift && storedShift.status === 'OPEN');
      const storedShiftId =
        typeof storedShift?.id === 'string' && storedShift.id.trim().length > 0
          ? storedShift.id
          : null;
      const targetShift = context?.targetShift;
      const targetShiftId =
        typeof targetShift?.id === 'string' && targetShift.id.trim().length > 0
          ? targetShift.id
          : null;
      const isValidCloseTarget = Boolean(
        isStoredShiftActuallyOpen &&
          storedShiftId !== null &&
          targetShift &&
          targetShift.status === 'CLOSED' &&
          targetShiftId !== null &&
          storedShiftId === targetShiftId
      );

      if (isValidCloseTarget) {
        return { allowed: true, phase: 'EXPIRED' };
      }

      if (targetShift?.status === 'OPEN') {
        return {
          allowed: false,
          phase: 'EXPIRED',
          reason:
            'انتهت صلاحية الاشتراك وفترة السماح. لا يمكن فتح وردية جديدة أو تعديل وردية مفتوحة؛ يُسمح فقط بإغلاق الوردية المفتوحة حالياً.',
        };
      }

      if (!isStoredShiftActuallyOpen) {
        return {
          allowed: false,
          phase: 'EXPIRED',
          reason:
            'انتهت صلاحية الاشتراك وفترة السماح. لا توجد وردية مفتوحة حالياً لإغلاقها، ولا يمكن فتح وردية جديدة إلا بعد إدخال كود التجديد.',
        };
      }

      if (
        targetShift?.status === 'CLOSED' &&
        (storedShiftId === null || targetShiftId === null || storedShiftId !== targetShiftId)
      ) {
        return {
          allowed: false,
          phase: 'EXPIRED',
          reason:
            'انتهت صلاحية الاشتراك وفترة السماح. لا يمكن إغلاق الوردية بدون معرّف صحيح ومطابق للوردية المفتوحة حالياً.',
        };
      }

      return {
        allowed: false,
        phase: 'EXPIRED',
        reason:
          'انتهت صلاحية الاشتراك وفترة السماح. يُسمح فقط بإغلاق الوردية المفتوحة حالياً، ولا يمكن حفظ هذه العملية إلا بعد إدخال كود التجديد.',
      };
    }

    // EXPIRED: all other write categories blocked
    return {
      allowed: false,
      phase: 'EXPIRED',
      reason:
        'انتهت صلاحية الاشتراك وفترة السماح. النظام في وضع القراءة والتصدير فقط ولا يمكن حفظ أي عمليات جديدة إلا بعد إدخال كود التجديد.',
    };
  }

  // --- Can Create Sales Invoice Check ---
  public canCreateSalesInvoice(): boolean {
    return this.canPerformWrite('SALES').allowed;
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
    // Expired, tampered, wrong-device, or clock-rollback with an installed token cannot bypass via old trial flag
    if (
      !LICENSE_ENFORCEMENT &&
      state.status === 'unlicensed' &&
      typeof localStorage !== 'undefined'
    ) {
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
    this.simulatedDateMs = null;
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
