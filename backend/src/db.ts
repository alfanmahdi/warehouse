import pg from 'pg';

// bigint (int8) -> JS number. Safe: stock totals stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE -> 'YYYY-MM-DD' string (default would create a timezone-shifted Date object).
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

/**
 * Runs `fn` inside a transaction (READ COMMITTED). Commits on success, rolls back on any error.
 * Correctness of concurrent writes relies on explicit row locks inside `fn`, not on isolation level.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken; original error is more useful */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Escapes LIKE wildcards so user search text is matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function isPgError(err: unknown): err is pg.DatabaseError {
  return typeof err === 'object' && err !== null && 'code' in err && 'severity' in err;
}
