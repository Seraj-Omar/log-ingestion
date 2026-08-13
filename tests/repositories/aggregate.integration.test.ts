import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import {
  aggregateLogs,
  type AggregateRow,
} from '../../src/repositories/aggregate.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { AggregateQueryFilters } from '../../src/schemas/aggregate-query.js';
import type { ValidLog } from '../../src/schemas/log.js';

const servicePrefix = 'integration-aggregate-2591';
const serviceA = `${servicePrefix}-a`;
const serviceB = `${servicePrefix}-b`;
const injectionService = `${servicePrefix}-x' OR 1=1 --`;
const testServices = [serviceA, serviceB, injectionService] as const;

const timestamps = {
  first: '2591-08-12T10:00:05.000Z',
  second: '2591-08-12T10:00:40.000Z',
  third: '2591-08-12T10:01:10.000Z',
  injection: '2591-08-12T10:02:20.000Z',
  fourth: '2591-08-12T10:04:30.000Z',
  fifth: '2591-08-12T10:05:01.000Z',
  hourBoundary: '2591-08-12T11:00:00.000Z',
  nextDay: '2591-08-13T00:00:05.000Z',
} as const;

function filters(
  overrides: Partial<AggregateQueryFilters> = {},
): AggregateQueryFilters {
  const { attributes = {}, ...rest } = overrides;

  return {
    since: '2591-08-12T10:00:00.000Z',
    until: '2591-08-12T12:00:00.000Z',
    bucket: '1m',
    attributes: { test_suite: servicePrefix, ...attributes },
    ...rest,
  };
}

function log(
  timestamp: string,
  level: ValidLog['level'],
  service: string,
  message: string,
  attributes: ValidLog['attributes'],
): ValidLog {
  return {
    timestamp,
    level,
    service,
    message,
    attributes: { test_suite: servicePrefix, ...attributes },
  };
}

function bucketCounts(rows: AggregateRow[]): Array<[string, string]> {
  return rows.map(({ bucket, count }) => [bucket.toISOString(), count]);
}

async function deleteTestRows(): Promise<void> {
  await pool.query('DELETE FROM logs WHERE service = ANY($1::text[])', [
    testServices,
  ]);
}

describe('aggregateLogs', () => {
  beforeAll(async () => {
    await ensureDailyPartition(new Date(timestamps.first));
    await ensureDailyPartition(new Date(timestamps.nextDay));
    await deleteTestRows();

    await insertLogs([
      log(
        timestamps.first,
        'info',
        serviceA,
        '[aggregate-2591] PAYMENT ACCEPTED alpha',
        { user_id: 42, region: 'eu-west', environment: 'prod' },
      ),
      log(
        timestamps.second,
        'error',
        serviceA,
        '[aggregate-2591] Payment failed beta',
        { user_id: 42, region: 'us-east', environment: 'prod' },
      ),
      log(
        timestamps.third,
        'warn',
        serviceB,
        '[aggregate-2591] Inventory warning',
        { user_id: 7, region: 'eu-west', environment: 'prod' },
      ),
      log(
        timestamps.injection,
        'debug',
        injectionService,
        '[aggregate-2591] Literal injection-looking service',
        { suite: 'aggregate-2591' },
      ),
      log(
        timestamps.fourth,
        'error',
        serviceB,
        '[aggregate-2591] Payment retry scheduled',
        { user_id: 42, region: 'eu-west', environment: 'staging' },
      ),
      log(
        timestamps.fifth,
        'info',
        serviceA,
        '[aggregate-2591] payment accepted gamma',
        { user_id: 42, region: 'eu-west', environment: 'prod' },
      ),
      log(
        timestamps.hourBoundary,
        'warn',
        serviceA,
        '[aggregate-2591] Hour boundary payment',
        { user_id: 42, region: 'eu-west', environment: 'prod' },
      ),
      log(
        timestamps.nextDay,
        'info',
        serviceB,
        '[aggregate-2591] Next day marker',
        { user_id: 42, region: 'eu-west', environment: 'prod' },
      ),
    ]);
  });

  afterAll(async () => {
    await deleteTestRows();
    await pool.end();
  });

  it('counts rows together within a minute and separates minute buckets', async () => {
    const rows = await aggregateLogs(filters());

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '2'],
      ['2591-08-12T10:01:00.000Z', '1'],
      ['2591-08-12T10:02:00.000Z', '1'],
      ['2591-08-12T10:04:00.000Z', '1'],
      ['2591-08-12T10:05:00.000Z', '1'],
      ['2591-08-12T11:00:00.000Z', '1'],
    ]);
  });

  it('groups rows into five-minute bins', async () => {
    const rows = await aggregateLogs(filters({ bucket: '5m' }));

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '5'],
      ['2591-08-12T10:05:00.000Z', '1'],
      ['2591-08-12T11:00:00.000Z', '1'],
    ]);
  });

  it('groups rows within the same hour', async () => {
    const rows = await aggregateLogs(filters({ bucket: '1h' }));

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '6'],
      ['2591-08-12T11:00:00.000Z', '1'],
    ]);
  });

  it('groups rows within the same UTC day', async () => {
    const rows = await aggregateLogs(filters({ bucket: '1d' }));

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T00:00:00.000Z', '7'],
    ]);
  });

  it('includes a row exactly at the since boundary', async () => {
    const rows = await aggregateLogs(
      filters({
        since: timestamps.third,
        until: '2591-08-12T10:01:11.000Z',
      }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:01:00.000Z', '1'],
    ]);
  });

  it('excludes a row exactly at the until boundary', async () => {
    const rows = await aggregateLogs(
      filters({ until: timestamps.third }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '2'],
    ]);
  });

  it('returns buckets in ascending order', async () => {
    const rows = await aggregateLogs(filters());
    const times = rows.map(({ bucket }) => bucket.getTime());

    expect(times).toEqual([...times].sort((left, right) => left - right));
  });

  it('returns separate service groups and their group values per bucket', async () => {
    const rows = await aggregateLogs(
      filters({
        until: '2591-08-12T10:05:00.000Z',
        bucket: '5m',
        group_by: 'service',
      }),
    );
    const groups = rows
      .map(({ group_value, count }) => [group_value, count])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));

    expect(groups).toEqual([
      [serviceA, '2'],
      [serviceB, '2'],
      [injectionService, '1'],
    ]);
    expect(rows.every(({ bucket }) => bucket.toISOString() === '2591-08-12T10:00:00.000Z')).toBe(true);
  });

  it('returns separate level groups and their group values per bucket', async () => {
    const rows = await aggregateLogs(
      filters({
        until: '2591-08-12T10:05:00.000Z',
        bucket: '5m',
        group_by: 'level',
      }),
    );
    const groups = rows
      .map(({ group_value, count }) => [group_value, count])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));

    expect(groups).toEqual([
      ['debug', '1'],
      ['error', '2'],
      ['info', '1'],
      ['warn', '1'],
    ]);
  });

  it('counts only rows matching the service filter', async () => {
    const rows = await aggregateLogs(
      filters({ bucket: '1h', service: serviceA }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '3'],
      ['2591-08-12T11:00:00.000Z', '1'],
    ]);
  });

  it('counts only rows matching the level filter', async () => {
    const rows = await aggregateLogs(
      filters({ bucket: '1h', level: 'error' }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '2'],
    ]);
  });

  it('applies case-insensitive substring search without unrelated messages', async () => {
    const rows = await aggregateLogs(
      filters({ bucket: '1h', q: 'pAyMeNt AcCePtEd' }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '2'],
    ]);
  });

  it('matches an attribute by its string representation', async () => {
    const rows = await aggregateLogs(
      filters({ bucket: '1d', attributes: { user_id: '42' } }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T00:00:00.000Z', '5'],
    ]);
  });

  it('requires every attribute filter to match', async () => {
    const rows = await aggregateLogs(
      filters({
        bucket: '1d',
        attributes: { user_id: '42', region: 'eu-west' },
      }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T00:00:00.000Z', '4'],
    ]);
  });

  it('applies time, service, level, q, attribute, and grouping together', async () => {
    const rows = await aggregateLogs(
      filters({
        since: '2591-08-12T10:00:00.000Z',
        until: '2591-08-12T10:06:00.000Z',
        bucket: '1h',
        group_by: 'service',
        service: serviceA,
        level: 'info',
        q: 'accepted',
        attributes: { region: 'eu-west' },
      }),
    );

    expect(rows).toEqual([
      {
        bucket: new Date('2591-08-12T10:00:00.000Z'),
        group_value: serviceA,
        count: '2',
      },
    ]);
  });

  it('returns an empty array when no rows match', async () => {
    const rows = await aggregateLogs(
      filters({ service: `${servicePrefix}-missing` }),
    );

    expect(rows).toEqual([]);
  });

  it('returns PostgreSQL bigint counts as strings', async () => {
    const rows = await aggregateLogs(filters({ bucket: '1h' }));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(({ count }) => typeof count === 'string')).toBe(true);
  });

  it('returns bucket timestamps as Date instances', async () => {
    const rows = await aggregateLogs(filters({ bucket: '1h' }));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(({ bucket }) => bucket instanceof Date)).toBe(true);
  });

  it('treats an injection-looking service filter as literal data', async () => {
    const rows = await aggregateLogs(
      filters({ bucket: '1h', service: injectionService }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T10:00:00.000Z', '1'],
    ]);
  });

  it('aggregates through the parent table across two daily partitions', async () => {
    const rows = await aggregateLogs(
      filters({
        since: timestamps.hourBoundary,
        until: '2591-08-13T00:01:00.000Z',
        bucket: '1d',
      }),
    );

    expect(bucketCounts(rows)).toEqual([
      ['2591-08-12T00:00:00.000Z', '1'],
      ['2591-08-13T00:00:00.000Z', '1'],
    ]);
  });
});
