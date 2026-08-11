import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';

const constraintTestDate = new Date('2499-12-31T12:00:00.000Z');
const constraintTestPartition = 'logs_2499_12_31';

interface ColumnDescription {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  is_identity: 'YES' | 'NO';
  identity_generation: 'ALWAYS' | 'BY DEFAULT' | null;
}

describe('logs schema', () => {
  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${constraintTestPartition}`);
    await ensureDailyPartition(constraintTestDate);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${constraintTestPartition}`);
    await pool.end();
  });

  it('exists and is range-partitioned by timestamp', async () => {
    const result = await pool.query<{
      relation_kind: string;
      partition_key: string;
    }>(`
      SELECT
        relation.relkind AS relation_kind,
        pg_get_partkeydef(relation.oid) AS partition_key
      FROM pg_class AS relation
      WHERE relation.oid = to_regclass('public.logs')
    `);

    expect(result.rows).toEqual([
      {
        relation_kind: 'p',
        partition_key: 'RANGE ("timestamp")',
      },
    ]);
  });

  it('has the expected core columns and types', async () => {
    const result = await pool.query<ColumnDescription>(`
      SELECT
        column_name,
        data_type,
        is_nullable,
        is_identity,
        identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'logs'
      ORDER BY ordinal_position
    `);

    const columns = Object.fromEntries(
      result.rows.map((column) => [column.column_name, column]),
    );

    expect(columns.id).toMatchObject({
      data_type: 'bigint',
      is_nullable: 'NO',
      is_identity: 'YES',
      identity_generation: 'ALWAYS',
    });
    expect(columns.timestamp).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
    });
    expect(columns.level).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(columns.service).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(columns.message).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(columns.attributes).toMatchObject({
      data_type: 'jsonb',
      is_nullable: 'NO',
    });
  });

  it('rejects a level outside the database constraint', async () => {
    await expect(
      pool.query(
        `
          INSERT INTO logs (timestamp, level, service, message)
          VALUES ($1, $2, $3, $4)
        `,
        [constraintTestDate, 'critical', 'schema-test', 'must be rejected'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
