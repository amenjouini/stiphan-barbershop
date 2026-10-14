import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: defaults below apply.
}

const env = process.env;
const bool = (v: string | undefined) => v === 'true' || v === '1';

export const config = {
  port: Number(env.PORT || 4000),
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
  databasePath: env.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(ROOT, env.DATABASE_PATH || './data/clubbarber.db'),
  cookieSecure: bool(env.COOKIE_SECURE),
  trustProxy: Number(env.TRUST_PROXY || 0),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: bool(env.SMTP_SECURE),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.EMAIL_FROM || '',
  },
};

export const emailConfigured = () => Boolean(config.smtp.host);
