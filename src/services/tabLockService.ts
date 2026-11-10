/**
 * TabLockService
 * Ensures ONLY ONE browser tab/window can run and write to the database at a time.
 * Uses the Web Locks API (navigator.locks.request with ifAvailable: true).
 * Falls back to BroadcastChannel with leader election if Web Locks are unsupported.
 */

export interface TabLockResult {
  acquired: boolean;
  reason?: string;
}

class TabLockService {
  private isHeld: boolean = false;
  private lockReleaseFn: (() => void) | null = null;
  private testOverride: boolean | null = null;
  private fallbackChannel: BroadcastChannel | null = null;

  /**
   * Set lock result for testing environments
   */
  public setLockForTesting(acquired: boolean | null): void {
    this.testOverride = acquired;
    if (acquired) {
      this.isHeld = true;
    } else if (acquired === false) {
      this.isHeld = false;
    }
  }

  public isLockAcquired(): boolean {
    return this.isHeld;
  }

  /**
   * Attempts to acquire the exclusive single-tab lock.
   * Returns { acquired: true } if this tab is the exclusive leader.
   * Returns { acquired: false } if another tab already holds the lock.
   */
  public async requestLock(): Promise<TabLockResult> {
    if (this.testOverride !== null) {
      this.isHeld = this.testOverride;
      return { acquired: this.testOverride };
    }

    // 1. Primary Mechanism: Web Locks API
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      try {
        return await new Promise<TabLockResult>((resolve) => {
          let resolved = false;

          navigator.locks.request('kashir-app-lock', { ifAvailable: true }, async (lock) => {
            if (!lock) {
              this.isHeld = false;
              if (!resolved) {
                resolved = true;
                resolve({ acquired: false, reason: 'held_by_another_tab' });
              }
              return;
            }

            // Lock successfully acquired
            this.isHeld = true;
            if (!resolved) {
              resolved = true;
              resolve({ acquired: true });
            }

            // Keep lock held for the entire lifetime of this tab
            return new Promise<void>((keepAlive) => {
              this.lockReleaseFn = keepAlive;

              const handleExit = () => {
                if (this.lockReleaseFn) {
                  this.lockReleaseFn();
                  this.lockReleaseFn = null;
                }
              };

              if (typeof window !== 'undefined') {
                window.addEventListener('beforeunload', handleExit, { once: true });
                window.addEventListener('pagehide', handleExit, { once: true });
              }
            });
          }).catch((err) => {
            console.warn('Web Locks API encountered error, falling back:', err);
            if (!resolved) {
              resolved = true;
              this.acquireBroadcastFallback().then(resolve);
            }
          });
        });
      } catch (err) {
        console.warn('Failed to invoke Web Locks API, falling back:', err);
        return this.acquireBroadcastFallback();
      }
    }

    // 2. Fallback Mechanism: BroadcastChannel
    return this.acquireBroadcastFallback();
  }

  private async acquireBroadcastFallback(): Promise<TabLockResult> {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
      // In non-browser or environments without BroadcastChannel, assume single instance
      this.isHeld = true;
      return { acquired: true };
    }

    try {
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

      await new Promise(r => setTimeout(r, 120));

      if (isLeaderPresent) {
        this.isHeld = false;
        return { acquired: false, reason: 'held_by_another_tab' };
      }

      // No leader responded, claim leadership
      this.isHeld = true;
      channel.postMessage({ type: 'LEADER_CLAIMED', tabId: myTabId });

      // Send periodic heartbeat to keep other tabs notified
      const heartbeatInterval = setInterval(() => {
        if (!this.isHeld) {
          clearInterval(heartbeatInterval);
          return;
        }
        channel.postMessage({ type: 'LEADER_HEARTBEAT', tabId: myTabId });
      }, 500);

      const handleExit = () => {
        this.isHeld = false;
        clearInterval(heartbeatInterval);
        channel.close();
      };

      window.addEventListener('beforeunload', handleExit, { once: true });
      window.addEventListener('pagehide', handleExit, { once: true });

      return { acquired: true };
    } catch (err) {
      console.warn('BroadcastChannel fallback failed:', err);
      this.isHeld = true;
      return { acquired: true };
    }
  }

  /**
   * Explicitly release lock (for testing or clean shutdown)
   */
  public releaseLock(): void {
    if (this.lockReleaseFn) {
      this.lockReleaseFn();
      this.lockReleaseFn = null;
    }
    if (this.fallbackChannel) {
      try {
        this.fallbackChannel.close();
      } catch {}
      this.fallbackChannel = null;
    }
    this.isHeld = false;
  }
}

export const tabLockService = new TabLockService();
