import './env.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === 'production';

mkdirSync(dataDir, { recursive: true });

const app = await buildApp({
  dataDir,
  staticDir: production ? path.join(root, 'dist', 'client') : undefined,
  secureCookies: process.env.SECURE_COOKIES === '1',
  logger: true,
});

// In production (e.g. Railway) listen on all interfaces; locally stay on loopback.
await app.listen({ port, host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1') });

// Close cleanly on redeploy/shutdown so in-flight saves finish and SQLite is checkpointed.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
