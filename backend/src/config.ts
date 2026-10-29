import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(60).default(8 * 60 * 60),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  LOG_REQUESTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

/** Parses and validates the environment. Throws a readable error on bad config (fail fast). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

const migrateEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  SEED_OPERATOR_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),
  SEED_SUPERVISOR_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),
});

export type MigrateConfig = z.infer<typeof migrateEnvSchema>;

/** Config for the migrate/seed job (does not need JWT_SECRET). */
export function loadMigrateConfig(env: NodeJS.ProcessEnv = process.env): MigrateConfig {
  // Treat empty strings (e.g. from compose `${VAR:-}`) as "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = migrateEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
