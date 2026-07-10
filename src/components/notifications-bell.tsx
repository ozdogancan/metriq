'use client';
// Metriq — bildirim çanı: uygulama-içi liste + masaüstü (web push) aboneliği.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AppNotification } from '@/lib/types';
import type { Lang } from '@/lib/i18n';

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
    refresh();
    const iv = setInterval(refresh, 25_000);
    return () => clearInterval(iv);
  }, [refresh]);

  // push durumu tespiti
  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setPushState('unsupported'); return; }
      if (Notification.permission === 'denied') { setPushState('denied'); return; }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        setPushState(sub ? 'on' : 'off');
      } catch { setPushState('off'); }
    })();
  }, []);

  // dışarı tıklayınca kapan
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
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

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPushState(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key) as BufferSource,
      });
      await fetch('/api/push', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      setPushState('on');
    } catch { /* sessiz */ }
  }

  const KIND_DOT: Record<string, string> = {
    run_done: 'var(--color-mint)', run_error: 'var(--color-danger)', system: 'var(--color-steel)',
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button onClick={toggleOpen} aria-label="notifications"
        className={`btn btn-ghost !px-2.5 relative ${open ? '!text-ink !border-line' : ''}`}
        title={lang === 'tr' ? 'Bildirimler' : 'Notifications'}>
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
        <div className="panel panel-corners absolute right-0 top-11 z-30 w-[340px] overflow-hidden shadow-2xl shadow-black/30">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[12px] font-semibold">{lang === 'tr' ? 'Bildirimler' : 'Notifications'}</span>
            {pushState !== 'unsupported' && (
              pushState === 'on' ? (
                <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-mint)' }} />{lang === 'tr' ? 'masaüstü açık' : 'desktop on'}</span>
              ) : pushState === 'denied' ? (
                <span className="chip text-muted">{lang === 'tr' ? 'tarayıcıdan engelli' : 'blocked'}</span>
              ) : (
                <button onClick={enablePush} className="chip transition-colors hover:border-copper/50 hover:text-copper-bright">
                  {lang === 'tr' ? '🖥 masaüstü bildirimlerini aç' : '🖥 enable desktop'}
                </button>
              )
            )}
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            {items.length === 0 && (
              <div className="px-4 py-8 text-center text-[12px] text-muted">
                {lang === 'tr' ? 'Henüz bildirim yok.' : 'No notifications yet.'}
              </div>
            )}
            {items.map(n => (
              <button key={n.id}
                onClick={() => { setOpen(false); router.push(n.url); }}
                className="flex w-full items-start gap-2.5 border-b border-line/50 px-4 py-3 text-left transition-colors last:border-0 hover:bg-copper/5">
                <span className="chip-dot mt-1.5 shrink-0" style={{ background: KIND_DOT[n.kind] ?? 'var(--color-steel)' }} />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[12.5px] leading-snug ${n.read ? 'text-muted' : 'font-semibold'}`}>{n.title}</span>
                  {n.body && <span className="mt-0.5 block truncate text-[11.5px] text-muted">{n.body}</span>}
                </span>
                <span className="shrink-0 font-data text-[10px] text-muted">{timeAgo(n.createdAt, lang)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
