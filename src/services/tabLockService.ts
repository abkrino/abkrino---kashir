/**
 * TabLockService
 * Ensures ONLY ONE browser tab/window can run and write to the database at a time.
 * Uses the Web Locks API (navigator.locks.request with ifAvailable: true).
 * Falls back to BroadcastChannel with leader election if Web Locks are unsupported.
 *
 * Resilience features:
 * - Idempotent: returns existing promise if a request is in flight, or returns { acquired: true } if held.
 * - Retry with backoff: retries every 400ms for up to 4000ms before declaring failure.
 * - AbortController: cancels pending retries on page unload or explicit abort.
 * - releaseLock() is strictly for tests/cleanup, NOT called in React useEffect cleanup.
 */

export interface TabLockResult {
  acquired: boolean;
  reason?: string;
}

export interface TabLockOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
  signal?: AbortSignal;
}

class TabLockService {
  private isHeld: boolean = false;
  private pendingRequestPromise: Promise<TabLockResult> | null = null;
  private lockReleaseFn: (() => void) | null = null;
  private testOverride: boolean | null = null;
  private fallbackChannel: BroadcastChannel | null = null;
  private fallbackHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController = new AbortController();

  constructor() {
    if (typeof window !== 'undefined') {
      const handleExit = () => {
        this.abortController.abort();
        if (this.fallbackChannel) {
          try { this.fallbackChannel.close(); } catch {}
          this.fallbackChannel = null;
        }
      };

      window.addEventListener('pagehide', handleExit, { once: true });
    }
  }

  /**
   * Set lock result for testing environments
   */
  public setLockForTesting(acquired: boolean | null): void {
    this.testOverride = acquired;
    if (acquired === true) {
      this.isHeld = true;
    } else if (acquired === false) {
      this.isHeld = false;
    }
  }

  public isLockAcquired(): boolean {
    return this.isHeld;
  }

  /**
   * Attempts to acquire the exclusive single-tab lock with automatic retries.
   * Idempotent:
   * - If this tab already holds the lock, returns { acquired: true } immediately.
   * - If a request is already in progress, returns that same pending promise.
   */
  public requestLock(options?: TabLockOptions): Promise<TabLockResult> {
    // 1. Idempotent check: already held in this window
    if (this.isHeld) {
      return Promise.resolve({ acquired: true });
    }

    // 2. Idempotent check: request already in progress
    if (this.pendingRequestPromise) {
      return this.pendingRequestPromise;
    }

    // Reset abort controller if previously aborted
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    this.pendingRequestPromise = this.executeRequestWithRetries(options)
      .finally(() => {
        this.pendingRequestPromise = null;
      });

    return this.pendingRequestPromise;
  }

  /**
   * Internal retry loop: retries every 400ms for up to timeoutMs (default 4000ms)
   */
  private async executeRequestWithRetries(options?: TabLockOptions): Promise<TabLockResult> {
    const timeoutMs = options?.timeoutMs ?? 4000;
    const retryIntervalMs = options?.retryIntervalMs ?? 400;
    const startTime = Date.now();

    while (true) {
      if (this.abortController.signal.aborted || options?.signal?.aborted) {
        return { acquired: false, reason: 'aborted' };
      }

      // If test override is explicitly set
      if (this.testOverride !== null) {
        this.isHeld = this.testOverride;
        if (this.testOverride) {
          return { acquired: true };
        }
      } else {
        const acquired = await this.tryAcquireOnce();
        if (acquired) {
          this.isHeld = true;
          return { acquired: true };
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        break;
      }

      const waitTime = Math.min(retryIntervalMs, timeoutMs - elapsed);
      await this.sleepWithAbort(waitTime, options?.signal);
    }

    this.isHeld = false;
    return { acquired: false, reason: 'held_by_another_tab' };
  }

  /**
   * Single attempt to acquire lock (Web Locks API or BroadcastChannel)
   */
  public async tryAcquireOnce(): Promise<boolean> {
    if (this.testOverride !== null) {
      return this.testOverride;
    }

    // 1. Primary Mechanism: Web Locks API
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      try {
        return await new Promise<boolean>((resolve) => {
          let resolved = false;

          navigator.locks.request('kashir-app-lock', { ifAvailable: true }, async (lock) => {
            if (!lock) {
              if (!resolved) {
                resolved = true;
                resolve(false);
              }
              return;
            }

            this.isHeld = true;
            if (!resolved) {
              resolved = true;
              resolve(true);
            }

            // Keep lock held for the entire lifetime of this tab
            return new Promise<void>((keepAlive) => {
              this.lockReleaseFn = keepAlive;
            });
          }).catch((err) => {
            console.warn('Web Locks API single attempt error:', err);
            if (!resolved) {
              resolved = true;
              resolve(false);
            }
          });
        });
      } catch (err) {
        console.warn('Failed to invoke Web Locks API:', err);
        return false;
      }
    }

    // 2. Fallback Mechanism: BroadcastChannel
    return this.tryAcquireBroadcastOnce();
  }

  private async tryAcquireBroadcastOnce(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
      this.isHeld = true;
      return true;
    }

    try {
      if (this.isHeld) return true;

      const myTabId = 'tab_' + Math.random().toString(36).slice(2, 10);
      const channel = new BroadcastChannel('kashir-tab-lock-channel');
      this.fallbackChannel = channel;

      let isLeaderPresent = false;

      const handleMessage = (evt: MessageEvent) => {
        if (!evt.data) return;
        if (evt.data.type === 'LEADER_HEARTBEAT' || evt.data.type === 'LEADER_PONG') {
          isLeaderPresent = true;
        } else if (evt.data.type === 'WHO_IS_LEADER' && this.isHeld) {
          channel.postMessage({ type: 'LEADER_PONG', tabId: myTabId });
        }
      };

      channel.addEventListener('message', handleMessage);

      // Probe existing leader
      channel.postMessage({ type: 'WHO_IS_LEADER', tabId: myTabId });
      await new Promise(r => setTimeout(r, 60));

      if (isLeaderPresent) {
        channel.removeEventListener('message', handleMessage);
        channel.close();
        this.fallbackChannel = null;
        return false;
      }

      this.isHeld = true;
      channel.postMessage({ type: 'LEADER_CLAIMED', tabId: myTabId });

      if (this.fallbackHeartbeatTimer) clearInterval(this.fallbackHeartbeatTimer);
      this.fallbackHeartbeatTimer = setInterval(() => {
        if (!this.isHeld) {
          if (this.fallbackHeartbeatTimer) clearInterval(this.fallbackHeartbeatTimer);
          return;
        }
        channel.postMessage({ type: 'LEADER_HEARTBEAT', tabId: myTabId });
      }, 500);

      return true;
    } catch {
      this.isHeld = true;
      return true;
    }
  }

  private sleepWithAbort(ms: number, externalSignal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      externalSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Abort any active retry operations
   */
  public abortPending(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Explicitly release lock (strictly for tests/cleanup)
   */
  public releaseLock(): void {
    this.abortController.abort();
    this.abortController = new AbortController();

    if (this.lockReleaseFn) {
      this.lockReleaseFn();
      this.lockReleaseFn = null;
    }

    if (this.fallbackHeartbeatTimer) {
      clearInterval(this.fallbackHeartbeatTimer);
      this.fallbackHeartbeatTimer = null;
    }

    if (this.fallbackChannel) {
      try {
        this.fallbackChannel.close();
      } catch {}
      this.fallbackChannel = null;
    }

    this.isHeld = false;
    this.pendingRequestPromise = null;
    this.testOverride = null;
  }
}

export const tabLockService = new TabLockService();
