import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import {
  aggregateLogs,
  type AggregateRow,
} from '../../src/repositories/aggregate.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { AggregateQueryFilters } from '../../src/schemas/aggregate-query.js';
import type { ValidLog } from '../../src/schemas/log.js';

const servicePrefix = 'integration-rollup-aggregate-2593';
const serviceA = `${servicePrefix}-a`;
const serviceB = `${servicePrefix}-b`;

const testServices = [
  serviceA,
  serviceB,
] as const;

function filters(
  overrides: Partial<AggregateQueryFilters> = {},
): AggregateQueryFilters {
  const {
    attributes = {},
    ...rest
  } = overrides;

  return {
    since: '2593-06-15T10:00:00.000Z',
    until: '2593-06-15T10:05:00.000Z',
    bucket: '1m',
    attributes,
    ...rest,
  };
}

function log(
  timestamp: string,
  level: ValidLog['level'],
  service: string,
  message: string,
  attributes: ValidLog['attributes'] = {},
): ValidLog {
  return {
    timestamp,
    level,
    service,
    message,
    attributes,
  };
}

function bucketCounts(
  rows: AggregateRow[],
): Array<[string, string]> {
  return rows.map(
    ({ bucket, count }) => [
      bucket.toISOString(),
      count,
    ],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(
    `
      DELETE FROM logs
      WHERE service = ANY($1::text[])
    `,
    [testServices],
  );

  await pool.query(
    `
      DELETE FROM log_rollups_1m
      WHERE service = ANY($1::text[])
    `,
    [testServices],
  );
}

describe('aggregateLogs minute rollup path', () => {
  beforeAll(async () => {
    await ensureDailyPartition(
      new Date(
        '2593-06-15T10:00:00.000Z',
      ),
    );

    await cleanup();

    await insertLogs([
      log(
        '2593-06-15T10:00:10.000Z',
        'info',
        serviceA,
        'startup complete',
        {
          region: 'eu-west',
        },
      ),

      log(
        '2593-06-15T10:00:40.000Z',
        'error',
        serviceA,
        'payment needle failure',
        {
          region: 'us-east',
        },
      ),

      log(
        '2593-06-15T10:01:05.000Z',
        'info',
        serviceA,
        'request accepted',
        {
          region: 'eu-west',
        },
      ),

      log(
        '2593-06-15T10:01:20.000Z',
        'info',
        serviceB,
        'request accepted',
        {
          region: 'eu-west',
        },
      ),

      log(
        '2593-06-15T10:02:10.000Z',
        'warn',
        serviceA,
        'latency warning',
        {
          region: 'eu-west',
        },
      ),

      log(
        '2593-06-15T10:02:50.000Z',
        'error',
        serviceB,
        'database failure',
        {
          region: 'us-east',
        },
      ),

      log(
        '2593-06-15T10:03:00.000Z',
        'info',
        serviceA,
        'worker ready',
        {
          region: 'eu-west',
        },
      ),

      log(
        '2593-06-15T10:04:59.000Z',
        'warn',
        serviceB,
        'queue warning',
        {
          region: 'eu-west',
        },
      ),

      /*
       * Outside the normal 10:00 -> 10:05
       * test interval.
       */
      log(
        '2593-06-15T10:05:01.000Z',
        'info',
        serviceA,
        'outside range',
        {
          region: 'eu-west',
        },
      ),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('uses minute rollups correctly for fully aligned boundaries', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '8',
      ],
    ]);
  });

  it('handles a partial first minute exactly', async () => {
    const rows = await aggregateLogs(
      filters({
        since:
          '2593-06-15T10:00:30.000Z',
        until:
          '2593-06-15T10:03:00.000Z',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '1',
      ],
      [
        '2593-06-15T10:01:00.000Z',
        '2',
      ],
      [
        '2593-06-15T10:02:00.000Z',
        '2',
      ],
    ]);
  });

  it('handles a partial last minute exactly', async () => {
    const rows = await aggregateLogs(
      filters({
        since:
          '2593-06-15T10:01:00.000Z',
        until:
          '2593-06-15T10:03:20.000Z',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:01:00.000Z',
        '2',
      ],
      [
        '2593-06-15T10:02:00.000Z',
        '2',
      ],
      [
        '2593-06-15T10:03:00.000Z',
        '1',
      ],
    ]);
  });

  it('handles partial first and last minutes together', async () => {
    const rows = await aggregateLogs(
      filters({
        since:
          '2593-06-15T10:00:30.000Z',
        until:
          '2593-06-15T10:03:20.000Z',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '1',
      ],
      [
        '2593-06-15T10:01:00.000Z',
        '2',
      ],
      [
        '2593-06-15T10:02:00.000Z',
        '2',
      ],
      [
        '2593-06-15T10:03:00.000Z',
        '1',
      ],
    ]);
  });

  it('combines raw boundary rows and rollup rows into the same larger bucket', async () => {
    const rows = await aggregateLogs(
      filters({
        since:
          '2593-06-15T10:00:30.000Z',
        until:
          '2593-06-15T10:04:30.000Z',
        bucket: '5m',
      }),
    );

    /*
     * Included:
     *
     * 10:00:40
     * 10:01:05
     * 10:01:20
     * 10:02:10
     * 10:02:50
     * 10:03:00
     *
     * 10:00:10 excluded by since.
     * 10:04:59 excluded by until.
     */
    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '6',
      ],
    ]);
  });

  it('groups rollup-backed aggregation by service', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        group_by: 'service',
      }),
    );

    const groups = rows
      .map(
        ({
          group_value,
          count,
        }) => [
          group_value,
          count,
        ],
      )
      .sort(
        ([left], [right]) =>
          String(left).localeCompare(
            String(right),
          ),
      );

    expect(groups).toEqual([
      [serviceA, '5'],
      [serviceB, '3'],
    ]);
  });

  it('groups rollup-backed aggregation by level', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        group_by: 'level',
      }),
    );

    const groups = rows
      .map(
        ({
          group_value,
          count,
        }) => [
          group_value,
          count,
        ],
      )
      .sort(
        ([left], [right]) =>
          String(left).localeCompare(
            String(right),
          ),
      );

    expect(groups).toEqual([
      ['error', '2'],
      ['info', '4'],
      ['warn', '2'],
    ]);
  });

  it('applies a service filter using rollups', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        service: serviceA,
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '5',
      ],
    ]);
  });

  it('applies a level filter using rollups', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        level: 'info',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '4',
      ],
    ]);
  });

  it('falls back to raw logs when the interval contains no complete minute', async () => {
    const rows = await aggregateLogs(
      filters({
        since:
          '2593-06-15T10:00:20.000Z',
        until:
          '2593-06-15T10:00:50.000Z',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '1',
      ],
    ]);
  });

  it('falls back to raw logs for q filtering', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        q: 'needle',
      }),
    );

    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '1',
      ],
    ]);
  });

  it('falls back to raw logs for attribute filtering', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '5m',
        attributes: {
          region: 'us-east',
        },
      }),
    );

    /*
     * 10:00:40 serviceA error
     * 10:02:50 serviceB error
     */
    expect(
      bucketCounts(rows),
    ).toEqual([
      [
        '2593-06-15T10:00:00.000Z',
        '2',
      ],
    ]);
  });
});
