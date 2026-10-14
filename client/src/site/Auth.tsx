import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Mark } from '../components/Icon';
import { Field, Img, Notice } from '../components/ui';
import { api, ApiError, useApi } from '../lib/api';
import { isStaff, useAuth, useShop, type User } from '../lib/context';
import { LangSwitch, useT } from '../lib/i18n';

function Shell({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede?: ReactNode; children: ReactNode }) {
  const { shop } = useShop();
  const { t } = useT();
  return (
    <div className="auth site on-ink" style={{ flexDirection: 'unset' }}>
      <div className="auth-art"><Img src="/images/beard.jpg" alt="" label="" /><blockquote>{t('Sit down. We will take it from here.')}</blockquote></div>
      <div className="auth-form">
        <div className="inner">
          <div className="row between" style={{ marginBottom: 40 }}>
            <Link to="/" className="brand"><Mark />{shop.settings.shop_name}</Link>
            <LangSwitch />
          </div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="display">{title}</h1>
          {lede && <p className="lede">{lede}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

function useLanding() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { setUser } = useAuth();
  return (user: User) => {
    setUser(user);
    const next = params.get('next');
    nav(next && next.startsWith('/') && !next.startsWith('//') ? next : isStaff(user) ? '/app' : '/account', { replace: true });
  };
}

function CodeStep({ email, devCode: initial, onDone }: { email: string; devCode?: string | null; onDone: (u: User) => void }) {
  const { t, err, lang } = useT();
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await api('/auth/verify', { body: { email, code } })).user);
    } catch (ex) {
      setError(err(ex));
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    const r = await api('/auth/resend', { body: { email, lang } }).catch(() => null);
    if (r?.devCode) setDevCode(r.devCode);
    setError(null);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted">{t('We sent a 6-digit code to')} <strong style={{ color: 'var(--ivory)' }} dir="ltr">{email}</strong>.</p>
      {devCode && <Notice tone="info">{t('Demo mode: email is not configured on this installation, so the code is shown here —')} <strong className="num">{devCode}</strong></Notice>}
      <Field label={t('Verification code')} error={error}><input className="input code-input" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
      <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length < 6}>{t('Verify & continue')}</button>
      <button type="button" className="link" style={{ justifySelf: 'start' }} onClick={() => void resend()}>{t('Send a new code')}</button>
    </form>
  );
}

export function Login() {
  const land = useLanding();
  const { shop } = useShop();
  const { t, rich, err } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<{ email: string; devCode?: string } | null>(null);
  const [params] = useSearchParams();

  const submit = async (e?: FormEvent, creds?: { email: string; password: string }) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      land((await api('/auth/login', { body: creds ?? { email, password } })).user);
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'NEEDS_VERIFICATION') setVerify({ email: ex.extra.email, devCode: ex.extra.devCode });
      else setError(err(ex));
    } finally {
      setBusy(false);
    }
  };

  if (verify) return <Shell eyebrow={t('One more step')} title={rich('Check your *inbox.*')}><CodeStep email={verify.email} devCode={verify.devCode} onDone={land} /></Shell>;
  const demo = [['Owner', 'owner@clubbarber.test', 'Owner#2026'], ['Barber', 'poste2@clubbarber.test', 'Barber#2026'], ['Customer', 'customer@clubbarber.test', 'Customer#2026']];
  return (
    <Shell eyebrow={t('Welcome back')} title={rich('Sign *in.*')} lede={t('Customers, barbers and the owner all sign in here.')}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="bad" icon="alert">{error}</Notice>}
        <Field label={t('Email')}><input className="input" type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('Password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</button>
        <div className="row between fw" style={{ fontSize: 14 }}>
          <Link className="link" to="/forgot">{t('Forgot password?')}</Link>
          <span className="muted">{t('New here?')} <Link className="link" to={`/register${params.get('next') ? `?next=${params.get('next')}` : ''}`}>{t('Create an account')}</Link></span>
        </div>
      </form>
      {shop.settings.demo_mode ? (
        <div className="demo-box" aria-label="Demo accounts">
          <span className="eyebrow">{t('Demo accounts (seeded data only)')}</span>
          {demo.map(([role, mail, pass]) => <button type="button" key={role} data-demo={role} onClick={() => void submit(undefined, { email: mail, password: pass })}><span>{t(role)}</span><span className="num" dir="ltr">{mail}</span></button>)}
        </div>
      ) : null}
    </Shell>
  );
}

export function Register() {
  const land = useLanding();
  const { t, rich, err, lang } = useT();
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<{ email: string; devCode?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/register', { body: { ...f, lang } });
      if (r.user) land(r.user);
      else setVerify({ email: r.email, devCode: r.devCode });
    } catch (ex) {
      setError(err(ex));
    } finally {
      setBusy(false);
    }
  };
  if (verify) return <Shell eyebrow={t('Almost there')} title={rich('Confirm your *email.*')}><CodeStep email={verify.email} devCode={verify.devCode} onDone={land} /></Shell>;
  const input = (k: keyof typeof f, props: Record<string, unknown>) => <input className="input" required value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />;
  return (
    <Shell eyebrow={t('Join the club')} title={rich('Create an *account.*')} lede={t('Keep your bookings in one place, reschedule in two taps and rebook your usual.')}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="bad" icon="alert">{error}</Notice>}
        <Field label={t('Full name')}>{input('name', { autoComplete: 'name', minLength: 2 })}</Field>
        <div className="form-grid cols-2">
          <Field label={t('Email')}>{input('email', { type: 'email', autoComplete: 'email', dir: 'ltr' })}</Field>
          <Field label={t('Phone')}>{input('phone', { type: 'tel', autoComplete: 'tel', placeholder: '+216 …', dir: 'ltr' })}</Field>
        </div>
        <Field label={t('Password')} hint={t('At least 8 characters.')}>{input('password', { type: 'password', autoComplete: 'new-password', minLength: 8, dir: 'ltr' })}</Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? t('Creating…') : t('Create account')}</button>
        <p className="muted" style={{ fontSize: 14 }}>{t('Already registered?')} <Link className="link" to="/login">{t('Sign in')}</Link></p>
      </form>
    </Shell>
  );
}

export function Forgot() {
  const { t, rich } = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await api('/auth/forgot', { body: { email } }).catch(() => ({}));
    setSent(r);
    setBusy(false);
  };
  return (
    <Shell eyebrow={t('Password help')} title={rich('Reset your *password.*')} lede={t('Enter your email and we will send you a link to choose a new one.')}>
      {sent ? (
        <div className="stack">
          <Notice tone="ok" icon="check">{t('If an account exists for {email}, a reset link is on its way.', { email })}</Notice>
          {sent.devLink && <Notice tone="info">{t('Demo mode: email is not configured, so here is the link —')} <a className="link" href={sent.devLink}>{t('open reset page')}</a></Notice>}
          <Link className="link" to="/login" style={{ justifySelf: 'start' }}>{t('Back to sign in')}</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <Field label={t('Email')}><input className="input" type="email" dir="ltr" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{t('Send reset link')}</button>
          <Link className="link" to="/login" style={{ justifySelf: 'start' }}>{t('Back to sign in')}</Link>
        </form>
      )}
    </Shell>
  );
}

/** Shared by password reset links and staff invitations. */
export function SetPassword({ mode }: { mode: 'reset' | 'invite' }) {
  const { token = '' } = useParams();
  const land = useLanding();
  const { t, rich, err } = useT();
  const invite = useApi<{ name: string; email: string }>(mode === 'invite' ? `/auth/invite/${token}` : null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (invite.error) setError(err(invite.error));
  }, [invite.error, err]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError(t('The two passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      land((await api(mode === 'invite' ? '/auth/invite/accept' : '/auth/reset', { body: { token, password } })).user);
    } catch (ex) {
      setError(err(ex));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell eyebrow={mode === 'invite' ? t('Staff invitation') : t('Password help')} title={mode === 'invite' ? rich('Welcome to the *team.*') : rich('Choose a new *password.*')}
      lede={mode === 'invite' && invite.data ? t('Hi {name} — set a password for {email} to open your schedule.', invite.data) : undefined}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="bad" icon="alert">{error}</Notice>}
        <Field label={t('New password')} hint={t('At least 8 characters.')}><input className="input" type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label={t('Repeat password')}><input className="input" type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || (mode === 'invite' && !!invite.error)}>{t('Save password & sign in')}</button>
      </form>
    </Shell>
  );
}
