import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.ts';
import { requireRole } from '../lib/auth.ts';
import { h, idParam, notFound, parse, zText } from '../lib/http.ts';
import { assertCustomerCanChange, reschedule, setStatus } from '../services/appointments.ts';
import { customerStats } from '../services/finance.ts';
import { customerView, saveReview } from './public.ts';

/** Routes for signed-in customers. Every query is scoped to the caller's own customer record. */
export const meRouter = Router();
meRouter.use(requireRole('customer'));

/** Resolves an appointment id only if it belongs to the signed-in customer (404 otherwise, never 403, to avoid leaking existence). */
function own(req: any): number {
  const id = idParam(req);
  const row = get<any>('SELECT customer_id FROM appointments WHERE id = ?', id);
  if (!row || !req.user.customerId || row.customer_id !== req.user.customerId) throw notFound('Appointment');
  return id;
}

meRouter.get('/appointments', h((req) => {
  const cid = req.user!.customerId;
  if (!cid) return { upcoming: [], past: [], stats: null };
  const now = Date.now();
  const ids = all<any>('SELECT id, starts_at, status FROM appointments WHERE customer_id = ? ORDER BY starts_at DESC LIMIT 200', cid);
  const isUpcoming = (a: any) => a.ends_at > now && ['pending', 'confirmed', 'checked_in', 'in_progress'].includes(a.status);
  const views = ids.map((r) => customerView(r.id, now));
  return {
    upcoming: views.filter(isUpcoming).reverse(),
    past: views.filter((a) => !isUpcoming(a)),
    stats: customerStats(cid),
  };
}));

meRouter.get('/appointments/:id', h((req) => ({ appointment: customerView(own(req)) })));

meRouter.get('/payments', h((req) => {
  const cid = req.user!.customerId;
  if (!cid) return { payments: [] };
  return {
    payments: all(
      `SELECT p.public_id, p.kind, p.amount_minor, p.currency, p.method, p.created_at, a.reference
       FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE p.customer_id = ? ORDER BY p.created_at DESC LIMIT 200`, cid),
  };
}));

meRouter.post('/appointments/:id/cancel', h((req) => {
  const id = own(req);
  const { reason } = parse(z.object({ reason: zText(300).optional() }), req.body);
  assertCustomerCanChange(customerView(id), 'cancel');
  setStatus(id, 'cancelled', req.user!, { reason: reason || 'Cancelled by customer' });
  return { appointment: customerView(id) };
}));

meRouter.post('/appointments/:id/reschedule', h((req) => {
  const id = own(req);
  const { start } = parse(z.object({ start: z.number().int().positive() }), req.body);
  assertCustomerCanChange(customerView(id), 'reschedule');
  reschedule(id, { start, actor: req.user });
  return { appointment: customerView(id) };
}));

meRouter.post('/appointments/:id/review', h((req) => {
  const id = own(req);
  saveReview(id, req.body);
  return { appointment: customerView(id) };
}));
