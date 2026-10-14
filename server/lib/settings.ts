import { all, run, tx } from '../db.ts';

export const DEFAULT_SETTINGS = {
  shop_name: 'Club Barber',
  tagline: 'Sharp cuts. Slow rituals.',
  about: 'A neighbourhood barbershop built around time: time to sit, time to talk, time to get it exactly right.',
  address: '14 Rue de Marseille',
  city: 'Tunis 1000',
  phone: '+216 71 000 000',
  email: 'hello@clubbarber.example',
  instagram: '',
  map_url: '',
  timezone: 'Africa/Tunis',
  // Language used for visitors who have not chosen one, and for emails when the customer's language is unknown.
  default_language: 'fr',
  currency: 'TND',
  currency_decimals: 3,
  slot_interval_min: 15,
  buffer_min: 0,
  lead_time_min: 60,
  horizon_days: 45,
  auto_confirm: true,
  allow_any_barber: true,
  guest_booking: true,
  guest_email_verification: true,
  cancel_min_hours: 3,
  reschedule_min_hours: 3,
  reminder_hours: 24,
  barbers_record_payments: true,
  barbers_see_earnings: true,
  owner_notify_email: '',
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const out: any = { ...DEFAULT_SETTINGS };
  for (const row of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in DEFAULT_SETTINGS) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        /* keep default */
      }
    }
  }
  cache = out;
  return out;
}

export function saveSettings(patch: Partial<Settings>) {
  tx(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    }
  });
  cache = null;
}

export function resetSettingsCache() {
  cache = null;
}

const PUBLIC_KEYS: SettingKey[] = [
  'shop_name', 'tagline', 'about', 'address', 'city', 'phone', 'email', 'instagram', 'map_url', 'timezone', 'default_language',
  'currency', 'currency_decimals', 'slot_interval_min', 'lead_time_min', 'horizon_days', 'auto_confirm',
  'allow_any_barber', 'guest_booking', 'guest_email_verification', 'cancel_min_hours', 'reschedule_min_hours',
];

export function publicSettings() {
  const s = getSettings();
  return Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]])) as Partial<Settings>;
}
