import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { markNotReady, markReady } from '../../src/config/readiness.js';
import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';

const servicePrefix = 'contract-audit-api';
const serviceA = `${servicePrefix}-checkout`;
const serviceB = `${servicePrefix}-billing`;
const cursorService = `${servicePrefix}-cursor`;
const partialService = `${servicePrefix}-partial`;
const allInvalidService = `${servicePrefix}-all-invalid`;
const testServices = [
  serviceA,
  serviceB,
  cursorService,
  partialService,
  allInvalidService,
] as const;

let app: FastifyInstance;
let bucketStart: Date;
let firstTimestamp: string;
let secondTimestamp: string;
let thirdTimestamp: string;
let rangeUntil: string;
let cursorTimestamp: string;

function queryUrl(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

function log(
  timestamp: string,
  level: string,
  service: string,
  message: string,
  attributes: Record<string, string | number | boolean> = {},
): Record<string, unknown> {
  return { timestamp, level, service, message, attributes };
}

async function deleteTestRows(): Promise<void> {
  await pool.query('DELETE FROM logs WHERE service = ANY($1::text[])', [
    testServices,
  ]);
}

describe('API contract', () => {
  beforeAll(async () => {
    bucketStart = new Date();
    bucketStart.setUTCSeconds(0, 0);
    bucketStart.setUTCMinutes(bucketStart.getUTCMinutes() - 2);

    firstTimestamp = new Date(bucketStart.getTime() + 5_000).toISOString();
    secondTimestamp = new Date(bucketStart.getTime() + 20_000).toISOString();
    thirdTimestamp = new Date(bucketStart.getTime() + 40_000).toISOString();
    rangeUntil = new Date(bucketStart.getTime() + 60_000).toISOString();
    cursorTimestamp = new Date(bucketStart.getTime() + 30_000).toISOString();

    await ensureDailyPartition(bucketStart);
    await deleteTestRows();

    markReady();
    app = buildApp();
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          log(
            firstTimestamp,
            'info',
            serviceA,
            'Payment accepted',
            { test_suite: servicePrefix, user_id: 42, active: true },
          ),
          log(
            secondTimestamp,
            'error',
            serviceA,
            'PAYMENT failed',
            { test_suite: servicePrefix, user_id: '42', active: false },
          ),
          log(
            thirdTimestamp,
            'warn',
            serviceB,
            'Inventory warning',
            { test_suite: servicePrefix, user_id: 7, active: true },
          ),
          log(cursorTimestamp, 'info', cursorService, 'cursor first'),
          log(cursorTimestamp, 'info', cursorService, 'cursor second'),
          log(cursorTimestamp, 'info', cursorService, 'cursor third'),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 6, rejected: [] });
  });

  afterAll(async () => {
    await app.close();
    markNotReady();
    await deleteTestRows();
    await pool.end();
  });

  it('reports ready health after database preparation', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('persists valid logs and exposes typed attributes immediately', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', { service: serviceA, q: 'accepted' }),
    });
    const body = response.json<{
      logs: Array<{ attributes: Record<string, unknown> }>;
      next_cursor: string | null;
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.attributes).toMatchObject({
      user_id: 42,
      active: true,
    });
    expect(body.next_cursor).toBeNull();
  });

  it('supports partial success with original rejection indexes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          log(firstTimestamp, 'info', partialService, 'partial valid'),
          log(firstTimestamp, 'critical', partialService, 'partial invalid'),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });

    const stored = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', { service: partialService }),
    });
    expect(stored.json<{ logs: unknown[] }>().logs).toHaveLength(1);
  });

  it('rejects all-invalid and malformed top-level requests without persistence', async () => {
    const allInvalid = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          log(firstTimestamp, 'critical', allInvalidService, 'bad level'),
          log(firstTimestamp, 'info', allInvalidService, ''),
        ],
      },
    });
    const missingLogs = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {},
    });
    const malformedJson = await app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json' },
      payload: '{"logs":',
    });

    expect(allInvalid.statusCode).toBe(400);
    expect(allInvalid.json<{ accepted: number }>().accepted).toBe(0);
    expect(missingLogs.statusCode).toBe(400);
    expect(malformedJson.statusCode).toBe(400);

    const stored = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', { service: allInvalidService }),
    });
    expect(stored.json<{ logs: unknown[] }>().logs).toEqual([]);
  });

  it('applies filters, string attribute comparison, and descending ordering', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', {
        service: serviceA,
        since: firstTimestamp,
        until: rangeUntil,
        q: 'payment',
        'attr.user_id': '42',
        limit: '1000',
      }),
    });
    const body = response.json<{
      logs: Array<{ timestamp: string; service: string }>;
      next_cursor: string | null;
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.logs.map(({ timestamp }) => timestamp)).toEqual([
      secondTimestamp,
      firstTimestamp,
    ]);
    expect(body.logs.every(({ service }) => service === serviceA)).toBe(true);
    expect(body.next_cursor).toBeNull();
  });

  it('paginates identical timestamps without duplicates or skipped rows', async () => {
    const firstPage = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', { service: cursorService, limit: '2' }),
    });
    const firstBody = firstPage.json<{
      logs: Array<{ id: string }>;
      next_cursor: string | null;
    }>();

    expect(firstBody.logs).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const secondPage = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', {
        service: cursorService,
        limit: '2',
        cursor: firstBody.next_cursor ?? '',
      }),
    });
    const secondBody = secondPage.json<{
      logs: Array<{ id: string }>;
      next_cursor: string | null;
    }>();
    const ids = [...firstBody.logs, ...secondBody.logs].map(({ id }) => id);

    expect(secondBody.logs).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();
    expect(new Set(ids)).toHaveLength(3);
  });

  it('returns the required ungrouped aggregation response shape immediately', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl('/logs/aggregate', {
        since: bucketStart.toISOString(),
        until: rangeUntil,
        bucket: '1m',
        'attr.test_suite': servicePrefix,
      }),
    });
    const body = response.json<{
      buckets: Array<{ start: string; group: unknown; count: unknown }>;
    }>();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      buckets: [
        {
          start: bucketStart.toISOString(),
          group: null,
          count: 3,
        },
      ],
    });
    expect(Object.keys(body.buckets[0] ?? {}).sort()).toEqual([
      'count',
      'group',
      'start',
    ]);
    expect(typeof body.buckets[0]?.count).toBe('number');
  });

  it('returns service and level grouping in ascending bucket order', async () => {
    const baseParams = {
      since: bucketStart.toISOString(),
      until: rangeUntil,
      bucket: '1m',
      'attr.test_suite': servicePrefix,
    };
    const byService = await app.inject({
      method: 'GET',
      url: queryUrl('/logs/aggregate', {
        ...baseParams,
        group_by: 'service',
      }),
    });
    const byLevel = await app.inject({
      method: 'GET',
      url: queryUrl('/logs/aggregate', {
        ...baseParams,
        group_by: 'level',
      }),
    });
    const serviceBuckets = byService.json<{
      buckets: Array<{ start: string; group: string; count: number }>;
    }>().buckets;
    const levelBuckets = byLevel.json<{
      buckets: Array<{ start: string; group: string; count: number }>;
    }>().buckets;

    expect(serviceBuckets.map(({ group, count }) => [group, count]).sort()).toEqual([
      [serviceB, 1],
      [serviceA, 2],
    ]);
    expect(levelBuckets.map(({ group }) => group).sort()).toEqual([
      'error',
      'info',
      'warn',
    ]);
    expect(
      serviceBuckets.every(({ start }) => start === bucketStart.toISOString()),
    ).toBe(true);
  });

  it('returns contract error objects for invalid query parameters', async () => {
    const invalidLogs = await app.inject({
      method: 'GET',
      url: queryUrl('/logs', { limit: '0' }),
    });
    const invalidAggregate = await app.inject({
      method: 'GET',
      url: queryUrl('/logs/aggregate', {
        since: bucketStart.toISOString(),
        until: rangeUntil,
        bucket: '10m',
      }),
    });

    expect(invalidLogs.statusCode).toBe(400);
    expect(invalidLogs.json()).toEqual({ error: 'limit must be at least 1' });
    expect(invalidAggregate.statusCode).toBe(400);
    expect(invalidAggregate.json()).toEqual({ error: 'unsupported bucket' });
  });
});
