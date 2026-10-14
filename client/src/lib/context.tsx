import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useT } from './i18n';
import { formatMoney, fromMinor, toMinor } from '../../../shared/money';
import { fmtDate, fmtDateTime, fmtTime, today, zoned } from '../../../shared/time';

// ---------- Types ----------
export interface Service { id: number; name: string; description: string; category: string | null; price_minor: number; duration_min: number; image_url: string | null }
export interface Barber { id: number; name: string; bio: string; specialty: string; photo_url: string | null; service_ids: number[]; hours: { weekday: number; start_min: number; end_min: number }[] }
export interface Shop {
  settings: Record<string, any>;
  business_hours: { weekday: number; open_min: number; close_min: number; is_closed: number }[];
  services: Service[];
  barbers: Barber[];
  reviews: { rating: number; comment: string; customer_name: string; barber_name: string; created_at: number }[];
  rating: { count: number; average: number | null };
}
export interface User { id: number; role: 'owner' | 'barber' | 'customer'; name: string; email: string; phone: string | null; barberId: number | null; customerId: number | null }

// ---------- Shop (public business data + formatters) ----------
interface ShopCtx { shop: Shop; reload: () => Promise<void>; fmt: ReturnType<typeof makeFmt> }
const ShopContext = createContext<ShopCtx | null>(null);

function makeFmt(s: Record<string, any>, locale = 'fr-FR') {
  const tz: string = s.timezone, cur: string = s.currency, dec: number = s.currency_decimals;
  const arabic = locale.startsWith('ar');
  // Calendar pieces for a local date string or an instant, in the visitor's language.
  const piece = (v: number | string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: typeof v === 'string' ? 'UTC' : tz }).format(new Date(typeof v === 'string' ? Date.parse(v + 'T12:00:00Z') : v));
  return {
    tz, currency: cur, decimals: dec,
    money: (minor: number) => formatMoney(minor ?? 0, cur, dec),
    plain: (minor: number) => fromMinor(minor ?? 0, dec),
    parse: (input: string) => toMinor(input, dec),
    time: (ms: number) => fmtTime(ms, tz),
    date: (v: number | string, style: 'long' | 'medium' | 'short' = 'medium') => fmtDate(v, tz, style, locale),
    dateTime: (ms: number) => fmtDateTime(ms, tz, locale),
    dow: (v: number | string, style: 'short' | 'long' = 'short') => piece(v, { weekday: style }),
    month: (v: number | string, style: 'short' | 'long' = 'short') => piece(v, { month: style }),
    monthYear: (v: number | string) => piece(v, { month: 'long', year: 'numeric' }),
    dayNum: (v: number | string) => piece(v, { day: 'numeric' }),
    duration: (min: number) => {
      const h = Math.floor(min / 60), r = min % 60;
      if (arabic) return h ? (r ? `${h} س ${r} د` : `${h} س`) : `${min} د`;
      return h ? (r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`) : `${min} min`;
    },
    today: () => today(tz),
    dayOf: (ms: number) => zoned(ms, tz).date,
    minutesOf: (ms: number) => zoned(ms, tz).minutes,
  };
}

export function ShopProvider({ children }: { children: ReactNode }) {
  const { locale, setFallback } = useT();
  const [shop, setShop] = useState<Shop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const data = await api<Shop>('/public/shop');
      setFallback(data.settings.default_language);
      setShop(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [setFallback]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const value = useMemo(() => (shop ? { shop, reload, fmt: makeFmt(shop.settings, locale) } : null), [shop, reload, locale]);
  useEffect(() => {
    if (shop) document.title = `${shop.settings.shop_name} — Book your chair`;
  }, [shop]);
  if (!value) {
    return (
      <div className="boot on-ink">
        {error ? (
          <div className="empty"><h3>We could not load the shop.</h3><p>{error}</p><button className="btn btn-primary" onClick={() => void reload()}>Try again</button></div>
        ) : <div className="spinner" aria-label="Loading" />}
      </div>
    );
  }
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export const useShop = () => useContext(ShopContext)!;
export const useFmt = () => useContext(ShopContext)!.fmt;

// ---------- Auth ----------
interface AuthCtx { user: User | null; ready: boolean; setUser: (u: User | null) => void; refresh: () => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setUser((await api<{ user: User | null }>('/auth/me')).user);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setUser(null);
  }, []);
  return <AuthContext.Provider value={{ user, ready, setUser, refresh, logout }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext)!;
/** First name for friendly labels; names like "Poste 2" are kept whole. */
export const shortName = (name: string) => (/\d\s*$/.test(name) ? name : name.split(' ')[0]);
export const isStaff = (u: User | null) => u?.role === 'owner' || u?.role === 'barber';

// ---------- Toasts ----------
type ToastKind = 'info' | 'success' | 'error';
const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list.slice(-3), { id, message, kind }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 6500 : 3800);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
