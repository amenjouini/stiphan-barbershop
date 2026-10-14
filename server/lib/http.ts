import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const bad = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'FORBIDDEN', message);
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);

/** Wraps a handler so thrown errors (sync or async) reach the error middleware; a returned value is sent as JSON. */
export const h = (fn: (req: Request, res: Response) => unknown): RequestHandler => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => {
      if (out !== undefined && !res.headersSent) res.json(out);
    })
    .catch(next);
};

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue.path.join('.');
  throw new HttpError(400, 'VALIDATION', field ? `${field}: ${issue.message}` : issue.message, { field });
}

export const idParam = (req: Request, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** Small fixed-window in-memory rate limiter for sensitive public endpoints. */
export function rateLimit(opts: { windowMs: number; max: number; name: string }): RequestHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req, _res, next) => {
    if (config.isTest) return next();
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const key = `${opts.name}:${req.ip}`;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + opts.windowMs });
      return next();
    }
    if (++entry.count > opts.max) return next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a moment and try again.'));
    next();
  };
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request body.' } });
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
}

// Reusable zod pieces
export const zEmail = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);
export const zName = z.string().trim().min(2, 'Enter a name (at least 2 characters)').max(100);
export const zPhone = z.string().trim().regex(/^\+?[0-9 ()\-.]{6,20}$/, 'Enter a valid phone number');
export const zPassword = z.string().min(8, 'Password must be at least 8 characters').max(200);
export const zText = (max = 1000) => z.string().trim().max(max);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date (YYYY-MM-DD)');
export const zId = z.coerce.number().int().positive();
export const zMinor = z.number().int().min(0).max(1_000_000_000);
