import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT } from './config.ts';
import { getDb } from './db.ts';
import { csrfMiddleware, sessionMiddleware } from './lib/auth.ts';
import { errorHandler, HttpError } from './lib/http.ts';
import { adminRouter, uploadDir } from './routes/admin.ts';
import { authRouter } from './routes/auth.ts';
import { meRouter } from './routes/me.ts';
import { publicRouter } from './routes/public.ts';
import { staffRouter } from './routes/staff.ts';

export function createApp() {
  getDb();
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: config.cookieSecure,
  }));

  app.use('/api/admin/uploads', express.json({ limit: '5mb' }));
  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', sessionMiddleware, csrfMiddleware);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/public', publicRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Unknown API route.')));

  app.use('/uploads', express.static(uploadDir(), { maxAge: '30d', index: false }));

  // Production: serve the built single-page app from /dist.
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
