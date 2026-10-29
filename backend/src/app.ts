import express, { Router, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { authenticate } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { inventoryRouter } from './routes/inventory.js';
import { productsRouter } from './routes/products.js';
import { receivingRouter } from './routes/receiving.js';

export interface AppDeps {
  pool: Pool;
  config: Config;
  /** Defaults to console. Tests pass a silent logger. */
  log?: (msg: string, err?: unknown) => void;
}

/** Builds the Express app. Used by server.ts and by the integration tests (no listen() here). */
export function createApp({ pool, config, log }: AppDeps): Express {
  const logger = log ?? ((msg: string, err?: unknown) => console.error(msg, err));
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  if (config.LOG_REQUESTS) app.use(requestLogger());

  const api = Router();
  api.use('/health', healthRouter(pool));
  api.use('/auth', authRouter(pool, config));

  // Everything below requires a valid token (FR-AUTH-2).
  const protectedApi = Router();
  protectedApi.use(authenticate(pool, config));
  protectedApi.use('/products', productsRouter(pool));
  protectedApi.use('/receiving-documents', receivingRouter(pool));
  protectedApi.use('/inventory', inventoryRouter(pool));
  protectedApi.use(notFoundHandler);
  api.use(protectedApi);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

/** One structured log line per request (NFR-5). */
function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          ms: Math.round(ms * 10) / 10,
          user: req.user?.id ?? null,
        }),
      );
    });
    next();
  };
}
