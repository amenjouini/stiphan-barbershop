import { all, get } from '../db.ts';
import { notFound } from '../lib/http.ts';

export const APPT_SELECT = `
  SELECT a.id, a.reference, a.customer_id, a.barber_id, a.starts_at, a.ends_at, a.blocked_until, a.status, a.source,
    a.total_minor, a.currency, a.customer_note, a.internal_note, a.cancel_reason, a.cancelled_at, a.checked_in_at,
    a.started_at, a.completed_at, a.completed_by, a.created_by, a.created_at, a.updated_at,
    c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, b.name AS barber_name,
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id) AS paid_minor,
    (SELECT group_concat(i.service_name, ' + ') FROM appointment_items i WHERE i.appointment_id = a.id) AS services,
    (SELECT COALESCE(SUM(i.duration_min), 0) FROM appointment_items i WHERE i.appointment_id = a.id) AS duration_min
  FROM appointments a
  JOIN customers c ON c.id = a.customer_id
  JOIN barbers b ON b.id = a.barber_id`;

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refund_due';

export function paymentStatus(row: { status: string; total_minor: number; paid_minor: number }): PaymentStatus {
  if ((row.status === 'cancelled' || row.status === 'no_show') && row.paid_minor > 0) return 'refund_due';
  if (row.paid_minor <= 0) return row.total_minor === 0 ? 'paid' : 'unpaid';
  return row.paid_minor >= row.total_minor ? 'paid' : 'partial';
}

export function shapeAppointment(row: any) {
  return { ...row, balance_minor: row.total_minor - row.paid_minor, payment_status: paymentStatus(row) };
}

export type Appointment = ReturnType<typeof shapeAppointment>;

export function getAppointment(id: number): Appointment {
  const row = get(`${APPT_SELECT} WHERE a.id = ?`, id);
  if (!row) throw notFound('Appointment');
  return shapeAppointment(row);
}

export function appointmentDetail(id: number) {
  const appt = getAppointment(id);
  const items = all('SELECT id, service_id, service_name, price_minor, duration_min FROM appointment_items WHERE appointment_id = ? ORDER BY id', id);
  const payments = all(
    `SELECT p.id, p.public_id, p.kind, p.amount_minor, p.currency, p.method, p.reference, p.note, p.created_at, p.reverses_payment_id,
       u.name AS recorded_by_name, (SELECT v.id FROM payments v WHERE v.reverses_payment_id = p.id) AS voided_by
     FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.appointment_id = ? ORDER BY p.created_at, p.id`,
    id,
  );
  const completedBy = appt.completed_by ? get<any>('SELECT name FROM users WHERE id = ?', appt.completed_by)?.name ?? null : null;
  return { ...appt, items, payments, completed_by_name: completedBy };
}

export interface AppointmentFilter {
  from?: number; to?: number; barberId?: number; customerId?: number; status?: string; q?: string;
  limit?: number; offset?: number; order?: 'asc' | 'desc';
}

export function listAppointments(f: AppointmentFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from != null) { where.push('a.starts_at >= ?'); params.push(f.from); }
  if (f.to != null) { where.push('a.starts_at < ?'); params.push(f.to); }
  if (f.barberId) { where.push('a.barber_id = ?'); params.push(f.barberId); }
  if (f.customerId) { where.push('a.customer_id = ?'); params.push(f.customerId); }
  if (f.status) { where.push('a.status = ?'); params.push(f.status); }
  if (f.q) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR a.reference LIKE ?)');
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<any>(`SELECT COUNT(*) AS n FROM appointments a JOIN customers c ON c.id = a.customer_id ${w}`, ...params)!.n as number;
  const rows = all(
    `${APPT_SELECT} ${w} ORDER BY a.starts_at ${f.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
    ...params, Math.min(f.limit ?? 500, 1000), f.offset ?? 0,
  ).map(shapeAppointment);
  return { rows, total };
}
