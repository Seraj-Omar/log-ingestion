import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDailyPartition,
  ensureRollingPartitions,
} from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';

const dailyPartitionDate = new Date('2500-01-15T18:42:00.000Z');
const rollingReferenceDate = new Date('2501-06-15T12:00:00.000Z');
const testPartitionNames = [
  'logs_2500_01_15',
  'logs_2501_06_14',
  'logs_2501_06_15',
  'logs_2501_06_16',
] as const;

async function dropTestPartitions(): Promise<void> {
  for (const name of testPartitionNames) {
    await pool.query(`DROP TABLE IF EXISTS ${name}`);
  }
}

describe('partition management', () => {
  beforeEach(async () => {
    await dropTestPartitions();
  });

  afterEach(async () => {
    await dropTestPartitions();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an idempotent daily partition with UTC-day boundaries', async () => {
    await ensureDailyPartition(dailyPartitionDate);
    await ensureDailyPartition(dailyPartitionDate);

    const client = await pool.connect();

    try {
      await client.query("SET TIME ZONE 'UTC'");

      const result = await client.query<{ name: string; boundary: string }>(`
        SELECT
          child.relname AS name,
          pg_get_expr(child.relpartbound, child.oid) AS boundary
        FROM pg_class AS child
        JOIN pg_inherits AS inheritance
          ON inheritance.inhrelid = child.oid
        WHERE inheritance.inhparent = 'logs'::regclass
          AND child.relname = 'logs_2500_01_15'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe('logs_2500_01_15');
      expect(result.rows[0]?.boundary).toContain(
        "FROM ('2500-01-15 00:00:00+00')",
      );
      expect(result.rows[0]?.boundary).toContain(
        "TO ('2500-01-16 00:00:00+00')",
      );
    } finally {
      client.release();
    }
  });

  it('creates the requested rolling partition range around a reference date', async () => {
    await ensureRollingPartitions(1, 1, rollingReferenceDate);

    const result = await pool.query<{ name: string }>(`
      SELECT child.relname AS name
      FROM pg_class AS child
      JOIN pg_inherits AS inheritance
        ON inheritance.inhrelid = child.oid
      WHERE inheritance.inhparent = 'logs'::regclass
        AND child.relname = ANY($1::text[])
      ORDER BY child.relname
    `, [[
      'logs_2501_06_14',
      'logs_2501_06_15',
      'logs_2501_06_16',
    ]]);

    expect(result.rows.map(({ name }) => name)).toEqual([
      'logs_2501_06_14',
      'logs_2501_06_15',
      'logs_2501_06_16',
    ]);
  });
});
