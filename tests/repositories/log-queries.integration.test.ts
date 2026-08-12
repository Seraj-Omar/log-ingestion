import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import { queryLogs, type LogRow } from '../../src/repositories/log-queries.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';
import type { LogQueryFilters } from '../../src/schemas/log-query.js';

const testPartition = 'logs_2590_08_12';
const serviceA = 'integration-query-2590-a';
const serviceB = 'integration-query-2590-b';
const injectionService = "x' OR 1=1 --";
const testServices = [serviceA, serviceB, injectionService] as const;

const timestamps = {
  newest: '2590-08-12T12:00:00.000Z',
  second: '2590-08-12T11:00:00.000Z',
  third: '2590-08-12T10:00:00.000Z',
  fourth: '2590-08-12T09:00:00.000Z',
  tied: '2590-08-12T08:00:00.000Z',
  injection: '2590-08-12T07:00:00.000Z',
} as const;

function filters(
  overrides: Partial<LogQueryFilters> = {},
): LogQueryFilters {
  return {
    limit: 100,
    attributes: {},
    ...overrides,
  };
}

function log(
  timestamp: string,
  level: ValidLog['level'],
  service: string,
  message: string,
  attributes: ValidLog['attributes'],
): ValidLog {
  return { timestamp, level, service, message, attributes };
}

async function deleteTestRows(): Promise<void> {
  await pool.query('DELETE FROM logs WHERE service = ANY($1::text[])', [
    testServices,
  ]);
}

function messages(rows: LogRow[]): string[] {
  return rows.map(({ message }) => message);
}

describe('queryLogs', () => {
  beforeAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${testPartition}`);
    await ensureDailyPartition(new Date(timestamps.newest));

    await insertLogs([
      log(
        timestamps.newest,
        'error',
        serviceA,
        'Payment FAILED for Alpha',
        { user_id: '42', region: 'eu-west', successful: false },
      ),
      log(
        timestamps.second,
        'info',
        serviceA,
        'Payment accepted for Beta',
        { user_id: '42', region: 'us-east', successful: true },
      ),
      log(
        timestamps.third,
        'warn',
        serviceB,
        'Inventory warning',
        { user_id: '7', region: 'eu-west' },
      ),
      log(
        timestamps.fourth,
        'error',
        serviceB,
        'Payment retry scheduled',
        { user_id: '42', region: 'eu-west' },
      ),
      log(
        timestamps.tied,
        'info',
        serviceA,
        'Tie row inserted first',
        { tie: 'yes' },
      ),
      log(
        timestamps.tied,
        'info',
        serviceA,
        'Tie row inserted second',
        { tie: 'yes' },
      ),
      log(
        timestamps.injection,
        'debug',
        injectionService,
        'Literal injection-looking service',
        { source: 'security-test' },
      ),
    ]);
  });

  afterAll(async () => {
    await deleteTestRows();
    await pool.query(`DROP TABLE IF EXISTS ${testPartition}`);
    await pool.end();
  });

  it('returns rows ordered by timestamp DESC and id DESC without filters', async () => {
    const rows = await queryLogs(filters({ limit: 1000 }));

    expect(rows.length).toBeGreaterThanOrEqual(7);

    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];

      expect(previous).toBeDefined();
      expect(current).toBeDefined();

      if (previous && current) {
        const timestampDifference =
          previous.timestamp.getTime() - current.timestamp.getTime();

        expect(
          timestampDifference > 0 ||
            (timestampDifference === 0 && BigInt(previous.id) > BigInt(current.id)),
        ).toBe(true);
      }
    }
  });

  it('returns only rows matching the service filter', async () => {
    const rows = await queryLogs(filters({ service: serviceA }));

    expect(rows).toHaveLength(4);
    expect(rows.every(({ service }) => service === serviceA)).toBe(true);
  });

  it('returns only rows matching the level filter', async () => {
    const rows = await queryLogs(
      filters({ service: serviceB, level: 'error' }),
    );

    expect(messages(rows)).toEqual(['Payment retry scheduled']);
    expect(rows.every(({ level }) => level === 'error')).toBe(true);
  });

  it('treats the since boundary as inclusive', async () => {
    const rows = await queryLogs(
      filters({ service: serviceA, since: timestamps.second }),
    );

    expect(messages(rows)).toEqual([
      'Payment FAILED for Alpha',
      'Payment accepted for Beta',
    ]);
  });

  it('treats the until boundary as exclusive', async () => {
    const rows = await queryLogs(
      filters({ service: serviceB, until: timestamps.third }),
    );

    expect(messages(rows)).toEqual(['Payment retry scheduled']);
  });

  it('returns only rows inside a since and until interval', async () => {
    const rows = await queryLogs(
      filters({
        service: serviceB,
        since: timestamps.fourth,
        until: '2590-08-12T10:30:00.000Z',
      }),
    );

    expect(messages(rows)).toEqual([
      'Inventory warning',
      'Payment retry scheduled',
    ]);
  });

  it('matches one attribute by exact string value', async () => {
    const rows = await queryLogs(
      filters({
        service: serviceB,
        attributes: { user_id: '7' },
      }),
    );

    expect(messages(rows)).toEqual(['Inventory warning']);
  });

  it('requires all attribute filters to match', async () => {
    const rows = await queryLogs(
      filters({
        attributes: { user_id: '42', region: 'eu-west' },
      }),
    );

    expect(messages(rows)).toEqual([
      'Payment FAILED for Alpha',
      'Payment retry scheduled',
    ]);
  });

  it('matches q case-insensitively without returning unrelated messages', async () => {
    const rows = await queryLogs(
      filters({ service: serviceA, q: 'failed FOR' }),
    );

    expect(messages(rows)).toEqual(['Payment FAILED for Alpha']);
  });

  it('applies several filters together', async () => {
    const rows = await queryLogs(
      filters({
        service: serviceA,
        level: 'error',
        since: timestamps.second,
        until: '2590-08-12T13:00:00.000Z',
        attributes: { user_id: '42' },
        q: 'failed',
      }),
    );

    expect(messages(rows)).toEqual(['Payment FAILED for Alpha']);
  });

  it('returns only rows after a cursor and does not repeat the cursor row', async () => {
    const serviceRows = await queryLogs(filters({ service: serviceA }));
    const cursorRow = serviceRows.find(
      ({ message }) => message === 'Payment accepted for Beta',
    );

    expect(cursorRow).toBeDefined();
    if (!cursorRow) return;

    const rows = await queryLogs(filters({ service: serviceA }), {
      timestamp: cursorRow.timestamp.toISOString(),
      id: cursorRow.id,
    });

    expect(messages(rows)).toEqual([
      'Tie row inserted second',
      'Tie row inserted first',
    ]);
    expect(rows.some(({ id }) => id === cursorRow.id)).toBe(false);
  });

  it('orders rows with identical timestamps by id DESC', async () => {
    const rows = await queryLogs(
      filters({ service: serviceA, attributes: { tie: 'yes' } }),
    );

    expect(messages(rows)).toEqual([
      'Tie row inserted second',
      'Tie row inserted first',
    ]);
    expect(BigInt(rows[0]?.id ?? '0')).toBeGreaterThan(
      BigInt(rows[1]?.id ?? '0'),
    );
  });

  it('uses id tie-breaking for a cursor with the same timestamp', async () => {
    const tiedRows = await queryLogs(
      filters({ service: serviceA, attributes: { tie: 'yes' } }),
    );
    const newerTieRow = tiedRows[0];
    const olderTieRow = tiedRows[1];

    expect(newerTieRow).toBeDefined();
    expect(olderTieRow).toBeDefined();
    if (!newerTieRow || !olderTieRow) return;

    const rows = await queryLogs(
      filters({ service: serviceA, attributes: { tie: 'yes' } }),
      {
        timestamp: newerTieRow.timestamp.toISOString(),
        id: newerTieRow.id,
      },
    );

    expect(rows.map(({ id }) => id)).toEqual([olderTieRow.id]);
  });

  it('returns the extra lookahead row requested by the query builder', async () => {
    const rows = await queryLogs(filters({ service: serviceA, limit: 2 }));

    expect(rows).toHaveLength(3);
    expect(messages(rows)).toEqual([
      'Payment FAILED for Alpha',
      'Payment accepted for Beta',
      'Tie row inserted second',
    ]);
  });

  it('round-trips attributes from PostgreSQL', async () => {
    const rows = await queryLogs(
      filters({ service: serviceA, q: 'Alpha' }),
    );

    expect(rows[0]?.attributes).toEqual({
      user_id: '42',
      region: 'eu-west',
      successful: false,
    });
  });

  it('returns BIGINT ids safely as strings', async () => {
    const rows = await queryLogs(filters({ service: serviceA, limit: 1 }));

    expect(rows[0]?.id).toMatch(/^\d+$/);
    expect(typeof rows[0]?.id).toBe('string');
  });

  it('treats SQL-injection-looking service input as literal data', async () => {
    const rows = await queryLogs(filters({ service: injectionService }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service: injectionService,
      message: 'Literal injection-looking service',
    });
  });
});
