import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabaseConnection, pool } from '../../src/database/pool.js';

describe('PostgreSQL connection', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('connects to PostgreSQL and executes a query', async () => {
    await expect(checkDatabaseConnection()).resolves.toBeUndefined();

    const result = await pool.query<{ value: number }>('SELECT 1 AS value');

    expect(result.rows).toEqual([{ value: 1 }]);
  });
});
