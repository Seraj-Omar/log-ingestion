import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';

const service = 'integration-rollup-persistence';
const timestamp = '2592-04-10T12:34:10.000Z';
const bucketStart = '2592-04-10T12:34:00.000Z';

function log(
  seconds: number,
  level: ValidLog['level'] = 'info',
): ValidLog {
  return {
    timestamp: `2592-04-10T12:34:${String(seconds).padStart(2, '0')}.000Z`,
    level,
    service,
    message: `rollup integration ${seconds}`,
    attributes: {},
  };
}

async function cleanup(): Promise<void> {
  await pool.query(
    'DELETE FROM logs WHERE service = $1',
    [service],
  );

  await pool.query(
    'DELETE FROM log_rollups_1m WHERE service = $1',
    [service],
  );
}

describe('log minute rollup persistence', () => {
  beforeAll(async () => {
    await ensureDailyPartition(
      new Date(timestamp),
    );

    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('persists raw logs and their minute rollup atomically', async () => {
    await insertLogs([
      log(10),
      log(20),
      log(50),
    ]);

    const raw = await pool.query<{
      count: string;
    }>(
      `
        SELECT COUNT(*)::BIGINT AS count
        FROM logs
        WHERE service = $1
      `,
      [service],
    );

    const rollup = await pool.query<{
      bucket_start: Date;
      service: string;
      level: string;
      count: string;
    }>(
      `
        SELECT
          bucket_start,
          service,
          level,
          count
        FROM log_rollups_1m
        WHERE service = $1
      `,
      [service],
    );

    expect(raw.rows).toEqual([
      {
        count: '3',
      },
    ]);

    expect(rollup.rows).toEqual([
      {
        bucket_start:
          new Date(bucketStart),
        service,
        level: 'info',
        count: '3',
      },
    ]);
  });

  it('increments an existing minute rollup on a later write', async () => {
    await insertLogs([
      log(55),
      log(56),
    ]);

    const raw = await pool.query<{
      count: string;
    }>(
      `
        SELECT COUNT(*)::BIGINT AS count
        FROM logs
        WHERE service = $1
      `,
      [service],
    );

    const rollup = await pool.query<{
      count: string;
    }>(
      `
        SELECT count
        FROM log_rollups_1m
        WHERE bucket_start = $1
          AND service = $2
          AND level = 'info'
      `,
      [
        bucketStart,
        service,
      ],
    );

    expect(raw.rows[0]?.count).toBe('5');
    expect(
      rollup.rows[0]?.count,
    ).toBe('5');
  });

  it('keeps levels as separate rollup dimensions', async () => {
    await insertLogs([
      log(57, 'error'),
      log(58, 'error'),
    ]);

    const rows = await pool.query<{
      level: string;
      count: string;
    }>(
      `
        SELECT level, count
        FROM log_rollups_1m
        WHERE bucket_start = $1
          AND service = $2
        ORDER BY level
      `,
      [
        bucketStart,
        service,
      ],
    );

    expect(rows.rows).toEqual([
      {
        level: 'error',
        count: '2',
      },
      {
        level: 'info',
        count: '5',
      },
    ]);
  });

  it('rolls back the raw COPY when the rollup update fails', async () => {
    const failureService =
      `${service}-rollback`;

    const failureTimestamp =
      '2592-04-10T12:35:10.000Z';

    const failureBucket =
      '2592-04-10T12:35:00.000Z';

    await pool.query(
      `
        INSERT INTO log_rollups_1m (
          bucket_start,
          service,
          level,
          count
        )
        VALUES ($1, $2, 'info', $3)
      `,
      [
        failureBucket,
        failureService,
        '9223372036854775807',
      ],
    );

    const failureLog: ValidLog = {
      timestamp: failureTimestamp,
      level: 'info',
      service: failureService,
      message: 'must rollback',
      attributes: {},
    };

    await expect(
      insertLogs([failureLog]),
    ).rejects.toThrow();

    const raw = await pool.query<{
      count: string;
    }>(
      `
        SELECT COUNT(*)::BIGINT AS count
        FROM logs
        WHERE service = $1
      `,
      [failureService],
    );

    expect(
      raw.rows[0]?.count,
    ).toBe('0');

    await pool.query(
      `
        DELETE FROM log_rollups_1m
        WHERE service = $1
      `,
      [failureService],
    );
  });
});
