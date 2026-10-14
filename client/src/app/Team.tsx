import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Async, Empty, Field, Img, Modal, MoneyInput, Notice, ReasonModal, useAction } from '../components/ui';
import { api } from '../lib/api';
import { useFmt, useShop, useToast } from '../lib/context';
import { COMP_BASES, COMP_BASIS_LABEL, COMP_LABEL, COMP_MODELS, type CompBasis, type CompModel } from '../../../shared/constants';
import { fmtMinutes, parseMinutes, WEEKDAYS } from '../../../shared/time';
import { useApp, useLive } from './AppLayout';
import { Ledger, ruleText } from './Chair';
import { PayoutModal } from './Money';
import { PageHead, TimeOffCard } from './shared';
import { tr } from '../lib/i18n';

/** Picks an image, downsizes it in the browser and uploads it; returns the stored URL. */
export function PhotoField({ value, onChange, label, name }: { value: string | null; onChange: (url: string | null) => void; label: string; name: string }) {
  const input = useRef<HTMLInputElement>(null);
  const act = useAction();
  const pick = (file: File) => act.run(async () => {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const r = await api('/admin/uploads', { body: { dataUrl: canvas.toDataURL('image/jpeg', 0.84) } });
    onChange(r.url);
  });
  return (
    <div className="stack tight">
      <span className="label">{label}</span>
      <div className="photo-edit">
        <Img src={value} alt="" label={name || '?'} />
        <div className="stack tight">
          <div className="row fw">
            <button type="button" className="btn btn-ghost btn-sm" disabled={act.busy} onClick={() => input.current?.click()}><Icon name="camera" size={14} />{act.busy ? tr("Uploading…") : value ? tr("Replace") : tr("Upload")}</button>
            {value && <button type="button" className="link" onClick={() => onChange(null)}>{tr("Remove")}</button>}
          </div>
          <span className="field-hint">{tr("JPEG, PNG or WebP. A local placeholder is shown when there is no photo.")}</span>
          {act.error && <span className="field-error">{act.error}</span>}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
      </div>
    </div>
  );
}

function ServiceChecks({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { team } = useApp();
  return (
    <div className="stack tight">
      <div className="row between"><span className="label">{tr("Services offered")}</span><button type="button" className="link" onClick={() => onChange(value.length === team.services.length ? [] : team.services.map((s) => s.id))}>{value.length === team.services.length ? tr("Clear all") : tr("Select all")}</button></div>
      <div className="svc-pick">
        {team.services.map((s) => <button type="button" key={s.id} aria-pressed={value.includes(s.id)} onClick={() => onChange(value.includes(s.id) ? value.filter((x) => x !== s.id) : [...value, s.id])}><span>{s.name}</span><small>{s.duration_min}′</small></button>)}
      </div>
    </div>
  );
}

function InviteNotice({ url, emailed }: { url: string; emailed?: boolean }) {
  const toast = useToast();
  const { shop } = useShop();
  const sent = emailed ?? !shop.settings.email_simulated;
  return (
    <Notice tone="info" icon="mail">
      {sent ? tr("An invitation email has been sent.") : tr("Email is in demo mode, so the invitation was not delivered.")} {tr("Share this one-time link (valid 72 h) so they can set a password:")}
      <div className="row" style={{ marginTop: 8 }}><span className="code grow">{url}</span><button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(url); toast(tr("Link copied."), 'success'); }}>{tr("Copy")}</button></div>
    </Notice>
  );
}

export function Team() {
  const fmt = useFmt();
  const nav = useNavigate();
  const state = useLive<{ barbers: any[] }>('/admin/barbers');
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title={tr("Team")} sub={tr("Profiles, logins, working hours and pay arrangements. Deactivating a barber keeps all of their history.")}>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} />{tr("Add barber")}</button>
      </PageHead>
      <div className="card">
        <Async state={state}>{(d) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tr("Barber")}</th><th>{tr("Status")}</th><th className="hide-sm">{tr("Login")}</th><th className="hide-sm">{tr("Arrangement")}</th><th className="r">{tr("Upcoming")}</th><th className="r">{tr("Owed")}</th></tr></thead>
            <tbody>{d.barbers.map((b) => (
              <tr key={b.id} className="click" onClick={() => nav(`/app/team/${b.id}`)}>
                <td><div className="person"><Img src={b.photo_url} alt="" label={b.name} /><div><b>{b.name}</b><small>{b.specialty || tr("No specialty set")}</small></div></div></td>
                <td><span className={`badge ${b.is_active ? 'ok' : ''}`}>{b.is_active ? tr("Active") : tr("Inactive")}</span></td>
                <td className="hide-sm">{b.account ? (b.account.role === 'owner' ? tr("Owner account") : b.account.has_password ? b.account.email : tr("Invited — no password yet")) : <span className="muted">{tr("No login")}</span>}</td>
                <td className="hide-sm">{tr(COMP_LABEL[(b.rule?.model ?? 'none') as CompModel])}</td>
                <td className="r num">{b.upcoming}</td><td className="r num">{fmt.money(b.balance.owed_minor)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}</Async>
      </div>
      {adding && <NewBarber onClose={() => setAdding(false)} />}
    </>
  );
}

function NewBarber({ onClose }: { onClose: () => void }) {
  const { team, touch } = useApp();
  const nav = useNavigate();
  const act = useAction();
  const [f, setF] = useState({ name: '', email: '', phone: '', specialty: '', bio: '', photo_url: null as string | null, create_login: true });
  const [services, setServices] = useState(team.services.map((s) => s.id));
  const [created, setCreated] = useState<{ id: number; invite_url?: string } | null>(null);
  if (created) {
    return (
      <Modal title={`${f.name} ${tr("has been added")}`} onClose={() => { onClose(); nav(`/app/team/${created.id}`); }} footer={<button className="btn btn-dark" onClick={() => { onClose(); nav(`/app/team/${created.id}`); }}>{tr("Set hours & pay")}</button>}>
        <div className="stack">
          {created.invite_url ? <InviteNotice url={created.invite_url} /> : <Notice tone="info">{tr("No login was created. You can invite them later from their profile.")}</Notice>}
          <p className="muted">{tr("They start with the shop's opening hours and no automatic compensation. Set both on the next screen.")}</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal wide title={tr("Add a barber")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={act.busy || f.name.trim().length < 2 || (f.create_login && !f.email)} onClick={() => act.run(async () => {
        const r = await api('/admin/barbers', { body: { ...f, name: f.name.trim(), service_ids: services } });
        touch();
        setCreated(r);
      })}>{tr("Add barber")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <div className="form-grid cols-2">
          <Field label={tr("Full name")}><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={tr("Specialty")}><input className="input" value={f.specialty} maxLength={120} onChange={(e) => setF({ ...f, specialty: e.target.value })} placeholder={tr("e.g. Skin fades & beard design")} /></Field>
          <Field label={tr("Email")}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={tr("Phone")}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <Field label={tr("Short biography")}><textarea className="textarea" maxLength={800} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
        <PhotoField label={tr("Profile photo")} name={f.name} value={f.photo_url} onChange={(photo_url) => setF({ ...f, photo_url })} />
        <ServiceChecks value={services} onChange={setServices} />
        <label className="check"><input type="checkbox" checked={f.create_login} onChange={(e) => setF({ ...f, create_login: e.target.checked })} /><span>{tr("Create a login and send an invitation")}<br /><span className="field-hint">{tr("They choose their own password from a one-time link. You never see or set it.")}</span></span></label>
      </div>
    </Modal>
  );
}

type Span = { weekday: number; start_min: number; end_min: number };
const ORDER = [1, 2, 3, 4, 5, 6, 0];

function ScheduleEditor({ barber }: { barber: any }) {
  const { shop } = useShop();
  const { touch } = useApp();
  const act = useAction();
  const init = () => ORDER.map((wd) => {
    const h = barber.hours.find((x: Span) => x.weekday === wd), b = barber.breaks.find((x: Span) => x.weekday === wd);
    return { wd, on: !!h, start: fmtMinutes(h?.start_min ?? 540), end: fmtMinutes(h?.end_min ?? 1080), brk: !!b, bStart: fmtMinutes(b?.start_min ?? 780), bEnd: fmtMinutes(b?.end_min ?? 840) };
  });
  const [rows, setRows] = useState(init);
  useEffect(() => setRows(init()), [barber.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (wd: number, patch: Record<string, unknown>) => setRows(rows.map((r) => (r.wd === wd ? { ...r, ...patch } : r)));
  const save = () => act.run(async () => {
    const hours: Span[] = [], breaks: Span[] = [];
    for (const r of rows.filter((x) => x.on)) {
      const s = parseMinutes(r.start), e = parseMinutes(r.end);
      if (s == null || e == null || s >= e) throw new Error(`${tr(WEEKDAYS[r.wd])}: ${tr("the end time must be after the start time.")}`);
      hours.push({ weekday: r.wd, start_min: s, end_min: e });
      if (r.brk) {
        const bs = parseMinutes(r.bStart), be = parseMinutes(r.bEnd);
        if (bs == null || be == null || bs >= be || bs < s || be > e) throw new Error(`${tr(WEEKDAYS[r.wd])}: ${tr("the break must sit inside the working hours.")}`);
        breaks.push({ weekday: r.wd, start_min: bs, end_min: be });
      }
    }
    await api(`/admin/barbers/${barber.id}/schedule`, { method: 'PUT', body: { hours, breaks } });
    touch();
  }, tr("Working hours saved."));
  return (
    <div className="card">
      <div className="card-head"><h2>{tr("Weekly working hours")}</h2><button className="btn btn-dark btn-sm" disabled={act.busy} onClick={save}>{tr("Save hours")}</button></div>
      <div className="card-body">
        {act.error && <div style={{ marginBottom: 12 }}><Notice tone="bad" icon="alert">{act.error}</Notice></div>}
        <div className="sched">
          {rows.map((r) => {
            const shopDay = shop.business_hours.find((h) => h.weekday === r.wd);
            const closed = !shopDay || shopDay.is_closed;
            return (
              <div className="sched-row" key={r.wd}>
                <b>{tr(WEEKDAYS[r.wd])}</b>
                <label className="switch" style={{ padding: 0, border: 0 }}><span className="sr-only">{tr("Works on")}{' '}{tr(WEEKDAYS[r.wd])}</span><input type="checkbox" checked={r.on} onChange={(e) => set(r.wd, { on: e.target.checked })} /></label>
                {r.on ? (
                  <div className="times">
                    <input type="time" className="input" value={r.start} aria-label={tr("Start")} onChange={(e) => set(r.wd, { start: e.target.value })} /><span className="muted">{tr("to")}</span>
                    <input type="time" className="input" value={r.end} aria-label={tr("End")} onChange={(e) => set(r.wd, { end: e.target.value })} />
                    <label className="check" style={{ marginLeft: 8 }}><input type="checkbox" checked={r.brk} onChange={(e) => set(r.wd, { brk: e.target.checked })} /><span>{tr("Break")}</span></label>
                    {r.brk && <><input type="time" className="input" value={r.bStart} aria-label={tr("Break start")} onChange={(e) => set(r.wd, { bStart: e.target.value })} /><span className="muted">{tr("to")}</span><input type="time" className="input" value={r.bEnd} aria-label={tr("Break end")} onChange={(e) => set(r.wd, { bEnd: e.target.value })} /></>}
                    {closed && <span className="badge warn plain">{tr("Shop is closed this day")}</span>}
                  </div>
                ) : <span className="muted">{tr("Day off")}</span>}
              </div>
            );
          })}
        </div>
        <p className="field-hint" style={{ marginTop: 12 }}>{tr("Bookable time is always limited to the shop's opening hours set in Settings.")}</p>
      </div>
    </div>
  );
}

function CompensationForm({ barber, onClose }: { barber: any; onClose: () => void }) {
  const fmt = useFmt();
  const { touch } = useApp();
  const act = useAction();
  const cur = barber.rule;
  const [model, setModel] = useState<CompModel>(cur?.model ?? 'commission');
  const [basis, setBasis] = useState<CompBasis>(cur?.basis ?? 'completed');
  const [pct, setPct] = useState(cur ? String(cur.commission_bps / 100) : '40');
  const [fixed, setFixed] = useState(fmt.plain(cur?.fixed_minor ?? 0));
  const [salary, setSalary] = useState(fmt.plain(cur?.salary_minor ?? 0));
  const [note, setNote] = useState('');
  const bps = Math.round(Number(pct.replace(',', '.')) * 100);
  const valid = model === 'commission' ? Number.isFinite(bps) && bps >= 0 && bps <= 10000 : model === 'fixed_per_service' ? fmt.parse(fixed) != null : model === 'salary' ? fmt.parse(salary) != null : true;
  return (
    <Modal title={tr("Change pay arrangement")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Keep current")}</button>
      <button className="btn btn-dark" disabled={!valid || act.busy} onClick={() => act.run(async () => {
        await api(`/admin/barbers/${barber.id}/compensation`, { body: { model, basis, commission_bps: model === 'commission' ? bps : 0, fixed_minor: model === 'fixed_per_service' ? fmt.parse(fixed) : 0, salary_minor: model === 'salary' ? fmt.parse(salary) : 0, note: note.trim() || undefined } });
        touch();
        onClose();
      }, tr("Arrangement saved. It applies from now on."))}>{tr("Save arrangement")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <Notice tone="info">{tr("The new arrangement applies to services completed from now on. Everything")}{' '}{barber.name.split(' ')[0]} {tr("has already earned stays exactly as it was calculated.")}</Notice>
        <Field label={tr("Model")}><select className="select" value={model} onChange={(e) => setModel(e.target.value as CompModel)}>{COMP_MODELS.map((m) => <option key={m} value={m}>{tr(COMP_LABEL[m])}</option>)}</select></Field>
        {model === 'commission' && <Field label={tr("Commission on the agreed service price")} hint={tr("For example 45 for 45%.")}><div className="input-affix"><input className="input num" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9.,]/g, ''))} /><span>%</span></div></Field>}
        {model === 'fixed_per_service' && <Field label={tr("Amount per completed appointment")}><MoneyInput value={fixed} onChange={setFixed} /></Field>}
        {model === 'salary' && <Field label={tr("Monthly salary")} hint={tr("Salary is not added automatically: record it each month from “Add entry” so nothing is accrued by surprise.")}><MoneyInput value={salary} onChange={setSalary} /></Field>}
        {(model === 'commission' || model === 'fixed_per_service') && (
          <Field label={tr("When is it earned?")}><select className="select" value={basis} onChange={(e) => setBasis(e.target.value as CompBasis)}>{COMP_BASES.map((b) => <option key={b} value={b}>{tr(COMP_BASIS_LABEL[b])}</option>)}</select></Field>
        )}
        <Field label={tr("Note (optional)")}><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={tr("Why this changed")} /></Field>
      </div>
    </Modal>
  );
}

function ManualEarning({ barber, onClose }: { barber: any; onClose: () => void }) {
  const fmt = useFmt();
  const { touch } = useApp();
  const act = useAction();
  const [kind, setKind] = useState<'salary' | 'bonus' | 'deduction'>(barber.rule?.model === 'salary' ? 'salary' : 'bonus');
  const [amount, setAmount] = useState(kind === 'salary' ? fmt.plain(barber.rule?.salary_minor ?? 0) : '');
  const [period, setPeriod] = useState(fmt.today().slice(0, 7));
  const [note, setNote] = useState('');
  const minor = fmt.parse(amount);
  return (
    <Modal title={tr("Add a pay entry")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={act.busy || !minor || minor <= 0} onClick={() => act.run(async () => {
        await api(`/admin/barbers/${barber.id}/earnings`, { body: { kind, amountMinor: minor, period: kind === 'salary' ? period : null, note: note.trim() || undefined } });
        touch();
        onClose();
      }, tr("Entry added."))}>{tr("Add entry")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <div className="seg" style={{ justifySelf: 'start' }}>{(['salary', 'bonus', 'deduction'] as const).map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{tr(k)}</button>)}</div>
        <div className="form-grid cols-2">
          <Field label={tr("Amount")} hint={kind === 'deduction' ? tr("Reduces what is owed.") : tr("Adds to what is owed.")}><MoneyInput value={amount} onChange={setAmount} /></Field>
          {kind === 'salary' && <Field label={tr("Month covered")} hint={tr("One salary entry per month.")}><input type="month" className="input" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>}
        </div>
        <Field label={tr("Note")}><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function TeamDetail() {
  const { id } = useParams();
  const fmt = useFmt();
  const { touch } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'profile';
  const state = useLive<any>(`/admin/barbers/${id}`);
  const act = useAction();
  const [f, setF] = useState<any | null>(null);
  const [invite, setInvite] = useState<{ invite_url: string; emailed: boolean } | null>(null);
  const [modal, setModal] = useState<'comp' | 'entry' | 'pay' | { voidPayout: any } | null>(null);
  const b = state.data?.barber;
  useEffect(() => {
    if (b) setF({ name: b.name, email: b.email ?? '', phone: b.phone ?? '', specialty: b.specialty, bio: b.bio, photo_url: b.photo_url, sort_order: b.sort_order, service_ids: b.service_ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b?.id, state.data]);

  return (
    <>
      <Link to="/app/team" className="back"><Icon name="left" size={14} />{tr("Team")}</Link>
      <Async state={state}>{({ barber, ledger, rules, performance: perf }) => (
        <>
          <PageHead title={barber.name} sub={<>{barber.specialty || tr("Barber")} · <span className={`badge ${barber.is_active ? 'ok' : ''}`}>{barber.is_active ? tr("Active") : tr("Inactive")}</span></>}>
            {barber.account?.role !== 'owner' && (
              <button className="btn btn-ghost" disabled={act.busy} onClick={() => act.run(async () => setInvite(await api(`/admin/barbers/${barber.id}/invite`, { body: {} })))}><Icon name="mail" size={15} />{barber.account ? (barber.account.has_password ? tr("Send password reset") : tr("Resend invitation")) : tr("Create login")}</button>
            )}
            <button className={`btn ${barber.is_active ? 'btn-danger' : 'btn-dark'}`} disabled={act.busy} onClick={() => act.run(async () => { await api(`/admin/barbers/${barber.id}`, { method: 'PATCH', body: { is_active: !barber.is_active } }); touch(); }, barber.is_active ? tr("Barber deactivated. History is kept.") : tr("Barber reactivated."))}>{barber.is_active ? tr("Deactivate") : tr("Reactivate")}</button>
          </PageHead>
          {act.error && <div style={{ marginBottom: 16 }}><Notice tone="bad" icon="alert">{act.error}</Notice></div>}
          {invite && <div style={{ marginBottom: 16 }}><InviteNotice url={invite.invite_url} emailed={invite.emailed} /></div>}
          {!barber.is_active && <div style={{ marginBottom: 16 }}><Notice icon="block">{tr("Inactive: not shown on the website, cannot be booked and cannot sign in. Past appointments, payments and pay records are untouched.")}{barber.upcoming > 0 ? ` ${barber.upcoming} ${tr("upcoming appointment(s) still need to be reassigned or cancelled.")}` : ''}</Notice></div>}

          <div className="stats">
            <div className="stat"><div className="k">{tr("This month")}</div><div className="v num">{perf?.completed ?? 0}<small>{tr("completed")}</small></div><div className="s">{perf?.appointments ?? 0} {tr("booked")}{" · "}{perf?.no_shows ?? 0} {tr("no-show")}</div></div>
            <div className="stat"><div className="k">{tr("Revenue this month")}</div><div className="v num">{fmt.money(perf?.revenue_minor ?? 0)}</div><div className="s">{tr("Services performed")}</div></div>
            <div className="stat"><div className="k">{tr("Upcoming")}</div><div className="v num">{barber.upcoming}</div><div className="s">{tr("Confirmed or pending")}</div></div>
            <div className="stat accent"><div className="k">{tr("Owed now")}</div><div className="v num">{fmt.money(ledger.balance.owed_minor)}</div><div className="s">{tr("Earned")}{' '}{fmt.money(ledger.balance.earned_minor)} {"· "}{tr("paid")}{' '}{fmt.money(ledger.balance.paid_minor)}</div></div>
          </div>

          <div className="tabs" role="tablist">
            {[['profile', tr("Profile & services")], ['schedule', tr("Hours & days off")], ['pay', tr("Pay & payouts")]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k }, { replace: true })}>{l}</button>)}
          </div>

          {tab === 'profile' && f && (
            <div className="card"><div className="card-body stack">
              <div className="form-grid cols-2">
                <Field label={tr("Full name")}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                <Field label={tr("Specialty")}><input className="input" value={f.specialty} maxLength={120} onChange={(e) => setF({ ...f, specialty: e.target.value })} /></Field>
                <Field label={tr("Contact email")}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
                <Field label={tr("Phone")}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              </div>
              <Field label={tr("Biography")} hint={tr("Shown on the public barbers page.")}><textarea className="textarea" maxLength={800} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
              <div className="form-grid cols-2">
                <PhotoField label={tr("Profile photo")} name={f.name} value={f.photo_url} onChange={(photo_url) => setF({ ...f, photo_url })} />
                <Field label={tr("Display order")} hint={tr("Lower numbers appear first on the website.")}><input className="input num" type="number" min={0} max={999} value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} /></Field>
              </div>
              <ServiceChecks value={f.service_ids} onChange={(service_ids) => setF({ ...f, service_ids })} />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-dark" disabled={act.busy || f.name.trim().length < 2} onClick={() => act.run(async () => { await api(`/admin/barbers/${barber.id}`, { method: 'PATCH', body: f }); touch(); }, tr("Profile saved."))}>{tr("Save profile")}</button>
              </div>
            </div></div>
          )}

          {tab === 'schedule' && <div className="stack"><ScheduleEditor barber={barber} /><TimeOffCard barberId={barber.id} allowShopWide /></div>}

          {tab === 'pay' && (
            <div className="stack">
              <div className="card">
                <div className="card-head"><h2>{tr("Current arrangement")}</h2>
                  <div className="row fw"><button className="btn btn-ghost btn-sm" onClick={() => setModal('entry')}>{tr("Add entry")}</button><button className="btn btn-ghost btn-sm" onClick={() => setModal('comp')}>{tr("Change arrangement")}</button><button className="btn btn-dark btn-sm" disabled={ledger.balance.owed_minor <= 0} onClick={() => setModal('pay')}>{tr("Record payout")}</button></div>
                </div>
                <div className="card-body">
                  <p style={{ fontSize: 17 }}>{ruleText(barber.rule, fmt)}</p>
                  {rules.length > 1 && <details style={{ marginTop: 12 }}><summary className="link" style={{ display: 'inline', cursor: 'pointer' }}>{tr("History of")}{' '}{rules.length} {tr("arrangements")}</summary>
                    <table className="table" style={{ marginTop: 10 }}><tbody>{rules.map((r: any) => <tr key={r.id}><td className="num nowrap">{fmt.dateTime(r.effective_from)}</td><td>{ruleText(r, fmt)}<span className="sub">{r.note || ''}{r.created_by_name ? ` · ${tr("set by")} ${r.created_by_name}` : ''}</span></td></tr>)}</tbody></table>
                  </details>}
                </div>
              </div>
              <Ledger data={ledger} onVoid={(p) => setModal({ voidPayout: p })} />
            </div>
          )}

          {modal === 'comp' && <CompensationForm barber={barber} onClose={() => setModal(null)} />}
          {modal === 'entry' && <ManualEarning barber={barber} onClose={() => setModal(null)} />}
          {modal === 'pay' && <PayoutModal barber={barber} owed={ledger.balance.owed_minor} onClose={() => setModal(null)} />}
          {typeof modal === 'object' && modal && <ReasonModal title={tr("Void this payout?")} danger required confirm={tr("Void payout")} onClose={() => setModal(null)}
            text={<>{tr("Adds an opposite entry of")}{' '}<b className="num">{fmt.money(-modal.voidPayout.amount_minor)}</b>{"; "}{tr("the amount becomes owed again. The original stays in the ledger.")}</>}
            onSubmit={async (reason) => { await api(`/admin/payouts/${modal.voidPayout.id}/void`, { body: { reason } }); touch(); }} />}
        </>
      )}</Async>
      {!state.data && !state.loading && !state.error && <Empty title={tr("Barber not found.")} />}
    </>
  );
}
