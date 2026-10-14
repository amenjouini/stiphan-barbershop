-- Club Barber schema. Timestamps are UTC epoch milliseconds (INTEGER).
-- Money is integer minor units. Ledger tables are append-only.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','barber','customer')),
  name TEXT NOT NULL,
  phone TEXT,
  email_verified_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One-time codes and links: email verification, guest booking, invites, resets.
CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','guest_booking','invite','reset')),
  email TEXT NOT NULL COLLATE NOCASE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_tokens_lookup ON auth_tokens(purpose, email);
CREATE INDEX idx_auth_tokens_secret ON auth_tokens(secret_hash);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON encoded
);

CREATE TABLE business_hours (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  open_min INTEGER NOT NULL,
  close_min INTEGER NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  CHECK (open_min >= 0 AND close_min <= 1440 AND open_min < close_min)
);

CREATE TABLE barbers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  phone TEXT,
  bio TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  photo_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  image_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE barber_services (
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (barber_id, service_id)
);

CREATE TABLE working_hours (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
CREATE INDEX idx_working_hours_barber ON working_hours(barber_id, weekday);

-- Recurring weekly breaks (lunch...).
CREATE TABLE breaks (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  CHECK (start_min >= 0 AND end_min <= 1440 AND start_min < end_min)
);
CREATE INDEX idx_breaks_barber ON breaks(barber_id, weekday);

-- Days off, holidays and blocked time. barber_id NULL = whole shop.
CREATE TABLE time_off (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER REFERENCES barbers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('day_off','holiday','blocked')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  CHECK (starts_at < ends_at)
);
CREATE INDEX idx_time_off_range ON time_off(barber_id, starts_at, ends_at);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  phone TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_customers_email ON customers(email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_phone ON customers(phone);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL,     -- ends_at + buffer at booking time
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','checked_in','in_progress','completed','cancelled','no_show')),
  source TEXT NOT NULL CHECK (source IN ('website','phone','walk_in','whatsapp','in_person','other')),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  currency TEXT NOT NULL,
  customer_note TEXT NOT NULL DEFAULT '',
  internal_note TEXT NOT NULL DEFAULT '',
  manage_token TEXT,                  -- capability token for the emailed "manage booking" link
  cancel_reason TEXT,
  cancelled_at INTEGER,
  checked_in_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  completed_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (starts_at < ends_at AND ends_at <= blocked_until)
);
CREATE INDEX idx_appt_barber_time ON appointments(barber_id, starts_at);
CREATE INDEX idx_appt_time ON appointments(starts_at);
CREATE INDEX idx_appt_customer ON appointments(customer_id, starts_at);
CREATE INDEX idx_appt_status ON appointments(status);

-- Last line of defence against double booking: no two calendar-occupying
-- appointments of the same barber may overlap, whatever the application does.
CREATE TRIGGER appt_no_overlap_insert BEFORE INSERT ON appointments
WHEN NEW.status NOT IN ('cancelled','no_show')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN') WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.barber_id = NEW.barber_id AND a.status NOT IN ('cancelled','no_show')
      AND a.starts_at < NEW.blocked_until AND a.blocked_until > NEW.starts_at);
END;

CREATE TRIGGER appt_no_overlap_update BEFORE UPDATE OF starts_at, ends_at, blocked_until, barber_id, status ON appointments
WHEN NEW.status NOT IN ('cancelled','no_show')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN') WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.id <> NEW.id AND a.barber_id = NEW.barber_id AND a.status NOT IN ('cancelled','no_show')
      AND a.starts_at < NEW.blocked_until AND a.blocked_until > NEW.starts_at);
END;

-- Snapshot of what was agreed; independent of later catalogue changes.
CREATE TABLE appointment_items (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  duration_min INTEGER NOT NULL
);
CREATE INDEX idx_items_appt ON appointment_items(appointment_id);

-- Customer money ledger. payment > 0, refund < 0, adjustment = signed
-- correction (a void reverses exactly one earlier entry). Append-only.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment','refund','adjustment')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','other')),
  reference TEXT,
  note TEXT,
  reverses_payment_id INTEGER UNIQUE REFERENCES payments(id),
  recorded_by INTEGER REFERENCES users(id),
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'payment' AND amount_minor > 0) OR (kind = 'refund' AND amount_minor < 0) OR (kind = 'adjustment' AND amount_minor <> 0))
);
CREATE INDEX idx_payments_appt ON payments(appointment_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_created ON payments(created_at);
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;

-- Versioned compensation rules: a new row is added on every change, old rows stay.
CREATE TABLE compensation_rules (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  model TEXT NOT NULL CHECK (model IN ('commission','fixed_per_service','salary','none')),
  basis TEXT NOT NULL DEFAULT 'completed' CHECK (basis IN ('completed','paid')),
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  fixed_minor INTEGER NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  salary_minor INTEGER NOT NULL DEFAULT 0 CHECK (salary_minor >= 0),
  note TEXT,
  effective_from INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_comp_rules ON compensation_rules(barber_id, effective_from);

-- What a barber has earned. One 'service' row per appointment at most; the
-- rule in force is snapshotted so later rule changes never rewrite history.
CREATE TABLE barber_earnings (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  kind TEXT NOT NULL CHECK (kind IN ('service','salary','bonus','deduction')),
  appointment_id INTEGER UNIQUE REFERENCES appointments(id),
  amount_minor INTEGER NOT NULL,
  base_minor INTEGER NOT NULL DEFAULT 0,
  rule_id INTEGER REFERENCES compensation_rules(id),
  rule_snapshot TEXT,
  period TEXT,                         -- e.g. '2026-10' for salary accruals
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'service') = (appointment_id IS NOT NULL))
);
CREATE INDEX idx_earnings_barber ON barber_earnings(barber_id, created_at);
CREATE UNIQUE INDEX idx_earnings_salary_period ON barber_earnings(barber_id, period) WHERE kind = 'salary';
CREATE TRIGGER earnings_no_update BEFORE UPDATE ON barber_earnings BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;
CREATE TRIGGER earnings_no_delete BEFORE DELETE ON barber_earnings BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;

-- Money paid out to barbers. A void is a negative row reversing one payout.
CREATE TABLE payouts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','other')),
  reference TEXT,
  note TEXT,
  reverses_payout_id INTEGER UNIQUE REFERENCES payouts(id),
  recorded_by INTEGER REFERENCES users(id),
  idempotency_key TEXT UNIQUE,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_payouts_barber ON payouts(barber_id, paid_at);
CREATE TRIGGER payouts_no_update BEFORE UPDATE ON payouts BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;
CREATE TRIGGER payouts_no_delete BEFORE DELETE ON payouts BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','other')),
  spent_at INTEGER NOT NULL,
  voided_at INTEGER,
  void_reason TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_expenses_spent ON expenses(spent_at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','simulated','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_status ON notifications(status, next_attempt_at);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
