// Applies pending SQL migrations (also happens automatically on server start).
import { config } from './config.ts';
import { all, getDb } from './db.ts';
import { ensureDefaults } from './setup.ts';

getDb();
ensureDefaults();
console.log(`Database ready at ${config.databasePath}`);
console.log('Applied migrations:', all<any>('SELECT name FROM schema_migrations ORDER BY name').map((m) => m.name).join(', '));
