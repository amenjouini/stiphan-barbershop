import { get, run, tx } from './db.ts';
import { hashPassword } from './lib/auth.ts';
import { DEFAULT_SETTINGS, saveSettings } from './lib/settings.ts';
import { setCompensationRule } from './services/finance.ts';

/** Idempotent baseline every installation needs: opening hours and stored settings. */
export function ensureDefaults() {
  tx(() => {
    if (!get('SELECT 1 FROM business_hours LIMIT 1')) {
      for (let wd = 0; wd < 7; wd++) {
        run('INSERT INTO business_hours (weekday, open_min, close_min, is_closed) VALUES (?, ?, ?, ?)', wd, 9 * 60, wd === 6 ? 18 * 60 : 19 * 60, wd === 0);
      }
    }
    if (!get('SELECT 1 FROM settings LIMIT 1')) saveSettings(DEFAULT_SETTINGS);
  });
}

/** Creates the owner login together with their own barber profile (the owner also works a chair). */
export function createOwner(input: { email: string; password: string; name: string; phone?: string; bio?: string; specialty?: string; photo_url?: string }) {
  return tx(() => {
    const now = Date.now();
    const userId = run("INSERT INTO users (email, password_hash, role, name, phone, email_verified_at, created_at) VALUES (?, ?, 'owner', ?, ?, ?, ?)",
      input.email.toLowerCase(), hashPassword(input.password), input.name, input.phone ?? null, now, now).id;
    const barberId = run('INSERT INTO barbers (user_id, name, email, phone, bio, specialty, photo_url, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      userId, input.name, input.email.toLowerCase(), input.phone ?? null, input.bio ?? '', input.specialty ?? '', input.photo_url ?? null, now).id;
    run('INSERT INTO working_hours (barber_id, weekday, start_min, end_min) SELECT ?, weekday, open_min, close_min FROM business_hours WHERE is_closed = 0', barberId);
    run('INSERT INTO barber_services (barber_id, service_id) SELECT ?, id FROM services', barberId);
    setCompensationRule(barberId, { model: 'none', basis: 'completed', commission_bps: 0, fixed_minor: 0, salary_minor: 0, note: 'Owner — keeps the shop result' }, null);
    return { userId, barberId };
  });
}
