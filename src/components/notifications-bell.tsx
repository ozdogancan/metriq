'use client';
// Metriq — bildirim çanı: uygulama-içi liste + masaüstü (web push) aboneliği.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { AppNotification } from '@/lib/types';
import { t, type Lang } from '@/lib/i18n';

function timeAgo(iso: string, lang: Lang): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return lang === 'tr' ? 'şimdi' : 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${lang === 'tr' ? ' dk' : 'm'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${lang === 'tr' ? ' sa' : 'h'}`;
  return `${Math.floor(h / 24)}${lang === 'tr' ? ' gün' : 'd'}`;
}

function b64ToUint8(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function NotificationsBell({ lang }: { lang: Lang }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on' | 'denied'>('off');
  const [pushErr, setPushErr] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      setItems(d.items ?? []);
      setUnread(d.unread ?? 0);
    } catch { /* sessiz */ }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    // sekme gizliyken poll atlanır; görünür olunca hemen bir kez çekilir
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, 25_000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(initial); clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  // push durumu tespiti + KENDİ KENDİNİ ONARMA: yerel abonelik varsa sunucuya
  // yeniden yazılır (upsert) — sunucudaki kayıt temizlenmişse "açık ama
  // çalışmıyor" durumu sessizce iyileşir.
  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setPushState('unsupported'); return; }
      if (Notification.permission === 'denied') { setPushState('denied'); return; }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        setPushState(sub ? 'on' : 'off');
        if (sub) {
          fetch('/api/push', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
          }).catch(() => { /* sıradaki açılışta tekrar dener */ });
        }
      } catch { setPushState('off'); }
    })();
  }, []);

  // dışarı tıklayınca / Escape ile kapan
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await fetch('/api/notifications', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markRead: 'all' }),
      }).catch(() => {});
      setUnread(0);
      setItems(prev => prev.map(n => ({ ...n, read: true })));
    }
  }

  // silme: iyimser güncelle, hata olursa listeyi tazele
  async function removeOne(id: string) {
    setItems(prev => prev.filter(n => n.id !== id));
    const r = await fetch('/api/notifications', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => null);
    if (!r || !r.ok) refresh();
  }

  async function removeAll() {
    setItems([]);
    setUnread(0);
    const r = await fetch('/api/notifications', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: 'all' }),
    }).catch(() => null);
    if (!r || !r.ok) refresh();
  }

  async function enablePush() {
    setPushErr('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPushState(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) { setPushErr(t(lang, 'push_error')); return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key) as BufferSource,
      });
      const res = await fetch('/api/push', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) { setPushErr(t(lang, 'push_error')); return; }
      setPushState('on');
      toast.success(lang === 'tr' ? 'Masaüstü bildirimleri açıldı.' : 'Desktop notifications enabled.');
    } catch {
      // sessiz başarısızlık yerine panelde küçük hata metni
      setPushErr(t(lang, 'push_error'));
    }
  }

  // Kapat: yerel aboneliği iptal et + sunucudaki kaydı sil
  async function disablePush() {
    setPushErr('');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await fetch('/api/push', {
          method: 'DELETE', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => { /* sunucu kaydı bir sonraki gönderimde 410 ile temizlenir */ });
      }
      setPushState('off');
      toast.success(lang === 'tr' ? 'Masaüstü bildirimleri kapatıldı.' : 'Desktop notifications disabled.');
    } catch {
      setPushErr(t(lang, 'push_error'));
    }
  }

  // Test: force'lu gerçek push — sekmeye bakarken bile OS bildirimi düşer
  async function sendTestPush() {
    setPushErr('');
    try {
      const r = await fetch('/api/push/test', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (d.subscriptions === 0) {
        setPushErr(lang === 'tr'
          ? 'Sunucuda abonelik bulunamadı — kapatıp yeniden aç.'
          : 'No subscription on the server — turn off and re-enable.');
        return;
      }
      toast.success(lang === 'tr'
        ? 'Test gönderildi — birkaç saniye içinde masaüstü bildirimi düşmeli.'
        : 'Test sent — a desktop notification should appear within seconds.');
    } catch {
      setPushErr(t(lang, 'push_error'));
    }
  }

  const KIND_DOT: Record<string, string> = {
    run_done: 'var(--color-mint)', run_error: 'var(--color-danger)', system: 'var(--color-steel)',
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button onClick={toggleOpen}
        aria-label={t(lang, 'notifications')} aria-haspopup="menu" aria-expanded={open}
        className={`btn btn-ghost !px-2 sm:!px-2.5 relative ${open ? '!text-ink !border-line' : ''}`}
        title={t(lang, 'notifications')}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-copper px-1 font-data text-[9px] font-bold text-[#0b0e13]">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="menu" aria-label={t(lang, 'notifications')}
          className="panel panel-corners absolute right-0 top-11 z-30 w-[340px] overflow-hidden shadow-2xl shadow-black/30">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <span className="text-[12px] font-semibold">{t(lang, 'notifications')}</span>
            {items.length > 0 && (
              <button onClick={removeAll}
                className="ml-auto font-data text-[10.5px] tracking-wide text-muted transition-colors hover:text-danger"
                title={lang === 'tr' ? 'Tüm bildirimleri sil' : 'Delete all notifications'}>
                {lang === 'tr' ? 'tümünü temizle' : 'clear all'}
              </button>
            )}
          </div>
          {/* masaüstü bildirim şeridi: durum + aç/kapat + test */}
          {pushState !== 'unsupported' && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
              <span className="font-data text-[10.5px] text-muted">🖥 {lang === 'tr' ? 'Masaüstü' : 'Desktop'}</span>
              {pushState === 'on' ? (
                <>
                  <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-mint)' }} />{lang === 'tr' ? 'açık' : 'on'}</span>
                  <button onClick={sendTestPush}
                    className="chip transition-colors hover:border-copper/50 hover:text-copper-bright"
                    title={lang === 'tr' ? 'Şimdi bir test bildirimi gönder — çalıştığını gör' : 'Send a test notification now'}>
                    {lang === 'tr' ? 'test gönder' : 'send test'}
                  </button>
                  <button onClick={disablePush}
                    className="chip ml-auto text-muted transition-colors hover:border-danger/50 hover:text-danger"
                    title={lang === 'tr' ? 'Masaüstü bildirimlerini kapat' : 'Turn off desktop notifications'}>
                    {lang === 'tr' ? 'kapat' : 'turn off'}
                  </button>
                </>
              ) : pushState === 'denied' ? (
                <span className="font-data text-[10.5px] text-muted">
                  {lang === 'tr'
                    ? 'tarayıcıdan engelli — adres çubuğundaki kilit ikonundan bildirim iznini aç'
                    : 'blocked by the browser — allow notifications from the address-bar lock icon'}
                </span>
              ) : (
                <button onClick={enablePush} className="chip transition-colors hover:border-copper/50 hover:text-copper-bright">
                  {lang === 'tr' ? 'aç' : 'enable'}
                </button>
              )}
              {pushState === 'on' && (
                <span className="w-full font-data text-[9.5px] leading-snug text-muted">
                  {lang === 'tr'
                    ? 'Not: uygulamaya bakarken OS bildirimi bastırılır (çan yeter) — sekme kapalı/arka plandayken düşer.'
                    : 'Note: while you are viewing the app, OS notifications are suppressed (the bell suffices) — they appear when the tab is closed/in background.'}
                </span>
              )}
            </div>
          )}
          {/* masaüstü bildirim açma başarısız olursa panelde küçük kırmızı metin */}
          {pushErr && (
            <div className="border-b border-line px-4 py-2 text-[11px] text-danger" role="alert">
              {pushErr}
            </div>
          )}
          <div className="max-h-[min(380px,60vh)] overflow-y-auto">
            {items.length === 0 && (
              <div className="px-4 py-8 text-center text-[12px] text-muted">
                {lang === 'tr' ? 'Henüz bildirim yok.' : 'No notifications yet.'}
              </div>
            )}
            {items.map(n => (
              <div key={n.id} className="group relative border-b border-line/50 last:border-0">
                <button role="menuitem"
                  onClick={() => { setOpen(false); router.push(n.url); }}
                  className="flex w-full items-start gap-2.5 px-4 py-3 pr-9 text-left transition-colors hover:bg-copper/5">
                  <span className="chip-dot mt-1.5 shrink-0" style={{ background: KIND_DOT[n.kind] ?? 'var(--color-steel)' }} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[12.5px] leading-snug ${n.read ? 'text-muted' : 'font-semibold'}`}>{n.title}</span>
                    {n.body && <span className="mt-0.5 block truncate text-[11.5px] text-muted">{n.body}</span>}
                  </span>
                  <span className="shrink-0 font-data text-[10px] text-muted">{timeAgo(n.createdAt, lang)}</span>
                </button>
                {/* hover'da beliren sil düğmesi — klavyeden de erişilir (focus-visible) */}
                <button onClick={() => removeOne(n.id)}
                  aria-label={lang === 'tr' ? `bildirimi sil: ${n.title}` : `delete notification: ${n.title}`}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[13px] leading-none text-muted opacity-0 transition-opacity hover:!text-danger focus-visible:opacity-100 group-hover:opacity-100">
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
