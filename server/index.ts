import { createApp } from './app.ts';
import { config, emailConfigured } from './config.ts';
import { get } from './db.ts';
import { seedDemo } from './seed.ts';
import { ensureDefaults } from './setup.ts';
import { startWorkers } from './services/notifications.ts';

const app = createApp();
ensureDefaults();

// Demo hosting on a free instance without a disk: the database starts empty after every
// restart, so load the demo data again. Never set this on a real installation.
if (process.env.SEED_DEMO_ON_START === 'true' && !get('SELECT 1 FROM users LIMIT 1')) {
  seedDemo();
  console.log('[club-barber] SEED_DEMO_ON_START: demo data loaded into an empty database.');
}

app.listen(config.port, () => {
  console.log(`[club-barber] listening on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
  console.log(`[club-barber] database: ${config.databasePath}`);
  console.log(emailConfigured()
    ? `[club-barber] email: SMTP via ${config.smtp.host}`
    : '[club-barber] email: SIMULATED — messages are stored in the Outbox and logged, not delivered. Set SMTP_HOST to send real email.');
  if (!get("SELECT 1 FROM users WHERE role = 'owner'")) {
    console.log('[club-barber] No owner account yet. Run `npm run seed` for demo data, or `npm run create-owner` for a clean production start.');
  }
  startWorkers();
});
