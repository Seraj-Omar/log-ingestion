import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import type { ValidLog } from '../../src/schemas/log.js';
import { ingestLogs } from '../../src/services/ingest-logs.js';

const testService = 'integration-test-ingestion-service';
const existingPartitionDate = new Date('2460-01-10T00:00:00.000Z');
const testPartitions = [
  'logs_2460_01_10',
  'logs_2461_02_11',
  'logs_2462_03_12',
  'logs_2463_04_13',
  'logs_2463_04_14',
] as const;

function logAt(
  timestamp: string,
  message: string,
  attributes: ValidLog['attributes'] = {},
): ValidLog {
  return {
    timestamp,
    level: 'info',
    service: testService,
    message,
    attributes,
  };
}

async function dropTestPartitions(): Promise<void> {
  for (const partition of testPartitions) {
    await pool.query(`DROP TABLE IF EXISTS ${partition}`);
  }
}

async function deleteTestRows(): Promise<void> {
  await pool.query('DELETE FROM logs WHERE service = $1', [testService]);
}

async function countRows(messagePrefix: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*) AS count
      FROM logs
      WHERE service = $1 AND message LIKE $2
    `,
    [testService, `${messagePrefix}%`],
  );

  return Number(result.rows[0]?.count);
}

async function partitionExists(name: string): Promise<boolean> {
  const result = await pool.query<{ partition: string | null }>(
    'SELECT to_regclass($1)::text AS partition',
    [`public.${name}`],
  );

  return result.rows[0]?.partition === name;
}

describe('ingestLogs', () => {
  beforeAll(async () => {
    await dropTestPartitions();
    await ensureDailyPartition(existingPartitionDate);
  });

  afterAll(async () => {
    await deleteTestRows();
    await dropTestPartitions();
    await pool.end();
  });

  it('persists a valid log into an already existing partition', async () => {
    const log = logAt(
      '2460-01-10T08:00:00.000Z',
      'existing-partition-event',
    );

    await ingestLogs([log]);

    expect(await countRows('existing-partition-event')).toBe(1);
  });

  it('creates a missing historical partition and persists the log', async () => {
    const partition = 'logs_2461_02_11';
    const log = logAt(
      '2461-02-11T09:00:00.000Z',
      'missing-partition-event',
    );

    expect(await partitionExists(partition)).toBe(false);

    await ingestLogs([log]);

    expect(await partitionExists(partition)).toBe(true);
    expect(await countRows('missing-partition-event')).toBe(1);
  });

  it('persists multiple logs from the same day', async () => {
    const logs = [
      logAt('2462-03-12T01:00:00.000Z', 'same-day-first'),
      logAt('2462-03-12T23:59:59.000Z', 'same-day-second'),
    ];

    await ingestLogs(logs);

    expect(await countRows('same-day-')).toBe(2);
  });

  it('creates partitions and persists logs across different days', async () => {
    const firstPartition = 'logs_2463_04_13';
    const secondPartition = 'logs_2463_04_14';
    const logs = [
      logAt('2463-04-13T23:59:59.000Z', 'cross-day-first'),
      logAt('2463-04-14T00:00:00.000Z', 'cross-day-second'),
    ];

    await ingestLogs(logs);

    expect(await partitionExists(firstPartition)).toBe(true);
    expect(await partitionExists(secondPartition)).toBe(true);
    expect(await countRows('cross-day-')).toBe(2);
  });

  it('accepts empty input without creating log rows', async () => {
    const rowsBefore = await countRows('empty-input-');

    await expect(ingestLogs([])).resolves.toBeUndefined();

    expect(await countRows('empty-input-')).toBe(rowsBefore);
  });
});
