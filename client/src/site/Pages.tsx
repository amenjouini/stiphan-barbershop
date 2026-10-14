import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, Mark } from '../components/Icon';
import { Img, Stars } from '../components/ui';
import { isStaff, shortName, useAuth, useFmt, useShop, type Barber } from '../lib/context';
import { LangSwitch, useT } from '../lib/i18n';
import { fmtMinutes, weekdayOf } from '../../../shared/time';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
// 2023-01-01 was a Sunday: a fixed anchor for turning a weekday number into a localised name.
const dayDate = (wd: number) => `2023-01-0${wd + 1}`;

export function SiteLayout() {
  const { shop } = useShop();
  const { user } = useAuth();
  const { t } = useT();
  const loc = useLocation();
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const s = shop.settings;
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    setOpen(false);
    if (!loc.hash) window.scrollTo(0, 0);
    else setTimeout(() => document.querySelector(loc.hash)?.scrollIntoView(), 50);
  }, [loc.pathname, loc.hash]);

  const account = user ? (isStaff(user) ? { to: '/app', label: t('Dashboard') } : { to: '/account', label: t('My bookings') }) : { to: '/login', label: t('Sign in') };
  const links = [{ to: '/services', label: t('Services') }, { to: '/barbers', label: t('Barbers') }, { to: '/#visit', label: t('Visit') }, account];

  return (
    <div className="site on-ink">
      <header className={`site-head ${solid || loc.pathname !== '/' ? 'solid' : ''}`}>
        <div className="wrap">
          <Link to="/" className="brand" aria-label={s.shop_name}><Mark />{s.shop_name}</Link>
          <nav className="site-nav" aria-label={t('Main menu')}>
            {links.map((l) => <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive && !l.to.includes('#') ? 'active' : '')}>{l.label}</NavLink>)}
            <LangSwitch />
            <Link to="/book" className="btn btn-primary btn-sm">{t('Book now')}</Link>
          </nav>
          <button className="icon-btn nav-toggle" aria-label={t('Open menu')} aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" size={22} /></button>
        </div>
      </header>
      {open && (
        <div className="mobile-nav" role="dialog" aria-modal="true" aria-label={t('Main menu')}>
          <div className="top">
            <span className="brand"><Mark />{s.shop_name}</span>
            <button className="icon-btn" aria-label={t('Close menu')} onClick={() => setOpen(false)}><Icon name="x" size={22} /></button>
          </div>
          <nav>
            <Link to="/">{t('Home')}</Link>
            {links.map((l) => <Link key={l.to} to={l.to} onClick={() => setOpen(false)}>{l.label}</Link>)}
          </nav>
          <LangSwitch className="big" />
          <Link to="/book" className="btn btn-primary btn-lg btn-block">{t('Book an appointment')}</Link>
        </div>
      )}
      <main><Outlet /></main>
      <footer className="site-foot">
        <div className="wrap">
          <div className="cols">
            <div>
              <span className="brand" style={{ marginBottom: 14 }}><Mark />{s.shop_name}</span>
              <p style={{ maxWidth: '32ch' }}>{s.tagline}</p>
            </div>
            <div>
              <h4>{t('Explore')}</h4>
              <ul><li><Link to="/services">{t('Services & prices')}</Link></li><li><Link to="/barbers">{t('The barbers')}</Link></li><li><Link to="/book">{t('Book online')}</Link></li></ul>
            </div>
            <div>
              <h4>{t('Your booking')}</h4>
              <ul><li><Link to="/account">{t('My bookings')}</Link></li><li><Link to="/login">{t('Sign in')}</Link></li><li><Link to="/register">{t('Create an account')}</Link></li></ul>
            </div>
            <div>
              <h4>{t('Find us')}</h4>
              <ul><li>{s.address}</li><li>{s.city}</li><li><a href={`tel:${String(s.phone).replace(/\s/g, '')}`} dir="ltr">{s.phone}</a></li></ul>
            </div>
          </div>
          <div className="legal">
            <span>© {new Date().getFullYear()} {s.shop_name}. {t('All rights reserved.')}</span>
            <Link to="/login">{t('Staff sign in')}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function useOpenToday() {
  const { shop } = useShop();
  const fmt = useFmt();
  const { t } = useT();
  const wd = weekdayOf(fmt.today());
  const h = shop.business_hours.find((x) => x.weekday === wd);
  return { wd, label: !h || h.is_closed ? t('Closed today') : `${fmtMinutes(h.open_min)} – ${fmtMinutes(h.close_min)}` };
}

function ServiceRows({ services, start = 0 }: { services: ReturnType<typeof useShop>['shop']['services']; start?: number }) {
  const fmt = useFmt();
  const { t } = useT();
  return (
    <div className="menu">
      {services.map((sv, i) => (
        <Link key={sv.id} to={`/book?service=${sv.id}`} className="menu-row" aria-label={`${t('Book')} ${sv.name}, ${fmt.money(sv.price_minor)}`}>
          <span className="index">{String(start + i + 1).padStart(2, '0')}</span>
          <h3>{sv.name}</h3>
          <p>{sv.description}</p>
          <span className="dur">{fmt.duration(sv.duration_min)}</span>
          <span className="price num" dir="ltr">{fmt.money(sv.price_minor)}</span>
          <span className="go"><Icon name="arrow" size={16} /></span>
        </Link>
      ))}
    </div>
  );
}

function BarberCard({ b }: { b: Barber }) {
  const { t } = useT();
  return (
    <Link to={`/book?barber=${b.id}`} className="crew-card">
      <Img src={b.photo_url} alt={b.name} label={b.name} />
      <div className="meta">
        <h3>{b.name}</h3>
        <p>{b.specialty}</p>
        <span className="cta">{t('Book with {name}', { name: shortName(b.name) })}<Icon name="arrow" size={14} /></span>
      </div>
    </Link>
  );
}

function Hours() {
  const { shop } = useShop();
  const fmt = useFmt();
  const { t } = useT();
  const { wd } = useOpenToday();
  return (
    <table className="hours">
      <tbody>
        {WEEK_ORDER.map((d) => {
          const h = shop.business_hours.find((x) => x.weekday === d);
          const closed = !h || h.is_closed;
          return (
            <tr key={d} className={`${d === wd ? 'today' : ''} ${closed ? 'closed' : ''}`}>
              <td style={{ textTransform: 'capitalize' }}>{fmt.dow(dayDate(d), 'long')}{d === wd ? ` · ${t('today')}` : ''}</td>
              <td dir="ltr">{closed ? t('Closed') : `${fmtMinutes(h!.open_min)} – ${fmtMinutes(h!.close_min)}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Home() {
  const { shop } = useShop();
  const { t, rich } = useT();
  const s = shop.settings;
  const open = useOpenToday();
  const [first, ...rest] = String(s.tagline || '').split(/(?<=[.!?])\s+/);
  const mapUrl = s.map_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.shop_name} ${s.address} ${s.city}`)}`;

  return (
    <>
      <section className="hero">
        <div className="hero-bg"><Img src="/images/hero.jpg" alt={t('A barber trimming a beard with scissors in warm low light')} label={s.shop_name} /></div>
        <div className="wrap hero-inner">
          <p className="eyebrow" style={{ color: '#d8cfbf' }}>{t('Barbershop')} · {s.city}</p>
          <h1 className="display"><span>{first}</span>{rest.length > 0 && <span><em>{rest.join(' ')}</em></span>}</h1>
          <p className="hero-lede">{s.about}</p>
          <div className="hero-cta">
            <Link to="/book" className="btn btn-primary btn-lg">{t('Book an appointment')}<Icon name="arrow" className="arrow" /></Link>
            <Link to="/services" className="btn btn-ghost btn-lg">{t('Services & prices')}</Link>
          </div>
          <div className="hero-strip">
            <div><span className="eyebrow">{t('Open today')}</span><b className="num" dir="ltr">{open.label}</b></div>
            <div><span className="eyebrow">{t('Find us')}</span><b>{s.address}</b></div>
            <div><span className="eyebrow">{shop.rating.count ? t('{n} verified reviews', { n: shop.rating.count }) : t('Walk-ins welcome')}</span><b dir="ltr">{shop.rating.average ? `${shop.rating.average.toFixed(1)} / 5` : t('Booking recommended')}</b></div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap about">
          <div className="about-figs">
            <Img src="/images/interior.jpg" alt={t('The shop: leather chairs facing brick-framed mirrors')} label="Shop" />
            <Img src="/images/interior-long.jpg" alt={t('A row of barber chairs under pendant lamps')} label="Chairs" />
          </div>
          <div>
            <p className="eyebrow">{t('The shop')}</p>
            <h2 className="display">{rich('A proper chair, *unhurried* hands.')}</h2>
            <p>{t('We keep the list short and do each thing well: scissor cuts, clean fades, shaped beards and a straight-razor shave with hot towels. Book a time, arrive, sit down — your barber is ready when you are.')}</p>
            <div className="facts">
              <div><b className="num">{shop.barbers.length}</b><span>{t('Barbers')}</span></div>
              <div><b className="num">{shop.services.length}</b><span>{t('Services')}</span></div>
              <div><b className="num">{shop.business_hours.filter((h) => !h.is_closed).length}</b><span>{t('Days a week')}</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section tight" id="services">
        <div className="wrap">
          <div className="section-head">
            <div><p className="eyebrow">{t('The menu')}</p><h2 className="display">{rich('Services *&* prices')}</h2></div>
            <Link to="/services" className="link">{t('Full menu')}</Link>
          </div>
          <ServiceRows services={shop.services.slice(0, 5)} />
        </div>
      </section>

      <section className="section" id="barbers">
        <div className="wrap">
          <div className="section-head">
            <div><p className="eyebrow">{t('Behind the chair')}</p><h2 className="display">{rich('Choose *your* barber')}</h2></div>
            <p>{s.allow_any_barber ? t('Every barber keeps their own calendar. Pick the one you know, or let us give you the first one free.') : t('Every barber keeps their own calendar. Pick the one you know.')}</p>
          </div>
          <div className="crew">{shop.barbers.slice(0, 4).map((b) => <BarberCard key={b.id} b={b} />)}</div>
        </div>
      </section>

      <section className="section tight" id="reviews">
        <div className="wrap">
          <div className="section-head">
            <div><p className="eyebrow">{t('Word of mouth')}</p><h2 className="display">{rich('From the *chair*')}</h2></div>
            <p>{t('Reviews are left by customers after a completed visit — nobody else can post one.')}</p>
          </div>
          {shop.reviews.length ? (
            <div className="quotes">
              {shop.reviews.slice(0, 3).map((r, i) => (
                <figure className="quote" key={i}>
                  <Stars value={r.rating} />
                  <blockquote>“{r.comment}”</blockquote>
                  <cite>{r.customer_name} · {r.barber_name}</cite>
                </figure>
              ))}
            </div>
          ) : (
            <div className="panel-ink"><p className="muted">{t('No reviews have been published yet. After your visit you will get a link to leave the first one.')}</p></div>
          )}
        </div>
      </section>

      <section className="section" id="visit">
        <div className="wrap visit">
          <div>
            <p className="eyebrow">{t('Visit')}</p>
            <h2 className="display" style={{ fontSize: 'clamp(44px, 6vw, 88px)', margin: '14px 0 26px' }}>{rich('Hours *&* location')}</h2>
            <Hours />
          </div>
          <div className="visit-card">
            <Img src="/images/chair.jpg" alt={t('A tufted leather barber chair')} label="Visit" />
            <div className="contact-list">
              <a href={mapUrl} target="_blank" rel="noreferrer"><Icon name="pin" /><span>{s.address}, {s.city}</span></a>
              <a href={`tel:${String(s.phone).replace(/\s/g, '')}`}><Icon name="phone" /><span dir="ltr">{s.phone}</span></a>
              {s.email && <a href={`mailto:${s.email}`}><Icon name="mail" /><span dir="ltr">{s.email}</span></a>}
            </div>
            <div className="row fw">
              <Link to="/book" className="btn btn-primary">{t('Book online')}</Link>
              <a href={mapUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">{t('Directions')}<Icon name="external" size={14} /></a>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <Img src="/images/tools.jpg" alt="" label="" />
        <div className="wrap">
          <h2 className="display">{rich('Your chair is *waiting.*')}</h2>
          <Link to="/book" className="btn btn-primary btn-lg">{t('Book in under a minute')}<Icon name="arrow" className="arrow" /></Link>
        </div>
      </section>
    </>
  );
}

export function ServicesPage() {
  const { shop } = useShop();
  const { t, rich } = useT();
  const groups = useMemo(() => {
    const map = new Map<string, typeof shop.services>();
    for (const sv of shop.services) map.set(sv.category || '', [...(map.get(sv.category || '') ?? []), sv]);
    return [...map.entries()];
  }, [shop.services]);
  let n = 0;
  return (
    <div className="page-top">
      <div className="wrap">
        <header className="page-hero">
          <p className="eyebrow">{t('The menu')}</p>
          <h1 className="display">{rich('Services *&* prices')}</h1>
          <p>{t('Prices are per service and paid at the shop. Choose more than one in the same booking and we will reserve the time back to back.')}</p>
        </header>
        {groups.map(([cat, list]) => {
          const start = n;
          n += list.length;
          return (
            <section key={cat}>
              <div className="cat-head"><span className="index">—</span><h2>{cat || t('Services')}</h2></div>
              <ServiceRows services={list} start={start} />
            </section>
          );
        })}
        <div className="section" style={{ textAlign: 'center' }}>
          <Link to="/book" className="btn btn-primary btn-lg">{t('Book an appointment')}<Icon name="arrow" className="arrow" /></Link>
        </div>
      </div>
    </div>
  );
}

export function BarbersPage() {
  const { shop } = useShop();
  const fmt = useFmt();
  const { t, rich } = useT();
  const scheduleLines = (b: Barber) => {
    const byDay = WEEK_ORDER.map((d) => {
      const rows = b.hours.filter((h) => h.weekday === d);
      return { d, text: rows.length ? rows.map((r) => `${fmtMinutes(r.start_min)}–${fmtMinutes(r.end_min)}`).join(', ') : null };
    });
    // Collapse consecutive days with identical hours: "Mon–Fri 09:00–19:00".
    const out: { days: string; hours: string | null }[] = [];
    for (let i = 0; i < byDay.length;) {
      let j = i;
      while (j + 1 < byDay.length && byDay[j + 1].text === byDay[i].text) j++;
      const name = (k: number) => fmt.dow(dayDate(byDay[k].d), 'short');
      out.push({ days: i === j ? name(i) : `${name(i)} – ${name(j)}`, hours: byDay[i].text });
      i = j + 1;
    }
    return out;
  };
  return (
    <div className="page-top">
      <div className="wrap">
        <header className="page-hero">
          <p className="eyebrow">{t('Behind the chair')}</p>
          <h1 className="display">{rich('The *barbers*')}</h1>
          <p>{t('Each barber has their own specialties and their own calendar. What you see when you book is their real, live availability.')}</p>
        </header>
        <div>
          {shop.barbers.map((b) => (
            <article className="profile" key={b.id}>
              <Img src={b.photo_url} alt={b.name} label={b.name} />
              <div>
                <p className="eyebrow">{b.specialty}</p>
                <h2>{b.name}</h2>
                <p className="bio">{b.bio}</p>
                <dl>
                  <dt>{t('Offers')}</dt>
                  <dd><div className="chips">{shop.services.filter((sv) => b.service_ids.includes(sv.id)).map((sv) => <span className="chip" key={sv.id}>{sv.name}</span>)}</div></dd>
                  <dt>{t('In the shop')}</dt>
                  <dd>{scheduleLines(b).map((l) => <div key={l.days} className="num"><span style={{ textTransform: 'capitalize' }}>{l.days}</span> · <span dir="ltr">{l.hours ?? t('Off')}</span></div>)}</dd>
                </dl>
                <Link to={`/book?barber=${b.id}`} className="btn btn-primary">{t('Book with {name}', { name: b.name })}<Icon name="arrow" className="arrow" /></Link>
              </div>
            </article>
          ))}
        </div>
        <div className="section" />
      </div>
    </div>
  );
}

export function NotFound() {
  const { t } = useT();
  return (
    <div className="page-top"><div className="wrap narrow"><div className="empty" style={{ padding: '120px 0' }}>
      <h3 style={{ fontSize: 56 }}>{t('Nothing here.')}</h3><p>{t('The page you are looking for has moved or never existed.')}</p>
      <Link to="/" className="btn btn-primary">{t('Back to the shop')}</Link>
    </div></div></div>
  );
}
