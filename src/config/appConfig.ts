/**
 * Global Application Configuration
 * Single source of truth for application version across the applet.
 */
export const APP_VERSION = '1.0.0';

export interface CloudBudgetLimits {
  writes: number;
  reads: number;
  deletes: number;
}

export const DEFAULT_CLOUD_BUDGET: CloudBudgetLimits = {
  writes: 1500,
  reads: 4000,
  deletes: 500,
};

