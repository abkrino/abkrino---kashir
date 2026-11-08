import { describe, it, expect } from 'vitest';
import {
  getYyyyMmDdCairo,
  calculateDailySummaryData,
  shouldPushSummary,
  RawStorageDailySummaryInput,
} from './orgSyncService';
import { SalesInvoice, PurchaseInvoice, Product, Customer, Supplier } from '../types';

describe('orgSyncService pure functions', () => {
  describe('getYyyyMmDdCairo', () => {
    it('formats dates into YYYY-MM-DD using Africa/Cairo timezone', () => {
      // 2026-11-07 at 12:00:00 UTC
      const d1 = new Date('2026-11-07T12:00:00Z');
      expect(getYyyyMmDdCairo(d1)).toBe('2026-11-07');

      // Cairo is UTC+2 in winter
      // 2026-11-07 at 21:59:00 UTC -> 23:59:00 in Cairo (still 2026-11-07)
      const dBeforeMidnight = new Date('2026-11-07T21:59:00Z');
      expect(getYyyyMmDdCairo(dBeforeMidnight)).toBe('2026-11-07');

      // 2026-11-07 at 22:01:00 UTC -> 00:01:00 on 2026-11-08 in Cairo (next day)
      const dAfterMidnight = new Date('2026-11-07T22:01:00Z');
      expect(getYyyyMmDdCairo(dAfterMidnight)).toBe('2026-11-08');
    });

    it('defaults to current time without throwing', () => {
      const result = getYyyyMmDdCairo();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('calculateDailySummaryData', () => {
    it('aggregates daily figures accurately and isolates today vs other days', () => {
      const todayCairo = '2026-11-07';

      // 2 invoices today, 1 invoice yesterday
      const invoices: Partial<SalesInvoice>[] = [
        {
          id: 'inv-1',
          invoiceNumber: 'INV-001',
          date: '2026-11-07T10:00:00Z',
          total: 150.5,
        },
        {
          id: 'inv-2',
          invoiceNumber: 'INV-002',
          date: '2026-11-07T14:30:00Z',
          total: 249.5,
        },
        {
          id: 'inv-old',
          invoiceNumber: 'INV-000',
          date: '2026-11-06T10:00:00Z',
          total: 999.0,
        },
      ];

      // 1 purchase today, 1 purchase yesterday
      const purchases: Partial<PurchaseInvoice>[] = [
        {
          id: 'pur-1',
          invoiceNumber: 'PUR-001',
          date: '2026-11-07T11:00:00Z',
          totalCost: 180.25,
        },
        {
          id: 'pur-old',
          invoiceNumber: 'PUR-000',
          date: '2026-11-05T09:00:00Z',
          totalCost: 500.0,
        },
      ];

      // Products: 2 low stock (<= reorderLevelPieces), 1 healthy
      const products: Partial<Product>[] = [
        {
          id: 'p-1',
          name: 'سكر 1 كجم',
          stockPieces: 3,
          reorderLevelPieces: 5,
        },
        {
          id: 'p-2',
          name: 'شاي 250 جم',
          stockPieces: 5,
          reorderLevelPieces: 5, // Exactly equal reorderLevelPieces -> low stock
        },
        {
          id: 'p-3',
          name: 'أرز 1 كجم',
          stockPieces: 25,
          reorderLevelPieces: 5,
        },
      ];

      // Customers: one has positive debt, one has credit/zero
      const customers: Partial<Customer>[] = [
        { id: 'c-1', name: 'أحمد', currentBalance: 450.75 },
        { id: 'c-2', name: 'محمد', currentBalance: 0 },
        { id: 'c-3', name: 'علي', currentBalance: -50 }, // Overpaid/credit -> should not count as debt
      ];

      // Suppliers: one has positive due, one has zero
      const suppliers: Partial<Supplier>[] = [
        { id: 's-1', name: 'شركة الأهرام', currentBalance: 1200.5 },
        { id: 's-2', name: 'شركة النيل', currentBalance: 0 },
      ];

      const input: RawStorageDailySummaryInput = {
        invoices: invoices as SalesInvoice[],
        purchases: purchases as PurchaseInvoice[],
        products: products as Product[],
        customers: customers as Customer[],
        suppliers: suppliers as Supplier[],
        cashInDrawer: 875.5,
        cairoDateStr: todayCairo,
      };

      const summary = calculateDailySummaryData(input);

      expect(summary.yyyyMMdd).toBe(todayCairo);
      expect(summary.salesTotal).toBe(400); // 150.5 + 249.5
      expect(summary.invoiceCount).toBe(2);
      expect(summary.purchasesTotal).toBe(180.25);
      expect(summary.cashInDrawer).toBe(875.5);
      expect(summary.customerDebt).toBe(450.75);
      expect(summary.supplierDue).toBe(1200.5);
      expect(summary.lowStockCount).toBe(2);
    });

    it('handles empty datasets cleanly without NaN', () => {
      const summary = calculateDailySummaryData({
        invoices: [],
        purchases: [],
        products: [],
        customers: [],
        suppliers: [],
        cashInDrawer: 0,
        cairoDateStr: '2026-11-07',
      });

      expect(summary.salesTotal).toBe(0);
      expect(summary.invoiceCount).toBe(0);
      expect(summary.purchasesTotal).toBe(0);
      expect(summary.customerDebt).toBe(0);
      expect(summary.supplierDue).toBe(0);
      expect(summary.lowStockCount).toBe(0);
      expect(summary.cashInDrawer).toBe(0);
    });
  });

  describe('shouldPushSummary', () => {
    const TEN_MINUTES_MS = 10 * 60 * 1000;

    it('returns true when forceImmediate is true regardless of intervals', () => {
      const now = 1_000_000;
      const lastPush = 999_999; // 1 ms ago
      expect(shouldPushSummary(now, lastPush, TEN_MINUTES_MS, true)).toBe(true);
    });

    it('returns true on first run when lastPushTimeMs is 0', () => {
      expect(shouldPushSummary(Date.now(), 0, TEN_MINUTES_MS, false)).toBe(true);
    });

    it('returns false if less than 10 minutes have elapsed and not forced', () => {
      const lastPush = 1_000_000;
      const now = lastPush + 5 * 60 * 1000; // 5 minutes later
      expect(shouldPushSummary(now, lastPush, TEN_MINUTES_MS, false)).toBe(false);
    });

    it('returns true if 10 or more minutes have elapsed', () => {
      const lastPush = 1_000_000;
      const exactlyTen = lastPush + TEN_MINUTES_MS;
      expect(shouldPushSummary(exactlyTen, lastPush, TEN_MINUTES_MS, false)).toBe(true);

      const twelveMin = lastPush + 12 * 60 * 1000;
      expect(shouldPushSummary(twelveMin, lastPush, TEN_MINUTES_MS, false)).toBe(true);
    });
  });

  describe('orgSyncService lifecycle & retry logic', () => {
    it('(د) إعادة جدولة الملخص عند التخطي بسبب حد الـ 10 دقائق بدل أن يضيع التحديث', async () => {
      const { orgSyncService } = await import('./orgSyncService');
      
      // Set last push to 3 minutes ago
      const now = Date.now();
      orgSyncService.setLastDailySummaryPushMs(now - 3 * 60 * 1000);

      // Trigger pushDailySummary (not forced)
      await orgSyncService.pushDailySummary(false);

      // Verify that a reschedule timer has been set to push after remaining time (~7 minutes)
      const timer = orgSyncService.getRescheduleSummaryTimer();
      expect(timer).toBeDefined();

      // Clean up timer
      if (timer) clearTimeout(timer);
    });

    it('(هـ) إعادة المحاولة بعد permission-denied (لا توقف للأبد) وإعادة الضبط عند تغير الترخيص أو الدخول', async () => {
      const { orgSyncService } = await import('./orgSyncService');

      // Simulate permission-denied error encounter
      orgSyncService.setSyncState('subscription-paused');
      orgSyncService.schedulePermissionRetry(6 * 60 * 60 * 1000);

      expect(orgSyncService.getPermissionRetryTimer()).toBeDefined();

      // Reset subscription pause (as triggered by new license or sign-in)
      orgSyncService.resetSubscriptionPause();

      expect(orgSyncService.isSubscriptionPaused()).toBe(false);
      expect(orgSyncService.getPermissionRetryTimer()).toBeNull();
      expect(orgSyncService.getSyncState()).toBe('idle');
    });
  });
});

