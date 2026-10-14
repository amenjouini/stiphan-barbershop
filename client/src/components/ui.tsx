import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useT, tr } from '../lib/i18n';
import { useFmt, useToast } from '../lib/context';
import { STATUS_LABEL, type Status } from '../../../shared/constants';
import { Icon } from './Icon';

/** Image that falls back to a local monogram tile if the file is missing or fails to load. */
export function Img({ src, alt, label, className = '' }: { src?: string | null; alt: string; label?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const initials = (label ?? alt).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className={`img ${className}`}>
      {src && !failed ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <div className="img-fallback" role="img" aria-label={alt}>{initials}</div>}
    </div>
  );
}

// Open overlays, innermost last: Escape only closes the top one, and the page stays locked until all are closed.
const overlayStack: symbol[] = [];

function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const me = Symbol('overlay');
    overlayStack.push(me);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && overlayStack[overlayStack.length - 1] === me && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      overlayStack.splice(overlayStack.indexOf(me), 1);
      if (!overlayStack.length) document.body.style.overflow = '';
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useOverlay(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={tr("Close")}><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, head }: { title: string; onClose: () => void; children: ReactNode; head?: ReactNode }) {
  const ref = useOverlay(onClose);
  return (
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <div className="grow">{head ?? <h2 className="h2">{title}</h2>}</div>
          <button className="icon-btn" onClick={onClose} aria-label={tr("Close")}><Icon name="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function Field({ label, error, hint, children, className = '' }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className}`}>
      <label><span className="label">{label}</span>{children}</label>
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** Text input for amounts; the parent keeps the raw string and parses it with fmt.parse(). */
export function MoneyInput({ value, onChange, autoFocus, id }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; id?: string }) {
  const fmt = useFmt();
  return (
    <div className="input-affix">
      <input id={id} className="input num" inputMode="decimal" autoComplete="off" autoFocus={autoFocus} value={value} placeholder={fmt.plain(0)} onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ''))} />
      <span>{fmt.currency}</span>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { pending: 'warn', confirmed: 'info', checked_in: 'dark', in_progress: 'dark', completed: 'ok', cancelled: '', no_show: 'bad' };
export function StatusBadge({ status }: { status: string }) {
  const { t } = useT();
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{t(STATUS_LABEL[status as Status] ?? status)}</span>;
}

const PAY: Record<string, [string, string]> = { unpaid: ['Unpaid', 'warn'], partial: ['Part paid', 'warn'], paid: ['Paid', 'ok'], refund_due: ['Refund due', 'bad'] };
export function PayBadge({ status, appointmentStatus }: { status: string; appointmentStatus?: string }) {
  const { t } = useT();
  // An unpaid future booking is not a debt yet, so it is shown neutrally.
  if (status === 'unpaid' && appointmentStatus && appointmentStatus !== 'completed') return <span className="badge plain">{t('Not paid yet')}</span>;
  const [label, tone] = PAY[status] ?? [status, ''];
  return <span className={`badge ${tone}`}>{t(label)}</span>;
}

export function Loading({ label = tr("Loading") }: { label?: string }) {
  const { t } = useT();
  return <div className="loading" role="status"><div className="spinner" /><span>{t(label)}…</span></div>;
}

export function Empty({ icon = 'calendar', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={34} /><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t, err } = useT();
  return (
    <div className="empty"><Icon name="alert" size={34} /><h3>{t('That did not load.')}</h3><p>{err(error)}</p>
      {retry && <button className="btn btn-ghost btn-sm" onClick={retry}>{t('Try again')}</button>}
    </div>
  );
}

/** Standard async states for a `useApi` result. */
export function Async<T>({ state, children, label }: { state: { data: T | null; error: unknown; loading: boolean; reload: () => void }; children: (data: T) => ReactNode; label?: string }) {
  if (state.data) return <>{children(state.data)}</>;
  if (state.error) return <ErrorState error={state.error} retry={state.reload} />;
  return <Loading label={label} />;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total ? <div className="pager"><span className="muted">{total} {total === 1 ? 'record' : 'records'}</span></div> : null;
  return (
    <div className="pager">
      <span className="muted">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} {tr("of")}{' '}{total}</span>
      <div className="row">
        <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="left" size={14} />{tr("Prev")}</button>
        <span className="num">{page} / {pages}</span>
        <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>{tr("Next")}<Icon name="right" size={14} /></button>
      </div>
    </div>
  );
}

export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return <span className="stars" aria-label={`${value} ${tr("out of 5")}`}>{[1, 2, 3, 4, 5].map((n) => <Icon key={n} name={n <= Math.round(value) ? 'star-fill' : 'star'} size={size} />)}</span>;
}

/** Runs an async action with busy/error state and optional success toast. */
export function useAction() {
  const toast = useToast();
  const { err } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      if (success) toast(success, 'success');
      return out;
    } catch (e) {
      setError(err(e));
      if (!(e instanceof ApiError) || e.status >= 500 || e.status === 0) toast(err(e), 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast, err]);
  return { busy, error, setError, run };
}

/** Small modal asking for a reason before a sensitive action (cancel, void...). */
export function ReasonModal({ title, text, label = tr("Reason"), confirm, required, danger, onClose, onSubmit }: {
  title: string; text?: ReactNode; label?: string; confirm: string; required?: boolean; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const act = useAction();
  const { t } = useT();
  const submit = () => act.run(async () => {
    await onSubmit(reason.trim());
    onClose();
  });
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Keep as is')}</button>
      <button className={`btn ${danger ? 'btn-danger' : 'btn-dark'}`} disabled={act.busy || (required && reason.trim().length < 3)} onClick={submit}>{confirm}</button>
    </>}>
      <div className="stack">
        {text && <p>{text}</p>}
        <Field label={t(label) + (required ? '' : ` ${t('(optional)')}`)} error={act.error}>
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

export const Notice = ({ tone = '', icon = 'info', children }: { tone?: 'info' | 'bad' | 'ok' | ''; icon?: string; children: ReactNode }) =>
  <div className={`notice ${tone}`}><Icon name={icon} size={16} /><div>{children}</div></div>;
