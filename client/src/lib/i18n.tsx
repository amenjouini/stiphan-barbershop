import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ar } from '../i18n/ar';
import { arApp } from '../i18n/ar-app';
import { fr } from '../i18n/fr';
import { frApp } from '../i18n/fr-app';

// Translations are keyed by the English source text, so the code stays readable
// and a missing entry simply falls back to English.
export type Lang = 'fr' | 'ar' | 'en';
export const LANGS: { code: Lang; label: string; short: string }[] = [
  { code: 'fr', label: 'Français', short: 'FR' },
  { code: 'ar', label: 'العربية', short: 'ع' },
  { code: 'en', label: 'English', short: 'EN' },
];
const DICT: Record<Lang, Record<string, string>> = { en: {}, fr: { ...frApp, ...fr }, ar: { ...arApp, ...ar } };
const LOCALE: Record<Lang, string> = { fr: 'fr-FR', ar: 'ar-TN', en: 'en-GB' };
const STORE = 'cb_lang';
const isLang = (v: unknown): v is Lang => v === 'fr' || v === 'ar' || v === 'en';

type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s);

/** Server error codes that have a customer-facing translation. Anything else shows the server's own message. */
const ERROR_TEXT: Record<string, string> = {
  SLOT_TAKEN: 'Sorry, that time has just been taken. Please choose another slot.',
  CODE_INVALID: 'That code is not valid or has expired. Request a new one and try again.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  EMAIL_TAKEN: 'An account with this email already exists. Try signing in instead.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
  TOKEN_INVALID: 'This link is no longer valid. Please request a new one.',
  DISABLED: 'This account has been deactivated. Please contact the shop.',
  POLICY: 'Online changes are closed for this appointment. Please call the shop.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
  OVERPAYMENT: 'The amount is higher than the remaining balance.',
  OVER_REFUND: 'You cannot refund more than was collected on this appointment.',
  OVER_PAYOUT: 'The payout is higher than the amount currently owed to this barber.',
  OUTSIDE_HOURS: 'That time is outside the barber’s working hours (or during a break or day off).',
  ALREADY_VOIDED: 'This entry has already been voided.',
  TOO_EARLY: 'A no-show can only be recorded once the appointment time has passed.',
  FORBIDDEN: 'You do not have permission to do that.',
  INVALID_TRANSITION: 'That status change is not allowed for this appointment.',
};

// Non-hook translator for the dashboard. The provider keeps `active` in step with the
// current language, and the dashboard remounts on a language change so every label refreshes.
let active: Lang = 'fr';
export const setActiveLang = (l: Lang) => { active = l; };
export const tr = (en: string, vars?: Vars) => fill(DICT[active][en] ?? en, vars);

interface I18n {
  lang: Lang;
  locale: string;
  dir: 'ltr' | 'rtl';
  setLang: (l: Lang) => void;
  /** Used once the shop's default language is known and the visitor has not chosen one. */
  setFallback: (l: unknown) => void;
  t: (en: string, vars?: Vars) => string;
  /** Like t(), but *starred* parts are rendered in the accent italic. */
  rich: (en: string, vars?: Vars) => ReactNode;
  err: (e: unknown) => string;
}
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Lang | null>(() => {
    try {
      const v = localStorage.getItem(STORE);
      return isLang(v) ? v : null;
    } catch {
      return null;
    }
  });
  const [fallback, setFallbackState] = useState<Lang>('fr');
  const lang: Lang = chosen ?? fallback;
  // Keep the non-hook translator (used by the dashboard) in step before children render.
  setActiveLang(lang);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((l: Lang) => {
    setChosen(l);
    try {
      localStorage.setItem(STORE, l);
    } catch { /* private mode */ }
  }, []);
  const setFallback = useCallback((l: unknown) => {
    if (isLang(l)) setFallbackState(l);
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = DICT[lang];
    const t = (en: string, vars?: Vars) => fill(dict[en] ?? en, vars);
    const rich = (en: string, vars?: Vars) => t(en, vars).split('*').map((part, i) => (i % 2 ? <em key={i}>{part}</em> : <Fragment key={i}>{part}</Fragment>));
    const err = (e: unknown) => {
      const code = (e as any)?.code as string | undefined;
      if (code && ERROR_TEXT[code]) return t(ERROR_TEXT[code]);
      return e instanceof Error ? e.message : t('Something went wrong on our side. Please try again.');
    };
    return { lang, locale: LOCALE[lang], dir, setLang, setFallback, t, rich, err };
  }, [lang, dir, setLang, setFallback]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx)!;

/** Compact language switcher for the site header and auth pages. */
export function LangSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useT();
  return (
    <div className={`lang ${className}`} role="group" aria-label="Language / Langue / اللغة">
      {LANGS.map((l) => <button key={l.code} type="button" lang={l.code} aria-pressed={lang === l.code} title={l.label} onClick={() => setLang(l.code)}>{l.short}</button>)}
    </div>
  );
}
