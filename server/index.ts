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

await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
