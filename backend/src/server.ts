import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = createApp({ pool, config });

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: `API listening on :${config.PORT}` }));
});

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: `${signal} received, shutting down` }));
  server.close(async () => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
