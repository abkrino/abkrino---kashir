import React, { useEffect, useRef, useState } from 'react';
import { Megaphone, Plus, Play, Trash2, Volume2, RefreshCw, AlertCircle, XCircle } from 'lucide-react';

export const AnnouncerManager: React.FC = () => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const desktopApi = window.kashirAnnouncer;

  const loadItems = async () => {
    if (!desktopApi) return;
    try { setItems(await desktopApi.list()); }
    catch (e: any) { setError(e?.message || 'تعذر تحميل قائمة التشغيل.'); }
  };
  useEffect(() => { void loadItems(); }, []);

  const cancelGeneration = async () => {
    if (!desktopApi?.cancel) return;
    try {
      const cancelled = await desktopApi.cancel();
      if (cancelled) setError('تم طلب إيقاف توليد الإعلان.');
    } catch (e: any) { setError(e?.message || 'تعذر إيقاف التوليد.'); }
  };

  const createAnnouncement = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!desktopApi) { setError('ميزة توليد الصوت متاحة في نسخة Electron على Windows فقط.'); return; }
    if (!text.trim()) { setError('اكتب نص العرض قبل إنشاء الصوت.'); return; }
    setBusy(true);
    try {
      await desktopApi.create({ title: title.trim(), text: text.trim() });
      setTitle(''); setText(''); await loadItems();
    } catch (e: any) {
      setError(e?.message || 'تعذر توليد الصوت. تأكد من تثبيت صوت عربي في Windows.');
    } finally { setBusy(false); }
  };
  const playItem = async (item: AnnouncementItem) => {
    if (!desktopApi) return;
    setError(null);
    try {
      const base64 = await desktopApi.readAudio(item.id);
      setAudioUrl('data:audio/wav;base64,' + base64);
      window.setTimeout(() => { void audioRef.current?.play(); }, 0);
    } catch (e: any) { setError(e?.message || 'تعذر تشغيل الملف الصوتي.'); }
  };
  const removeItem = async (item: AnnouncementItem) => {
    if (!desktopApi || !window.confirm('حذف الإعلان "' + item.title + '" نهائياً؟')) return;
    try {
      await desktopApi.remove(item.id);
      setItems(current => current.filter(entry => entry.id !== item.id));
    } catch (e: any) { setError(e?.message || 'تعذر حذف الإعلان.'); }
  };

  return (
    <div className="space-y-5" dir="rtl">
      <div className="rounded-2xl bg-gradient-to-l from-emerald-800 to-slate-900 text-white p-5 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center"><Megaphone className="w-6 h-6" /></div>
          <div><h2 className="text-xl font-black">المذيع الصوتي</h2><p className="text-sm text-emerald-100 mt-1">اكتب عروض المحل وحوّلها إلى إعلانات صوتية محفوظة على هذا الجهاز</p></div>
        </div>
      </div>
      {!desktopApi && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-800">توليد الصوت يعمل من نسخة Electron على Windows فقط.</div>}
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 flex gap-2 items-start"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span></div>}
      <form onSubmit={createAnnouncement} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
        <div><label className="block text-sm font-bold mb-1 text-slate-700 dark:text-slate-200">اسم الإعلان (اختياري)</label><input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="مثال: عرض آخر الأسبوع" className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-sm" /></div>
        <div><div className="flex justify-between items-center mb-1"><label className="text-sm font-bold text-slate-700 dark:text-slate-200">نص العرض</label><span className="text-xs text-slate-500">{text.length}/700</span></div><textarea value={text} onChange={e => setText(e.target.value.slice(0,700))} rows={5} placeholder="أهلاً وسهلاً بحضراتكم... عرض خاص على منتجاتنا اليوم..." className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-sm leading-7 resize-y" /></div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !text.trim() || !desktopApi} className="rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-5 py-3 font-black flex items-center gap-2">{busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}{busy ? 'جاري توليد الصوت...' : 'توليد الصوت وإضافته للقائمة'}</button>
          {busy && <button type="button" onClick={() => void cancelGeneration()} className="rounded-xl bg-rose-600 hover:bg-rose-500 text-white px-5 py-3 font-bold flex items-center gap-2"><XCircle className="w-4 h-4" /> إلغاء التوليد</button>}
        </div>
        <p className="text-xs text-slate-500">يستخدم صوت Windows العربي المثبّت، ويحفظ ملفات WAV وقائمة التشغيل محلياً دون إرسال النص إلى الإنترنت.</p>
      </form>
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center"><h3 className="font-black flex items-center gap-2"><Volume2 className="w-5 h-5 text-emerald-600" /> قائمة التشغيل ({items.length})</h3><button type="button" onClick={() => void loadItems()} className="text-xs font-bold text-slate-500 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> تحديث</button></div>
        {items.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">لا توجد إعلانات صوتية محفوظة حتى الآن.</div> : <div className="divide-y divide-slate-100 dark:divide-slate-800">{items.map(item => <div key={item.id} className="p-4 flex items-center gap-3"><button type="button" onClick={() => void playItem(item)} className="w-10 h-10 shrink-0 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center" aria-label="تشغيل الإعلان"><Play className="w-4 h-4" /></button><div className="min-w-0 flex-1"><div className="font-bold text-sm truncate">{item.title}</div><p className="text-xs text-slate-500 line-clamp-2 mt-1">{item.text}</p><span className="text-[10px] text-slate-400">{new Date(item.createdAt).toLocaleString('ar-EG')}</span></div><button type="button" onClick={() => void removeItem(item)} className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg" aria-label="حذف الإعلان"><Trash2 className="w-4 h-4" /></button></div>)}</div>}
      </section>
      <audio ref={audioRef} src={audioUrl || undefined} controls className={audioUrl ? 'w-full' : 'hidden'} />
    </div>
  );
};
