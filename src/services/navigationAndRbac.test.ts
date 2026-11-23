import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canAccessTab, checkUserPermission } from './authSecurityService';
import { Sidebar } from '../components/Sidebar';
import { Navbar } from '../components/Navbar';
import { UnauthorizedState } from '../components/common/FeedbackStates';
import { User, TabType } from '../types';

// Mock localStorage
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

// Sample users for RBAC testing
const adminUser: User = {
  id: 'usr-admin',
  username: 'admin',
  fullName: 'المدير العام',
  role: 'ADMIN',
  isActive: true,
};

const basicCashier: User = {
  id: 'usr-cashier-basic',
  username: 'cashier1',
  fullName: 'كاشير الورديات',
  role: 'SALES',
  isActive: true,
  permissions: {
    canEditPrice: false,
    canGiveDiscount: false,
    canSellNegativeStock: false,
    canDeleteInvoice: false,
    canEditInvoice: false,
    canViewProfits: false,
    canManageProducts: false,
    canManagePurchases: false,
    canManageCash: false,
  },
};

const cashierWithCashPerm: User = {
  ...basicCashier,
  id: 'usr-cashier-cash',
  permissions: {
    ...basicCashier.permissions!,
    canManageCash: true,
  },
};

const cashierWithInventoryPerm: User = {
  ...basicCashier,
  id: 'usr-cashier-inv',
  permissions: {
    ...basicCashier.permissions!,
    canManageProducts: true,
    canManagePurchases: true,
  },
};

const cashierWithReportsPerm: User = {
  ...basicCashier,
  id: 'usr-cashier-reports',
  permissions: {
    ...basicCashier.permissions!,
    canViewProfits: true,
  },
};

const inactiveUser: User = {
  ...adminUser,
  id: 'usr-inactive',
  isActive: false,
};

describe('Navigation RBAC & Role-Based UI Presentation Tests', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // 1. صلاحيات الأدمن الشاملة
  it('الأدمن يملك صلاحية الوصول إلى كافة التبويبات والشاشات والإعدادات', () => {
    const allTabs: TabType[] = [
      'dashboard',
      'pos',
      'invoices',
      'customers',
      'cash',
      'inventory',
      'purchasing',
      'suppliers',
      'reports',
      'users',
      'settings',
      'store-profile',
      'backup',
      'cloud',
      'audit',
    ];

    allTabs.forEach((tab) => {
      expect(canAccessTab(adminUser, tab)).toBe(true);
    });
  });

  // 2. الكاشير الأساسي لا يرى ولا يدخل عناصر الإدارة والتهيئة
  it('الكاشير الأساسي محجوب تماماً عن الإدارة والإعدادات والمستخدمين والنسخ الاحتياطي', () => {
    const adminOnlyTabs: TabType[] = [
      'users',
      'settings',
      'store-profile',
      'backup',
      'cloud',
      'audit',
    ];

    adminOnlyTabs.forEach((tab) => {
      expect(canAccessTab(basicCashier, tab)).toBe(false);
      expect(canAccessTab(cashierWithCashPerm, tab)).toBe(false);
      expect(canAccessTab(cashierWithInventoryPerm, tab)).toBe(false);
    });
  });

  // 3. التبويبات التشغيلية الافتراضية للكاشير
  it('الكاشير يستطيع الوصول للتبويبات اليومية الأساسية (لوحة التحكم، الكاشير، الفواتير، والعملاء)', () => {
    expect(canAccessTab(basicCashier, 'dashboard')).toBe(true);
    expect(canAccessTab(basicCashier, 'pos')).toBe(true);
    expect(canAccessTab(basicCashier, 'invoices')).toBe(true);
    expect(canAccessTab(basicCashier, 'customers')).toBe(true);
  });

  // 4. صلاحيات الدرج والمخزون والتقارير المخصصة للكاشير
  it('الوصول للدرج والمخزن والتقارير يعتمد بدقة على مصفوفة صلاحيات الكاشير', () => {
    // Basic Cashier without permissions
    expect(canAccessTab(basicCashier, 'cash')).toBe(false);
    expect(canAccessTab(basicCashier, 'inventory')).toBe(false);
    expect(canAccessTab(basicCashier, 'purchasing')).toBe(false);
    expect(canAccessTab(basicCashier, 'suppliers')).toBe(false);
    expect(canAccessTab(basicCashier, 'reports')).toBe(false);

    // Cashier with cash permissions
    expect(canAccessTab(cashierWithCashPerm, 'cash')).toBe(true);
    expect(canAccessTab(cashierWithCashPerm, 'inventory')).toBe(false);

    // Cashier with inventory and purchasing permissions
    expect(canAccessTab(cashierWithInventoryPerm, 'inventory')).toBe(true);
    expect(canAccessTab(cashierWithInventoryPerm, 'purchasing')).toBe(true);
    expect(canAccessTab(cashierWithInventoryPerm, 'suppliers')).toBe(true);
    expect(canAccessTab(cashierWithInventoryPerm, 'cash')).toBe(false);

    // Cashier with reports permission
    expect(canAccessTab(cashierWithReportsPerm, 'reports')).toBe(true);
  });

  // 5. المستخدم غير النشط محجوب عن كل شيء
  it('المستخدم غير النشط (المعطل) ممنوع من الوصول لأي تبويب في النظام', () => {
    expect(canAccessTab(inactiveUser, 'pos')).toBe(false);
    expect(canAccessTab(inactiveUser, 'dashboard')).toBe(false);
    expect(canAccessTab(inactiveUser, 'settings')).toBe(false);
  });

  // 6. القائمة الجانبية تُخفي عناصر الإدارة عن الكاشير وتُظهرها للأدمن
  it('القائمة الجانبية تخفي قسم الإدارة والمستخدمين والإعدادات عن الكاشير وتظهرها للمدير', () => {
    // Render sidebar for Admin
    const adminHtml = renderToStaticMarkup(
      React.createElement(Sidebar, {
        currentTab: 'dashboard',
        onSelectTab: () => {},
        currentUser: adminUser,
      })
    );

    expect(adminHtml).toContain('المستخدمون والصلاحيات');
    expect(adminHtml).toContain('الإعدادات');
    expect(adminHtml).toContain('التشغيل اليومي');
    expect(adminHtml).toContain('المخزون والمشتريات');
    expect(adminHtml).toContain('التقارير');
    expect(adminHtml).toContain('الإدارة');

    // Render sidebar for Cashier
    const cashierHtml = renderToStaticMarkup(
      React.createElement(Sidebar, {
        currentTab: 'pos',
        onSelectTab: () => {},
        currentUser: basicCashier,
      })
    );

    // Management section and items must NOT be present
    expect(cashierHtml).not.toContain('المستخدمون والصلاحيات');
    expect(cashierHtml).not.toContain('الإعدادات');
    // Operational items must be present
    expect(cashierHtml).toContain('الكاشير');
    expect(cashierHtml).toContain('فواتير المبيعات');
    expect(cashierHtml).toContain('العملاء');
  });

  // 7. اختصارات لوحة المفاتيح F1 - F4 تظهر كشارات تلميح في القائمة الجانبية
  it('اختصارات لوحة المفاتيح F1 إلى F4 تظهر بوضوح كتلميحات بجوار البنود', () => {
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, {
        currentTab: 'pos',
        onSelectTab: () => {},
        currentUser: adminUser,
      })
    );

    expect(html).toContain('F1');
    expect(html).toContain('F2');
    expect(html).toContain('F3');
    expect(html).toContain('F4');
  });

  // 8. شاشة "غير مصرح" الموحدة تمنع تسريب البيانات عند محاولة الدخول المباشر
  it('شاشة غير مصرح بالدخول تعرض رسالة أمان وأزرار رجوع آمنة بدون تسريب بيانات', () => {
    const unauthorizedHtml = renderToStaticMarkup(
      React.createElement(UnauthorizedState, {
        title: 'غير مصرح بالدخول',
        message: 'ليس لديك الصلاحية المطلوبة للوصول إلى هذه الشاشة.',
        onNavigatePos: () => {},
        onNavigateHome: () => {},
      })
    );

    expect(unauthorizedHtml).toContain('غير مصرح بالدخول');
    expect(unauthorizedHtml).toContain('منطقة محمية بصلاحيات');
    expect(unauthorizedHtml).toContain('العودة لشاشة الكاشير (F1)');
    expect(unauthorizedHtml).toContain('لوحة التحكم الرئيسية');
  });

  // 9. رصيد الدرج في الشريط العلوي يظهر فقط لمن يملك الصلاحية
  it('الشريط العلوي يخفي رصيد الدرج عن الكاشير الذي لا يملك صلاحية نقدية الدرج', () => {
    // Admin sees cash
    const adminNavHtml = renderToStaticMarkup(
      React.createElement(Navbar, {
        currentUser: adminUser,
        currentCash: 5400,
        onLockScreen: () => {},
        onOpenLogin: () => {},
      })
    );
    expect(adminNavHtml).toContain('رصيد الدرج:');
    expect(adminNavHtml).toContain('ج.م');

    // Basic cashier without manage_cash does NOT see cash balance
    const cashierNavHtml = renderToStaticMarkup(
      React.createElement(Navbar, {
        currentUser: basicCashier,
        currentCash: 5400,
        onLockScreen: () => {},
        onOpenLogin: () => {},
      })
    );
    expect(cashierNavHtml).not.toContain('رصيد الدرج:');

    // Cashier with cash permission sees cash balance
    const permNavHtml = renderToStaticMarkup(
      React.createElement(Navbar, {
        currentUser: cashierWithCashPerm,
        currentCash: 5400,
        onLockScreen: () => {},
        onOpenLogin: () => {},
      })
    );
    expect(permNavHtml).toContain('رصيد الدرج:');
    expect(permNavHtml).toContain('ج.م');
  });
});
