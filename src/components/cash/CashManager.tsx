import React, { useState } from 'react';
import { CashMovement, Expense, SystemShift, User, CashMovementFunding, CashOutEvaluation } from '../../types';
import { storage } from '../../services/storageService';
import { FundingSourceModal } from '../common/FundingSourceModal';
import { Wallet, Coins, Plus, Minus, ArrowUpRight, ArrowDownLeft, ShieldCheck, X, CheckCircle, AlertCircle, Play } from 'lucide-react';

interface CashManagerProps {
  currentUser: User;
  onRefreshData: () => void;
}

export const CashManager: React.FC<CashManagerProps> = ({
  currentUser,
  onRefreshData,
}) => {
  const [movements, setMovements] = useState<CashMovement[]>(storage.getCashMovements());
  const [expenses, setExpenses] = useState<Expense[]>(storage.getExpenses());
  const [currentCash, setCurrentCash] = useState<number>(storage.calculateCurrentCashInDrawer());
  const [currentShift, setCurrentShift] = useState<SystemShift>(storage.getCurrentShift());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const accountingMode = storage.getAccountingMode();
  const monthlyPoolAvailable = storage.calculateMonthlyPoolAvailable();

  // Expense Modal State
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<'RENT' | 'ELECTRICITY' | 'HOSPITALITY' | 'TRANSPORT' | 'LABOR' | 'MAINTENANCE' | 'OTHER'>('HOSPITALITY');
  const [expenseAmount, setExpenseAmount] = useState<number>(50);
  const [expenseNotes, setExpenseNotes] = useState<string>('');
  const [expenseError, setExpenseError] = useState<string | null>(null);

  // Manual Withdrawal Modal State
  const [isWithdrawalModalOpen, setIsWithdrawalModalOpen] = useState(false);
  const [withdrawalAmount, setWithdrawalAmount] = useState<number>(100);
  const [withdrawalDesc, setWithdrawalDesc] = useState<string>('');
  const [withdrawalError, setWithdrawalError] = useState<string | null>(null);

  // Deposit / Capital Injection Modal State
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [depositType, setDepositType] = useState<'DRAWER' | 'CAPITAL_INJECTION'>(
    accountingMode === 'CAPITAL' ? 'CAPITAL_INJECTION' : 'DRAWER'
  );
  const [capitalAffectsDrawer, setCapitalAffectsDrawer] = useState<boolean>(
    accountingMode !== 'CAPITAL'
  );
  const [depositAmount, setDepositAmount] = useState<number>(500);
  const [depositDesc, setDepositDesc] = useState<string>('');
  const [depositError, setDepositError] = useState<string | null>(null);

  // Funding Source Modal State (shared between Expense & Manual Withdrawal)
  const [fundingModalContext, setFundingModalContext] = useState<{
    kind: 'EXPENSE' | 'WITHDRAWAL';
    amount: number;
    evalState: CashOutEvaluation;
  } | null>(null);

  // Shift lifecycle modals
  const [isCloseShiftOpen, setIsCloseShiftOpen] = useState(false);
  const [isOpenShiftOpen, setIsOpenShiftOpen] = useState(false);
  const [openShiftError, setOpenShiftError] = useState<string | null>(null);
  const [physicalCashCounted, setPhysicalCashCounted] = useState<number>(currentCash);
  const [closeShiftError, setCloseShiftError] = useState<string | null>(null);

  const expenseCategoryMap: Record<string, string> = {
    RENT: 'إيجار المحل أو المخزن',
    ELECTRICITY: 'كهرباء وإنارة',
    HOSPITALITY: 'ضيافة وبوفيه وشاي',
    TRANSPORT: 'مشال ونقل وتعتيق',
    LABOR: 'يوميات عمالة مساعدة',
    MAINTENANCE: 'صيانة ومستلزمات نظافة',
    OTHER: 'نثريات ومصروفات أخرى',
  };

  const refreshCashViews = () => {
    setExpenses(storage.getExpenses());
    setMovements(storage.getCashMovements());
    setCurrentCash(storage.calculateCurrentCashInDrawer());
    onRefreshData();
  };

  const executeExpenseSubmit = async (allowNegative: boolean, fundingDetails?: CashMovementFunding) => {
    const newExpense: Expense = {
      id: `exp-${Date.now()}`,
      date: new Date().toISOString().split('T')[0],
      category: expenseCategory,
      categoryLabelArabic: expenseCategoryMap[expenseCategory],
      amount: expenseAmount,
      notes: expenseNotes,
      recordedBy: currentUser.fullName,
      fundingDetails,
    };

    const res = storage.recordExpense(newExpense, {
      user: currentUser,
      allowNegativeCash: allowNegative,
      fundingDetails,
    });

    if (!res.success) {
      setExpenseError(res.error || 'تعذر تسجيل المصروف في حالة الاشتراك الحالية.');
      setFundingModalContext(null);
      return;
    }

    try {
      await storage.flush();
      if (storage.getWriteError()) {
        setStatusMessage(`تعذر تأكيد تسجيل المصروف في التخزين الدائم: ${storage.getWriteError()}`);
        return;
      }
    } catch (err: any) {
      setStatusMessage(`تعذر تأكيد تسجيل المصروف في التخزين الدائم: ${err?.message || 'خطأ'}`);
      return;
    }

    setFundingModalContext(null);
    setIsExpenseModalOpen(false);
    setExpenseNotes('');
    setExpenseError(null);
    refreshCashViews();
  };

  const handleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpenseError(null);
    if (expenseAmount <= 0) {
      setExpenseError('قيمة المصروف يجب أن تكون أكبر من صفر');
      return;
    }

    const evalRes = storage.evaluateCashOut(expenseAmount, {
      user: currentUser,
      operation: 'EXPENSE',
    });

    if (!evalRes.allowed) {
      const canNegative =
        currentUser.role === 'ADMIN' || Boolean(currentUser.permissions?.canWithdrawNegativeCash);
      if (evalRes.requiresFundingSource && canNegative) {
        setFundingModalContext({ kind: 'EXPENSE', amount: expenseAmount, evalState: evalRes });
        return;
      }
      setExpenseError(evalRes.reason || 'الرصيد المتاح لا يكفي لتسجيل المصروف');
      return;
    }

    await executeExpenseSubmit(false, undefined);
  };

  const executeWithdrawalSubmit = async (allowNegative: boolean, fundingDetails?: CashMovementFunding) => {
    const res = storage.recordManualWithdrawal({
      amount: withdrawalAmount,
      description: withdrawalDesc,
      performedBy: currentUser.fullName,
      user: currentUser,
      allowNegativeCash: allowNegative,
      fundingDetails,
    });

    if (!res.success) {
      setWithdrawalError(res.error || 'تعذر تنفيذ السحب اليدوي في حالة الاشتراك الحالية.');
      setFundingModalContext(null);
      return;
    }

    try {
      await storage.flush();
    } catch {}

    setFundingModalContext(null);
    setIsWithdrawalModalOpen(false);
    setWithdrawalDesc('');
    setWithdrawalError(null);
    setStatusMessage(`تم تسجيل السحب النقدي اليدوي بقيمة ${withdrawalAmount.toLocaleString('ar-EG')} ج.م بنجاح.`);
    refreshCashViews();
  };

  const handleWithdrawalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawalError(null);
    if (withdrawalAmount <= 0) {
      setWithdrawalError('مبلغ السحب يجب أن يكون أكبر من صفر');
      return;
    }
    if (!withdrawalDesc.trim()) {
      setWithdrawalError('يرجى كتابة سبب السحب اليدوي');
      return;
    }

    const evalRes = storage.evaluateCashOut(withdrawalAmount, {
      user: currentUser,
      operation: 'MANUAL_WITHDRAWAL',
    });

    if (!evalRes.allowed) {
      const canNegative =
        currentUser.role === 'ADMIN' || Boolean(currentUser.permissions?.canWithdrawNegativeCash);
      if (evalRes.requiresFundingSource && canNegative) {
        setFundingModalContext({ kind: 'WITHDRAWAL', amount: withdrawalAmount, evalState: evalRes });
        return;
      }
      setWithdrawalError(evalRes.reason || 'الرصيد المتاح لا يكفي لتنفيذ السحب');
      return;
    }

    await executeWithdrawalSubmit(false, undefined);
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDepositError(null);

    const res =
      depositType === 'CAPITAL_INJECTION'
        ? storage.recordCapitalInjection({
            amount: depositAmount,
            description: depositDesc,
            performedBy: currentUser.fullName,
            user: currentUser,
            affectsDrawer: capitalAffectsDrawer,
          })
        : storage.recordManualDeposit({
            amount: depositAmount,
            description: depositDesc,
            performedBy: currentUser.fullName,
          });

    if (!res.success) {
      setDepositError(res.error || 'تعذر تسجيل الإيداع في حالة الاشتراك الحالية.');
      return;
    }

    try {
      await storage.flush();
    } catch {}

    setIsDepositModalOpen(false);
    setDepositDesc('');
    setStatusMessage(
      depositType === 'CAPITAL_INJECTION'
        ? `تم تسجيل ضخ رأس مال بقيمة ${depositAmount.toLocaleString('ar-EG')} ج.م كحركة منفصلة غير إيرادية.`
        : `تم تسجيل إيداع نقدي بالدرج بقيمة ${depositAmount.toLocaleString('ar-EG')} ج.م.`
    );
    refreshCashViews();
  };

  // Drawer Reconciliation Submit
  const handleCloseShiftSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCloseShiftError(null);
    const latestShift = storage.getCurrentShift() || currentShift;
    const diff = physicalCashCounted - currentCash;

    const updatedShift: SystemShift = {
      ...latestShift,
      closedAt: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      expectedClosingCash: currentCash,
      actualClosingCash: physicalCashCounted,
      difference: diff,
      status: 'CLOSED',
    };

    const shiftRes = storage.saveCurrentShift(updatedShift);
    if (!shiftRes.success) {
      setCloseShiftError(
        shiftRes.error ||
          'تعذر إغلاق الوردية: لا توجد وردية مفتوحة أو انتهت صلاحية الاشتراك.'
      );
      return;
    }

    // Requirement 3: Immediate flush to persistent storage before showing success
    try {
      await storage.flush();
      if (storage.getWriteError()) {
        setCloseShiftError(`تعذر تأكيد إغلاق الوردية في التخزين الدائم: ${storage.getWriteError()}`);
        return;
      }
    } catch (err: any) {
      setCloseShiftError(`تعذر تأكيد إغلاق الوردية في التخزين الدائم: ${err?.message || 'خطأ'}`);
      return;
    }

    setCurrentShift(updatedShift);
    setIsCloseShiftOpen(false);

    storage.addAuditLog(
      'SHIFT',
      'إغلاق ومطابقة الوردية',
      'الخزينة',
      currentShift.id,
      `إغلاق الوردية: النقدية المحسوبة: ${currentCash} ج.م، الفعلية المعدودة: ${physicalCashCounted} ج.م، الفارق: ${diff} ج.م`
    );

    setStatusMessage(`تم إغلاق الوردية وتسجيل المطابقة بنجاح. ${diff === 0 ? 'النقدية متطابقة تماماً بدون أي عجز أو زيادة!' : diff < 0 ? `يوجد عجز نقدي بقيمة ${Math.abs(diff)} ج.م` : `توجد زيادة نقدية بقيمة ${diff} ج.م`}`);
    onRefreshData();
  };

  const totalInflows = movements.filter(m => m.type === 'IN').reduce((sum, m) => sum + m.amount, 0);
  const totalOutflows = movements.filter(m => m.type === 'OUT').reduce((sum, m) => sum + m.amount, 0);

  return (
    <div className="space-y-5" dir="rtl">
      {/* Header & Drawer Balance */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-colors">
        <div>
          <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            <span>الخزينة النقدية ومصروفات التشغيل اليومية</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium">
            حركة السيولة بالدرج، تحصيلات المبيعات، سندات الصرف، ومصروفات الضيافة والمشال.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-semibold">النظام المحاسبي النشط:</span>
            <span className="font-bold text-emerald-700 dark:text-emerald-300 text-xs">
              {accountingMode === 'DAILY_DRAWER'
                ? 'الدرج اليومي الفعلي'
                : accountingMode === 'MONTHLY_POOL'
                ? `الوعاء الشهري (المتاح: ${monthlyPoolAvailable.toLocaleString('ar-EG')} ج.م)`
                : 'رأس المال (بلا قيد درج)'}
            </span>
          </div>

          <div className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3.5 py-1.5 rounded-lg">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 block font-semibold">رصيد الدرج الفعلي:</span>
            <span className="font-mono font-black text-amber-600 dark:text-amber-300 text-base">
              {currentCash.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
            </span>
          </div>

          <button
            onClick={() => {
              setExpenseError(null);
              setIsExpenseModalOpen(true);
            }}
            className="bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1.5 shadow-md shadow-rose-950/20 cursor-pointer transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>تسجيل مصروف تشغيل -</span>
          </button>

          <button
            onClick={() => {
              setWithdrawalError(null);
              setIsWithdrawalModalOpen(true);
            }}
            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1.5 shadow-xs cursor-pointer transition-all"
          >
            <Minus className="w-4 h-4" />
            <span>سحب يدوي</span>
          </button>

          <button
            onClick={() => {
              setDepositError(null);
              setDepositType(accountingMode === 'CAPITAL' ? 'CAPITAL_INJECTION' : 'DRAWER');
              setIsDepositModalOpen(true);
            }}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1.5 shadow-xs cursor-pointer transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>{accountingMode === 'CAPITAL' ? 'إيداع رأس مال' : 'إيداع بالدرج'}</span>
          </button>

          {currentShift.status === 'OPEN' ? (
            <button
              onClick={() => {
                setCurrentShift(storage.getCurrentShift());
                setCloseShiftError(null);
                setPhysicalCashCounted(currentCash);
                setIsCloseShiftOpen(true);
              }}
              className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-bold px-3.5 py-2 rounded-lg flex items-center gap-1.5 border border-slate-300 dark:border-slate-700 cursor-pointer transition-colors shadow-xs"
            >
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>مطابقة الدرج وإغلاق الوردية</span>
            </button>
          ) : (
            <button
              onClick={() => {
                setOpenShiftError(null);
                setCurrentShift(storage.getCurrentShift());
                setIsOpenShiftOpen(true);
              }}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3.5 py-2 rounded-lg flex items-center gap-1.5 shadow-xs cursor-pointer transition-colors"
            >
              <Play className="w-4 h-4" />
              <span>فتح وردية جديدة</span>
            </button>
          )}
        </div>
      </div>

      {statusMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between font-bold">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>{statusMessage}</span>
          </div>
          <button onClick={() => setStatusMessage(null)} className="cursor-pointer text-xs opacity-75 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Cash Flow Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-xs transition-colors">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400 block font-semibold">إجمالي المقبوضات (وارد الخزينة)</span>
            <span className="text-xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1 block">
              {totalInflows.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
            </span>
          </div>
          <div className="p-3 rounded-xl bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            <ArrowDownLeft className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-xs transition-colors">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400 block font-semibold">إجمالي المدفوعات (منصرف الخزينة)</span>
            <span className="text-xl font-black font-mono text-rose-600 dark:text-rose-400 mt-1 block">
              {totalOutflows.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
            </span>
          </div>
          <div className="p-3 rounded-xl bg-rose-100 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400">
            <ArrowUpRight className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-xs transition-colors">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400 block font-semibold">إجمالي المصروفات النثرية اليوم</span>
            <span className="text-xl font-black font-mono text-amber-600 dark:text-amber-400 mt-1 block">
              {expenses.reduce((s, e) => s + e.amount, 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
            </span>
          </div>
          <div className="p-3 rounded-xl bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <Coins className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Movements Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm transition-colors">
        <div className="p-3 bg-slate-100 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 font-bold text-xs text-slate-800 dark:text-slate-200">
          دفتر حركة النقدية اليومي ({movements.length} حركة)
        </div>

        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-right text-xs">
            <thead className="sticky top-0 bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 text-[11px] font-bold">
              <tr>
                <th className="py-2.5 px-3">التاريخ / الوقت</th>
                <th className="py-2.5 px-3">نوع الحركة</th>
                <th className="py-2.5 px-3">التصنيف</th>
                <th className="py-2.5 px-3">مصدر التمويل والأثر</th>
                <th className="py-2.5 px-3">البيان والشرح</th>
                <th className="py-2.5 px-3">المبلغ</th>
                <th className="py-2.5 px-3">المسؤول</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {movements.map(m => (
                <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 text-slate-800 dark:text-slate-200 transition-colors">
                  <td className="py-2.5 px-3 font-mono text-slate-500 dark:text-slate-400">
                    {m.date} {m.time}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                      m.category === 'CAPITAL_INJECTION'
                        ? 'bg-indigo-100 dark:bg-indigo-950/80 text-indigo-800 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-800'
                        : m.type === 'IN'
                        ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800'
                        : 'bg-rose-100 dark:bg-rose-950/80 text-rose-800 dark:text-rose-300 border border-rose-300 dark:border-rose-800'
                    }`}>
                      {m.category === 'CAPITAL_INJECTION'
                        ? 'ضخ رأس مال (غير إيرادي)'
                        : m.type === 'IN'
                        ? 'مقبوض وارد +'
                        : 'منصرف صادر -'}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-slate-100">{m.categoryLabelArabic}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                        {m.fundingDetails?.label || (m.type === 'IN' ? 'وارد مباشر' : 'نقدية الدرج')}
                      </span>
                      {m.fundingDetails?.note && (
                        <span className="text-[10px] text-slate-500 dark:text-slate-400">
                          {m.fundingDetails.note}
                        </span>
                      )}
                      {m.affectsDrawer === false && (
                        <span className="inline-block w-fit text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                          خارج الدرج (رأس المال)
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">{m.description}</td>
                  <td className={`py-2.5 px-3 font-mono font-bold text-sm ${
                    m.type === 'IN' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  }`}>
                    {m.amount.toFixed(2)} ج.م
                  </td>
                  <td className="py-2.5 px-3 text-slate-500 dark:text-slate-400">{m.performedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expense Modal */}
      {isExpenseModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <span>تسجيل مصروف تشغيلي من نقدية الدرج</span>
              </h3>
              <button onClick={() => setIsExpenseModalOpen(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleExpenseSubmit} className="mt-4 space-y-3.5 text-xs">
              {expenseError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{expenseError}</span>
                </div>
              )}

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">بند المصروف:</label>
                <select
                  value={expenseCategory}
                  onChange={(e) => setExpenseCategory(e.target.value as any)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-slate-900 dark:text-white font-bold"
                >
                  {Object.entries(expenseCategoryMap).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">قيمة المصروف (ج.م):</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={expenseAmount}
                  onChange={(e) => setExpenseAmount(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-rose-600 dark:text-rose-400 font-mono font-bold text-base"
                />
              </div>

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">تفاصيل / بيان المصروف:</label>
                <input
                  type="text"
                  required
                  value={expenseNotes}
                  onChange={(e) => setExpenseNotes(e.target.value)}
                  placeholder="مثال: فاتورة كهرباء شهرية، شاي وسكر للبوفيه..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-slate-900 dark:text-white"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsExpenseModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold cursor-pointer transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold cursor-pointer shadow-md transition-colors"
                >
                  {accountingMode === 'CAPITAL' ? 'تسجيل المصروف من رأس المال' : 'خصم المصروف من الدرج'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manual Withdrawal Modal */}
      {isWithdrawalModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Minus className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>سحب نقدي يدوي</span>
              </h3>
              <button onClick={() => setIsWithdrawalModalOpen(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleWithdrawalSubmit} className="mt-4 space-y-3.5 text-xs">
              {withdrawalError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{withdrawalError}</span>
                </div>
              )}

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">المبلغ المطلوب سحبه (ج.م):</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={withdrawalAmount}
                  onChange={(e) => setWithdrawalAmount(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-amber-600 dark:text-amber-400 font-mono font-bold text-base"
                />
              </div>

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">بيان / سبب السحب:</label>
                <input
                  type="text"
                  required
                  value={withdrawalDesc}
                  onChange={(e) => setWithdrawalDesc(e.target.value)}
                  placeholder="مثال: توريد للبنك، سحب مالك، تسوية عهدة..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-slate-900 dark:text-white"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsWithdrawalModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold cursor-pointer shadow-md"
                >
                  تأكيد السحب اليدوي
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Deposit / Capital Injection Modal */}
      {isDepositModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>تسجيل إيداع نقدي / ضخ رأس مال</span>
              </h3>
              <button onClick={() => setIsDepositModalOpen(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleDepositSubmit} className="mt-4 space-y-3.5 text-xs">
              {depositError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold">
                  {depositError}
                </div>
              )}

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">نوع الإيداع:</label>
                <select
                  value={depositType}
                  onChange={(e) => setDepositType(e.target.value as 'DRAWER' | 'CAPITAL_INJECTION')}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-slate-900 dark:text-white font-bold"
                >
                  <option value="DRAWER">إيداع نقدي مباشر في درج الكاشير</option>
                  <option value="CAPITAL_INJECTION">ضخ / إيداع رأس مال من المالك (غير إيرادي)</option>
                </select>
              </div>

              {depositType === 'CAPITAL_INJECTION' && (
                <label className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={capitalAffectsDrawer}
                    onChange={(e) => setCapitalAffectsDrawer(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed font-semibold">
                    توريد هذه النقدية فعلياً داخل درج الكاشير (يؤثر على الدرج ولا يُحسب ضمن الإيرادات أو الأرباح)
                  </span>
                </label>
              )}

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">المبلغ (ج.م):</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-emerald-600 dark:text-emerald-400 font-mono font-bold text-base"
                />
              </div>

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">البيان / الملاحظات:</label>
                <input
                  type="text"
                  value={depositDesc}
                  onChange={(e) => setDepositDesc(e.target.value)}
                  placeholder="مثال: تعزيز سيولة الدرج، ضخ رأس مال لشراء بضاعة..."
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-slate-900 dark:text-white"
                />
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsDepositModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer shadow-md"
                >
                  حفظ الإيداع
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Structured Funding Source Modal */}
      <FundingSourceModal
        isOpen={Boolean(fundingModalContext)}
        amount={fundingModalContext?.amount ?? 0}
        available={fundingModalContext?.evalState.available ?? currentCash}
        mode={fundingModalContext?.evalState.mode ?? accountingMode}
        operationLabel={fundingModalContext?.kind === 'EXPENSE' ? 'تسجيل مصروف' : 'سحب نقدي يدوي'}
        onCancel={() => setFundingModalContext(null)}
        onConfirm={(funding) => {
          if (fundingModalContext?.kind === 'EXPENSE') {
            executeExpenseSubmit(true, funding);
          } else {
            executeWithdrawalSubmit(true, funding);
          }
        }}
      />

      {/* Shift Opening Confirmation Modal */}
      {isOpenShiftOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Play className="w-5 h-5 text-emerald-600" />
                <span>فتح وردية جديدة</span>
              </h3>
              <button type="button" onClick={() => setIsOpenShiftOpen(false)} className="text-slate-400 hover:text-slate-700 p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-4 space-y-3 text-xs">
              {openShiftError && <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold">{openShiftError}</div>}
              <div className="rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 p-4 space-y-2">
                <div className="flex justify-between"><span className="text-slate-500">المسؤول عن الوردية</span><strong>{currentUser.fullName}</strong></div>
                <div className="flex justify-between"><span className="text-slate-500">تاريخ ووقت الفتح</span><strong>{new Date().toLocaleString('ar-EG')}</strong></div>
                <div className="flex justify-between"><span className="text-slate-500">الرصيد الافتتاحي للدرج</span><strong className="text-emerald-600 font-mono">{currentCash.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong></div>
              </div>
              <p className="text-slate-500 leading-6">سيتم تسجيل الوردية الجديدة وربطها برصيد الدرج الحالي. لن تتم إضافة الرصيد مرة ثانية إلى حركات الخزينة حتى لا يتكرر احتساب النقدية.</p>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsOpenShiftOpen(false)} className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold">إلغاء</button>
                <button type="button" onClick={async () => {
                  setOpenShiftError(null);
                  const latest = storage.getCurrentShift();
                  if (latest.status === 'OPEN') {
                    setOpenShiftError('توجد وردية مفتوحة بالفعل. أغلقها أولاً قبل فتح وردية جديدة.');
                    return;
                  }
                  const now = new Date();
                  const newShift: SystemShift = {
                    id: 'shift-' + now.getTime() + '-' + Math.random().toString(36).slice(2, 8),
                    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(now),
                    openedAt: now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
                    openedBy: currentUser.fullName,
                    openingCash: currentCash,
                    expectedClosingCash: currentCash,
                    status: 'OPEN',
                  };
                  const result = storage.saveCurrentShift(newShift);
                  if (!result.success) {
                    setOpenShiftError(result.error || 'تعذر فتح الوردية في حالة الترخيص الحالية.');
                    return;
                  }
                  try {
                    await storage.flush();
                    if (storage.getWriteError()) throw new Error(storage.getWriteError() || 'فشل حفظ الوردية');
                    storage.addAuditLog('SHIFT', 'فتح وردية جديدة', 'الخزينة', newShift.id, 'فتح وردية جديدة بواسطة ' + currentUser.fullName + ' برصيد افتتاحي ' + currentCash + ' ج.م');
                    await storage.flush();
                  } catch (error: any) {
                    setOpenShiftError('تعذر تأكيد حفظ الوردية: ' + (error?.message || 'خطأ غير معروف'));
                    return;
                  }
                  setCurrentShift(newShift);
                  setIsOpenShiftOpen(false);
                  setStatusMessage('تم فتح الوردية الجديدة بنجاح.');
                  onRefreshData();
                }} className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black">تأكيد فتح الوردية</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Shift Closing Reconciliation Modal */}
      {isCloseShiftOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl text-right transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-black text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <span>مطابقة الدرج وإغلاق الوردية اليومية</span>
              </h3>
              <button onClick={() => setIsCloseShiftOpen(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCloseShiftSubmit} className="mt-4 space-y-3.5 text-xs">
              {closeShiftError && (
                <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{closeShiftError}</span>
                </div>
              )}
              {(() => {
                const todayStr = new Date().toISOString().split('T')[0];
                const todayInvoices = storage.getSalesInvoices().filter(inv => inv.date === todayStr);
                const todayReturns = storage.getSalesReturns().filter(ret => ret.date === todayStr);
                const grossTodaySales = todayInvoices.reduce((s, inv) => s + (inv.total || 0), 0);
                const todayReturnsTotal = todayReturns.reduce((s, ret) => s + (ret.totalAmount || 0), 0);
                const netTodaySales = grossTodaySales - todayReturnsTotal;
                return (
                  <div className="bg-slate-50 dark:bg-slate-950/80 p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-slate-600 dark:text-slate-400">مبيعات اليوم (قبل المرتجعات):</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white">{grossTodaySales.toFixed(2)} ج.م</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-rose-700 dark:text-rose-400 font-semibold">مرتجعات المبيعات اليوم ({todayReturns.length}):</span>
                      <span className="font-mono font-bold text-rose-600 dark:text-rose-400">- {todayReturnsTotal.toFixed(2)} ج.م</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-200 dark:border-slate-800 pb-1.5">
                      <span className="text-emerald-700 dark:text-emerald-400 font-bold">صافي مبيعات اليوم:</span>
                      <span className="font-mono font-black text-emerald-600 dark:text-emerald-400">{netTodaySales.toFixed(2)} ج.م</span>
                    </div>
                    <div className="flex justify-between pt-0.5">
                      <span className="text-slate-600 dark:text-slate-400">النقدية المحسوبة دفترياً بالدرج:</span>
                      <span className="font-mono font-bold text-amber-600 dark:text-amber-300">{currentCash.toFixed(2)} ج.م</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>مسؤول الوردية:</span>
                      <span className="font-bold text-slate-700 dark:text-slate-300">{currentUser.fullName}</span>
                    </div>
                  </div>
                );
              })()}

              <div>
                <label className="text-slate-700 dark:text-slate-300 block mb-1 font-semibold">
                  النقدية الفعلية المعدودة في الدرج الآن (جرد يدوي):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={physicalCashCounted}
                  onChange={(e) => setPhysicalCashCounted(parseFloat(e.target.value) || 0)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg p-2.5 text-emerald-600 dark:text-emerald-400 font-mono font-bold text-lg"
                />
              </div>

              {/* Difference feedback */}
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs flex justify-between items-center">
                <span className="font-semibold text-slate-700 dark:text-slate-300">الفارق (العجز / الزيادة):</span>
                <span className={`font-mono font-bold text-xs ${
                  physicalCashCounted - currentCash === 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : physicalCashCounted - currentCash < 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}>
                  {(physicalCashCounted - currentCash).toFixed(2)} ج.م
                  {physicalCashCounted - currentCash === 0 ? ' (مطابق تماماً)' : physicalCashCounted - currentCash < 0 ? ' (عجز)' : ' (زيادة)'}
                </span>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsCloseShiftOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold cursor-pointer transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer shadow-md transition-colors"
                >
                  اعتماد المطابقة وإغلاق الوردية
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
