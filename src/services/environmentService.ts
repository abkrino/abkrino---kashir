export type WindowsVersion = '7' | '8' | '8.1' | '10+' | 'non-windows' | 'unknown';
export type RecommendedMode = 'offline-capable' | 'online-required';

export interface EnvironmentInfo {
  isElectron: boolean;
  windowsVersion: WindowsVersion;
  recommendedMode: RecommendedMode;
}

/**
 * Pure function to parse environment information based on userAgent string and electron flag.
 */
export function parseEnvironment(userAgent: string, hasElectron: boolean): EnvironmentInfo {
  const ua = userAgent || '';

  // Determine Windows version
  let windowsVersion: WindowsVersion = 'unknown';

  if (/Windows NT 10\.0/i.test(ua)) {
    // Windows NT 10.0 = '10+' (covers both Windows 10 and 11)
    windowsVersion = '10+';
  } else if (/Windows NT 6\.3/i.test(ua)) {
    windowsVersion = '8.1';
  } else if (/Windows NT 6\.2/i.test(ua)) {
    windowsVersion = '8';
  } else if (/Windows NT 6\.1/i.test(ua)) {
    windowsVersion = '7';
  } else if (/Windows/i.test(ua)) {
    windowsVersion = 'unknown';
  } else {
    windowsVersion = 'non-windows';
  }

  // Determine Recommended Mode:
  // - '7' and '8' and '8.1' = online-required
  // - '10+' inside Electron = offline-capable
  // - Any other environment (browser, non-windows, unknown) = online-required
  let recommendedMode: RecommendedMode = 'online-required';
  if (windowsVersion === '10+' && hasElectron) {
    recommendedMode = 'offline-capable';
  } else {
    recommendedMode = 'online-required';
  }

  return {
    isElectron: Boolean(hasElectron),
    windowsVersion,
    recommendedMode,
  };
}

/**
 * Detect runtime environment from navigator and window globals.
 * In development mode (import.meta.env.DEV), allows overriding via ?forceEnv= URL parameter.
 */
export function detectEnvironment(): EnvironmentInfo {
  // Check for test override in development mode only
  if (Boolean(import.meta.env?.DEV) && typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search);
      const forceEnv = params.get('forceEnv')?.toLowerCase();

      if (forceEnv === 'win7') {
        return parseEnvironment('Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36', false);
      }
      if (forceEnv === 'win8') {
        return parseEnvironment('Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/537.36', false);
      }
      if (forceEnv === 'win8.1') {
        return parseEnvironment('Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36', false);
      }
      if (forceEnv === 'win10') {
        return parseEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', false);
      }
      if (forceEnv === 'electron') {
        return parseEnvironment('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Electron/30.0.0', true);
      }
    } catch {
      // Fall through to standard detection
    }
  }

  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const hasElectron = typeof window !== 'undefined' && (
    Boolean((window as unknown as { electronAPI?: unknown }).electronAPI) ||
    /electron/i.test(userAgent)
  );

  return parseEnvironment(userAgent, hasElectron);
}
