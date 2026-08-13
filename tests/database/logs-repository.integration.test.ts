import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureDailyPartition,
  forgetKnownPartition,
} from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';

const testDate = new Date('2450-03-17T00:00:00.000Z');
const testPartition = 'logs_2450_03_17';
const testService = 'integration-test-repository-2450-03-17';

function logAt(
  timestamp: string,
  overrides: Partial<ValidLog> = {},
): ValidLog {
  return {
    timestamp,
    level: 'info',
    service: testService,
    message: 'repository integration event',
    attributes: {},
    ...overrides,
  };
}

async function countTestRows(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM logs WHERE service = $1',
    [testService],
  );

  return Number(result.rows[0]?.count);
}

describe('insertLogs', () => {
  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${testPartition}`);
    forgetKnownPartition(testPartition);
    await ensureDailyPartition(testDate);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM logs WHERE service = $1', [testService]);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${testPartition}`);
    forgetKnownPartition(testPartition);
    await pool.end();
  });

  it('accepts an empty array without inserting rows', async () => {
    await expect(insertLogs([])).resolves.toBeUndefined();

    expect(await countTestRows()).toBe(0);
  });

  it('persists a single log', async () => {
    const log = logAt('2450-03-17T01:02:03.000Z');

    await insertLogs([log]);

    expect(await countTestRows()).toBe(1);
  });

  it('persists every log in a multi-log input', async () => {
    const logs = [
      logAt('2450-03-17T02:00:00.000Z', { message: 'first event' }),
      logAt('2450-03-17T02:00:01.000Z', { message: 'second event' }),
      logAt('2450-03-17T02:00:02.000Z', { message: 'third event' }),
    ];

    await insertLogs(logs);

    expect(await countTestRows()).toBe(3);
  });

  it('round-trips every log field correctly', async () => {
    const log = logAt('2450-03-17T03:04:05.678Z', {
      level: 'error',
      service: testService,
      message: 'round-trip event',
      attributes: {
        traceId: 'trace-123',
        durationMs: 12.5,
        cached: true,
      },
    });

    await insertLogs([log]);

    const result = await pool.query<{
      timestamp: Date;
      level: string;
      service: string;
      message: string;
      attributes: Record<string, unknown>;
    }>(
      `
        SELECT timestamp, level, service, message, attributes
        FROM logs
        WHERE service = $1
      `,
      [testService],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.timestamp.toISOString()).toBe(log.timestamp);
    expect(result.rows[0]).toMatchObject({
      level: log.level,
      service: log.service,
      message: log.message,
      attributes: log.attributes,
    });
  });

  it('stores quotes and SQL-like message text literally and safely', async () => {
    const message = "test'); DROP TABLE logs; --";

    await insertLogs([
      logAt('2450-03-17T05:00:00.000Z', { message }),
    ]);

    const result = await pool.query<{ message: string }>(
      'SELECT message FROM logs WHERE service = $1',
      [testService],
    );
    const tableResult = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.logs')::text AS name",
    );

    expect(result.rows).toEqual([{ message }]);
    expect(tableResult.rows).toEqual([{ name: 'logs' }]);
  });
});
