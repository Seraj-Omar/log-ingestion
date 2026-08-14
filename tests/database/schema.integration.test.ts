import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureDailyPartition,
  forgetKnownPartition,
} from '../../src/database/partitions.js';
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

const partitionAutovacuumOptions = [
  'autovacuum_vacuum_insert_scale_factor=0.005',
  'autovacuum_vacuum_insert_threshold=10000',
  'autovacuum_analyze_scale_factor=0.01',
  'autovacuum_analyze_threshold=10000',
];

const timestampBrinOptions = [
  'pages_per_range=32',
  'autosummarize=on',
];

describe('logs schema', () => {
  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${constraintTestPartition}`);
    forgetKnownPartition(constraintTestPartition);
    await ensureDailyPartition(constraintTestDate);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${constraintTestPartition}`);
    forgetKnownPartition(constraintTestPartition);
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

  it('uses low insert-trigger autovacuum settings on every partition', async () => {
    const result = await pool.query<{
      partition_name: string;
      options: string[] | null;
    }>(`
      SELECT
        child.relname AS partition_name,
        child.reloptions AS options
      FROM pg_inherits AS table_inheritance
      JOIN pg_class AS child
        ON child.oid = table_inheritance.inhrelid
      WHERE table_inheritance.inhparent = 'logs'::regclass
      ORDER BY child.relname
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    for (const partition of result.rows) {
      expect(partition.options).toEqual(
        expect.arrayContaining(partitionAutovacuumOptions),
      );
    }
  });

  it('enables the pg_trgm extension', async () => {
    const result = await pool.query<{ is_installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'pg_trgm'
      ) AS is_installed
    `);

    expect(result.rows).toEqual([{ is_installed: true }]);
  });

  it('indexes service and descending time order on every partition', async () => {
    const parentIndex = await pool.query<{
      definition: string;
      is_valid: boolean;
    }>(`
      SELECT
        pg_get_indexdef(indexrelid) AS definition,
        indisvalid AS is_valid
      FROM pg_index
      WHERE indexrelid = 'logs_service_timestamp_id_idx'::regclass
    `);
    const partitionIndexes = await pool.query<{
      partition_name: string;
      has_valid_service_time_index: boolean;
    }>(`
      WITH child_partitions AS (
        SELECT
          child.oid AS table_oid,
          child.relname AS partition_name
        FROM pg_inherits AS table_inheritance
        JOIN pg_class AS child
          ON child.oid = table_inheritance.inhrelid
        WHERE table_inheritance.inhparent = 'logs'::regclass
      ),
      attached_indexes AS (
        SELECT
          child_index.indrelid AS table_oid,
          child_index.indisvalid AS is_valid,
          pg_get_indexdef(child_index.indexrelid) AS definition
        FROM pg_inherits AS index_inheritance
        JOIN pg_index AS child_index
          ON child_index.indexrelid = index_inheritance.inhrelid
        WHERE index_inheritance.inhparent =
          'logs_service_timestamp_id_idx'::regclass
      )
      SELECT
        child_partitions.partition_name,
        COALESCE(
          bool_or(
            attached_indexes.is_valid
            AND attached_indexes.definition ~
              'USING btree \\(service, "timestamp" DESC, id DESC\\)'
          ),
          false
        ) AS has_valid_service_time_index
      FROM child_partitions
      LEFT JOIN attached_indexes
        ON attached_indexes.table_oid = child_partitions.table_oid
      GROUP BY child_partitions.partition_name
      ORDER BY child_partitions.partition_name
    `);

    expect(parentIndex.rows).toHaveLength(1);
    expect(parentIndex.rows[0]).toMatchObject({ is_valid: true });
    expect(parentIndex.rows[0]?.definition).toMatch(
      /USING btree \(service, "timestamp" DESC, id DESC\)/,
    );
    expect(partitionIndexes.rows.length).toBeGreaterThan(0);
    expect(
      partitionIndexes.rows.every(
        ({ has_valid_service_time_index }) => has_valid_service_time_index,
      ),
    ).toBe(true);
  });

  it('indexes messages with trigram GIN on every partition', async () => {
    const parentIndex = await pool.query<{
      definition: string;
      is_valid: boolean;
    }>(`
      SELECT
        pg_get_indexdef(indexrelid) AS definition,
        indisvalid AS is_valid
      FROM pg_index
      WHERE indexrelid = 'logs_message_trgm_idx'::regclass
    `);
    const partitionIndexes = await pool.query<{
      partition_name: string;
      has_valid_message_trigram_index: boolean;
    }>(`
      WITH child_partitions AS (
        SELECT
          child.oid AS table_oid,
          child.relname AS partition_name
        FROM pg_inherits AS table_inheritance
        JOIN pg_class AS child
          ON child.oid = table_inheritance.inhrelid
        WHERE table_inheritance.inhparent = 'logs'::regclass
      ),
      attached_indexes AS (
        SELECT
          child_index.indrelid AS table_oid,
          child_index.indisvalid AS is_valid,
          pg_get_indexdef(child_index.indexrelid) AS definition
        FROM pg_inherits AS index_inheritance
        JOIN pg_index AS child_index
          ON child_index.indexrelid = index_inheritance.inhrelid
        WHERE index_inheritance.inhparent =
          'logs_message_trgm_idx'::regclass
      )
      SELECT
        child_partitions.partition_name,
        COALESCE(
          bool_or(
            attached_indexes.is_valid
            AND attached_indexes.definition ~
              'USING gin \\(message gin_trgm_ops\\)'
          ),
          false
        ) AS has_valid_message_trigram_index
      FROM child_partitions
      LEFT JOIN attached_indexes
        ON attached_indexes.table_oid = child_partitions.table_oid
      GROUP BY child_partitions.partition_name
      ORDER BY child_partitions.partition_name
    `);

    expect(parentIndex.rows).toHaveLength(1);
    expect(parentIndex.rows[0]).toMatchObject({ is_valid: true });
    expect(parentIndex.rows[0]?.definition).toMatch(
      /USING gin \(message gin_trgm_ops\)/,
    );
    expect(partitionIndexes.rows.length).toBeGreaterThan(0);
    expect(
      partitionIndexes.rows.every(
        ({ has_valid_message_trigram_index }) =>
          has_valid_message_trigram_index,
      ),
    ).toBe(true);
  });

  it('indexes timestamp ranges with BRIN on every partition', async () => {
    const parentIndex = await pool.query<{
      definition: string;
      is_valid: boolean;
      options: string[] | null;
    }>(`
      SELECT
        pg_get_indexdef(index_metadata.indexrelid) AS definition,
        index_metadata.indisvalid AS is_valid,
        index_relation.reloptions AS options
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      WHERE index_metadata.indexrelid = 'logs_timestamp_brin_idx'::regclass
    `);
    const partitionIndexes = await pool.query<{
      partition_name: string;
      has_valid_timestamp_brin_index: boolean;
    }>(`
      WITH child_partitions AS (
        SELECT
          child.oid AS table_oid,
          child.relname AS partition_name
        FROM pg_inherits AS table_inheritance
        JOIN pg_class AS child
          ON child.oid = table_inheritance.inhrelid
        WHERE table_inheritance.inhparent = 'logs'::regclass
      ),
      attached_indexes AS (
        SELECT
          child_index.indrelid AS table_oid,
          child_index.indisvalid AS is_valid,
          pg_get_indexdef(child_index.indexrelid) AS definition,
          child_index_relation.reloptions AS options
        FROM pg_inherits AS index_inheritance
        JOIN pg_index AS child_index
          ON child_index.indexrelid = index_inheritance.inhrelid
        JOIN pg_class AS child_index_relation
          ON child_index_relation.oid = child_index.indexrelid
        WHERE index_inheritance.inhparent =
          'logs_timestamp_brin_idx'::regclass
      )
      SELECT
        child_partitions.partition_name,
        COALESCE(
          bool_or(
            attached_indexes.is_valid
            AND attached_indexes.definition ~
              'USING brin \\("timestamp"\\) WITH'
            AND attached_indexes.options @> ARRAY[
              'pages_per_range=32',
              'autosummarize=on'
            ]::text[]
          ),
          false
        ) AS has_valid_timestamp_brin_index
      FROM child_partitions
      LEFT JOIN attached_indexes
        ON attached_indexes.table_oid = child_partitions.table_oid
      GROUP BY child_partitions.partition_name
      ORDER BY child_partitions.partition_name
    `);

    expect(parentIndex.rows).toHaveLength(1);
    expect(parentIndex.rows[0]).toMatchObject({ is_valid: true });
    expect(parentIndex.rows[0]?.options).toEqual(
      expect.arrayContaining(timestampBrinOptions),
    );
    expect(parentIndex.rows[0]?.definition).toMatch(
      /USING brin \("timestamp"\) WITH/,
    );
    expect(partitionIndexes.rows.length).toBeGreaterThan(0);
    expect(
      partitionIndexes.rows.every(
        ({ has_valid_timestamp_brin_index }) =>
          has_valid_timestamp_brin_index,
      ),
    ).toBe(true);
  });
});
