import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AppointmentDrawer } from '../components/AppointmentDrawer';
import { Icon, Mark } from '../components/Icon';
import { NewAppointment, type NewPrefill } from '../components/NewAppointment';
import { Loading } from '../components/ui';
import { useApi } from '../lib/api';
import { isStaff, useAuth, useShop } from '../lib/context';
import { LangSwitch, tr, useT } from '../lib/i18n';

export interface TeamBarber { id: number; name: string; photo_url: string | null; is_active: number; service_ids: number[] }
export interface TeamService { id: number; name: string; price_minor: number; duration_min: number; category: string | null }
interface AppUI {
  team: { barbers: TeamBarber[]; services: TeamService[]; my_barber_id: number | null };
  isOwner: boolean;
  /** Bumped after any change so open lists and calendars reload. */
  stamp: number;
  touch: () => void;
  openAppointment: (id: number) => void;
  newAppointment: (prefill?: NewPrefill) => void;
}
const Ctx = createContext<AppUI | null>(null);
export const useApp = () => useContext(Ctx)!;

/** useApi that also reloads whenever something changed elsewhere in the dashboard. */
export function useLive<T = any>(path: string | null) {
  const { stamp } = useApp();
  const state = useApi<T>(path);
  useEffect(() => {
    if (stamp) void state.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  return state;
}

const CHAIR = [['/app/today', 'Today', 'chair'], ['/app/schedule', 'My schedule', 'calendar'], ['/app/earnings', 'My earnings', 'coins']];
const SHOP = [['/app/overview', 'Overview', 'home'], ['/app/calendar', 'Shop calendar', 'calendar'], ['/app/appointments', 'Appointments', 'list'], ['/app/customers', 'Customers', 'users']];
const MONEY = [['/app/payments', 'Payments', 'receipt'], ['/app/payroll', 'Barber pay', 'wallet'], ['/app/expenses', 'Expenses', 'tag'], ['/app/reports', 'Reports', 'chart']];
const SETUP = [['/app/team', 'Team', 'scissors'], ['/app/services', 'Services', 'razor'], ['/app/reviews', 'Reviews', 'star'], ['/app/outbox', 'Email outbox', 'mail'], ['/app/activity', 'Activity log', 'history'], ['/app/settings', 'Settings', 'settings']];

export function AppLayout() {
  const { user, ready, logout } = useAuth();
  const { shop } = useShop();
  const { lang } = useT();
  const loc = useLocation();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [menu, setMenu] = useState(false);
  const [stamp, setStamp] = useState(0);
  const [apptId, setApptId] = useState<number | null>(null);
  const [creating, setCreating] = useState<NewPrefill | null>(null);
  const team = useApi<AppUI['team']>(isStaff(user) ? '/staff/team' : null);
  const touch = useCallback(() => setStamp((n) => n + 1), []);

  useEffect(() => setMenu(false), [loc.pathname]);
  // Deep link from emails: /app/appointments?open=123
  useEffect(() => {
    const open = Number(params.get('open'));
    if (open) {
      setApptId(open);
      params.delete('open');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (stamp) void team.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const value = useMemo<AppUI | null>(() => team.data && user ? {
    team: team.data, isOwner: user.role === 'owner', stamp, touch,
    openAppointment: setApptId, newAppointment: (p) => setCreating(p ?? {}),
  } : null, [team.data, user, stamp, touch]);

  if (!ready) return <div className="boot"><div className="spinner" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (!isStaff(user)) return <Navigate to="/account" replace />;
  if (!value) return <div className="boot" style={{ background: 'var(--paper)', color: 'var(--ink)' }}>{team.error ? <p>{team.error.message}</p> : <Loading />}</div>;

  const owner = user.role === 'owner';
  const group = (title: string, items: string[][]) => (
    <>
      <h5>{tr(title)}</h5>
      {items.map(([to, label, icon]) => <NavLink key={to} to={to} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}><Icon name={icon} />{tr(label)}</NavLink>)}
    </>
  );

  return (
    <Ctx.Provider value={value}>
      <div className="app" key={lang}>
        {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}
        <aside className={`side ${menu ? 'open' : ''}`}>
          <Link to="/" className="brand" title={tr("Open the public website")}><Mark size={24} />{shop.settings.shop_name}</Link>
          <nav aria-label={tr("Dashboard")}>
            {user.barberId && group(tr("My chair"), CHAIR)}
            {owner && group(tr("Shop"), SHOP)}
            {owner && group(tr("Money"), MONEY)}
            {owner && group(tr("Setup"), SETUP)}
            <h5>{tr("More")}</h5>
            <Link to="/" className="nav"><Icon name="external" />{tr("Public website")}</Link>
            <div style={{ padding: '14px 10px 4px' }}><LangSwitch /></div>
          </nav>
          <div className="me">
            <div className="avatar">{user.name[0]}</div>
            <div className="grow"><b>{user.name}</b><small>{owner ? tr("Owner") : tr("Barber")}</small></div>
            <button className="icon-btn" title={tr("Sign out")} aria-label={tr("Sign out")} onClick={async () => { await logout(); nav('/login'); }}><Icon name="logout" /></button>
          </div>
        </aside>
        <div className="app-main">
          <div className="app-bar">
            <button className="icon-btn" aria-label={tr("Open menu")} onClick={() => setMenu(true)}><Icon name="menu" size={22} /></button>
            <span className="brand grow"><Mark size={22} />{shop.settings.shop_name}</span>
            <LangSwitch />
            <button className="btn btn-primary btn-sm" onClick={() => setCreating({})}><Icon name="plus" size={14} />{tr("New")}</button>
          </div>
          <div className="app-content"><Outlet /></div>
        </div>
      </div>
      {apptId && <AppointmentDrawer key={lang} id={apptId} onClose={() => setApptId(null)} />}
      {creating && <NewAppointment key={lang} prefill={creating} onClose={() => setCreating(null)} />}
    </Ctx.Provider>
  );
}

export function AppIndex() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'owner' ? '/app/overview' : '/app/today'} replace />;
}

/** Wraps owner-only pages; barbers are sent back to their own chair. */
export function OwnerOnly({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  return user?.role === 'owner' ? children : <Navigate to="/app/today" replace />;
}
