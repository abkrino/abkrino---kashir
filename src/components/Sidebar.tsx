import React, { useState } from 'react';
import type { TabType, User } from '../types';
import { canAccessTab } from '../services/authSecurityService';
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  Boxes,
  Truck,
  Users,
  Building2,
  Wallet,
  TrendingUp,
  UserCog,
  Settings,
  ChevronDown,
  ChevronLeft,
  X,
  Store,
  Layers,
  Megaphone,
  LucideIcon
} from 'lucide-react';

export type { TabType };

interface SidebarProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
  currentUser: User;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

interface NavItem {
  id: TabType;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  highlight?: boolean;
}

interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  currentUser,
  isOpenMobile = false,
  onCloseMobile,
}) => {
  // State for collapsible navigation groups (default all open)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    daily: false,
    inventory: false,
    reports: false,
    admin: false,
  });

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  // Structured groups with neutral, short labels (no dairy/supermarket terms, no foreign transliterations)
  const navGroups: NavGroup[] = [
    {
      id: 'daily',
      title: 'التشغيل اليومي',
      items: [
        {
          id: 'dashboard',
          label: 'لوحة التحكم',
          icon: LayoutDashboard,
        },
        {
          id: 'pos',
          label: 'الكاشير',
          icon: ShoppingCart,
          shortcut: 'F1',
          highlight: true,
        },
        {
          id: 'invoices',
          label: 'فواتير المبيعات',
          icon: Receipt,
          shortcut: 'F2',
        },
        {
          id: 'customers',
          label: 'العملاء',
          icon: Users,
          shortcut: 'F3',
        },
        {
          id: 'cash',
          label: 'الخزينة والدرج',
          icon: Wallet,
          shortcut: 'F4',
        },
        {
          id: 'announcer',
          label: 'المذيع الصوتي',
          icon: Megaphone,
        },
      ],
    },
    {
      id: 'inventory',
      title: 'المخزون والمشتريات',
      items: [
        {
          id: 'inventory',
          label: 'الأصناف',
          icon: Boxes,
        },
        {
          id: 'purchasing',
          label: 'المشتريات',
          icon: Truck,
        },
        {
          id: 'suppliers',
          label: 'الموردون',
          icon: Building2,
        },
      ],
    },
    {
      id: 'reports',
      title: 'التقارير',
      items: [
        {
          id: 'reports',
          label: 'تقارير الأرباح',
          icon: TrendingUp,
        },
      ],
    },
    {
      id: 'admin',
      title: 'الإدارة',
      items: [
        {
          id: 'users',
          label: 'المستخدمون والصلاحيات',
          icon: UserCog,
        },
        {
          id: 'settings',
          label: 'الإعدادات',
          icon: Settings,
        },
      ],
    },
  ];

  const handleItemClick = (tabId: TabType) => {
    onSelectTab(tabId);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const navContent = (
    <div className="flex flex-col justify-between h-full select-none" dir="rtl">
      <div className="p-3 space-y-4 overflow-y-auto">
        {/* Mobile Drawer Header */}
        <div className="flex items-center justify-between lg:hidden pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center">
              <Store className="w-4 h-4" />
            </div>
            <span className="font-black text-slate-900 dark:text-white text-base">القائمة الرئيسية</span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer transition"
            aria-label="إغلاق القائمة"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Collapsible Navigation Groups */}
        <nav className="space-y-4" aria-label="أقسام النظام الرئيسية">
          {navGroups.map((group) => {
            // Filter items by role-based access control
            const visibleItems = group.items.filter(item => canAccessTab(currentUser, item.id));

            // Hide the group completely if user has no access to any of its items
            if (visibleItems.length === 0) {
              return null;
            }

            const isCollapsed = collapsedGroups[group.id] ?? false;

            return (
              <div key={group.id} className="space-y-1">
                {/* Group Header with Collapse Toggle */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-2.5 py-1 text-right text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer group"
                >
                  <span className="flex items-center gap-1.5">
                    <Layers className="w-3 h-3 text-slate-400 group-hover:text-emerald-600 transition-colors" />
                    <span>{group.title}</span>
                  </span>
                  {isCollapsed ? (
                    <ChevronLeft className="w-3.5 h-3.5 text-slate-400 transition-transform" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400 transition-transform" />
                  )}
                </button>

                {/* Group Items */}
                {!isCollapsed && (
                  <div className="space-y-1 pt-0.5">
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      // Active check also considers settings subtabs (backup, cloud, audit, store-profile)
                      const isItemActive =
                        currentTab === item.id ||
                        (item.id === 'settings' &&
                          ['settings', 'store-profile', 'backup', 'cloud', 'audit'].includes(currentTab));

                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleItemClick(item.id)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-right transition-all cursor-pointer ${
                            isItemActive
                              ? 'bg-emerald-600 text-white font-black shadow-sm shadow-emerald-600/30'
                              : item.highlight
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 font-bold border border-emerald-200 dark:border-emerald-800/60'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 font-bold'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Icon
                              className={`w-4 h-4 sm:w-4.5 sm:h-4.5 shrink-0 ${
                                isItemActive
                                  ? 'text-white'
                                  : item.highlight
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            />
                            <span className="text-xs sm:text-sm truncate">{item.label}</span>
                          </div>

                          {item.shortcut && (
                            <span
                              className={`px-1.5 py-0.5 text-[10px] rounded font-mono font-bold shrink-0 transition-colors ${
                                isItemActive
                                  ? 'bg-white/25 text-white border border-white/30'
                                  : 'bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700'
                              }`}
                              title={`اختصار لوحة المفاتيح: ${item.shortcut}`}
                            >
                              {item.shortcut}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Sidebar Footer with System Offline Indicator */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800/80 text-center">
        <div className="px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-slate-600 dark:text-slate-300">نظام محلي</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              أوفلاين 100%
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="w-64 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 hidden lg:flex flex-col shrink-0 transition-colors z-20">
        {navContent}
      </aside>

      {/* Mobile & Tablet Drawer Modal */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 z-50 lg:hidden flex"
          role="dialog"
          aria-modal="true"
          aria-label="القائمة الجانبية للشاشات الصغيرة"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs transition-opacity animate-in fade-in"
            onClick={onCloseMobile}
          />

          {/* Drawer Content */}
          <div className="relative w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full shadow-2xl flex flex-col z-10 transition-transform animate-in slide-in-from-right duration-200">
            {navContent}
          </div>
        </div>
      )}
    </>
  );
};
