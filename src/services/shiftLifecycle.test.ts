import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from './storageService';
import { licenseService, setLicenseEnforcement } from './licenseService';

describe('Shift lifecycle', () => {
  beforeEach(async () => {
    setLicenseEnforcement(false);
    licenseService.clearTrialBypass();
    await storage.init();
    const current = storage.getCurrentShift();
    if (current.status === 'OPEN') {
      storage.saveCurrentShift({ ...current, status: 'CLOSED', closedAt: 'test' });
      await storage.flush();
    }
  });

  it('allows opening a new shift after the previous shift was closed', async () => {
    const previous = storage.getCurrentShift();
    const next = {
      id: 'test-shift-' + Date.now(),
      date: new Date().toISOString().slice(0, 10),
      openedAt: '09:00',
      openedBy: 'Test Admin',
      openingCash: storage.calculateCurrentCashInDrawer(),
      expectedClosingCash: storage.calculateCurrentCashInDrawer(),
      status: 'OPEN' as const,
    };
    expect(previous.status).toBe('CLOSED');
    expect(storage.saveCurrentShift(next).success).toBe(true);
    await storage.flush();
    expect(storage.getCurrentShift().id).toBe(next.id);
    expect(storage.getCurrentShift().status).toBe('OPEN');
  });
});
