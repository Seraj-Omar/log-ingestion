import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/aggregate-logs.js', () => ({
  getAggregatedLogs: vi.fn(),
}));

import { buildApp } from '../../src/app.js';
import { getAggregatedLogs } from '../../src/services/aggregate-logs.js';

const getAggregatedLogsMock = vi.mocked(getAggregatedLogs);
const since = '2026-08-12T10:00:00.000Z';
const until = '2026-08-12T11:00:00.000Z';
const emptyResult = { results: [] };

function queryUrl(params: Record<string, string>): string {
  return `/logs/aggregate?${new URLSearchParams(params).toString()}`;
}

function minimalParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    since,
    until,
    bucket: '1m',
    ...overrides,
  };
}

describe('GET /logs/aggregate', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    getAggregatedLogsMock.mockReset();
    getAggregatedLogsMock.mockResolvedValue(emptyResult);
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 for a valid minimal query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams()),
    });

    expect(response.statusCode).toBe(200);
  });

  it('calls the service with parsed minimal filters', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams()),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      attributes: {},
    });
  });

  it('forwards group_by=service', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ group_by: 'service' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      group_by: 'service',
      attributes: {},
    });
  });

  it('forwards group_by=level', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ group_by: 'level' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      group_by: 'level',
      attributes: {},
    });
  });

  it('forwards the service filter', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ service: 'checkout' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      service: 'checkout',
      attributes: {},
    });
  });

  it('forwards the level filter', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ level: 'warn' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      level: 'warn',
      attributes: {},
    });
  });

  it('forwards the q filter', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ q: 'payment failed' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      q: 'payment failed',
      attributes: {},
    });
  });

  it('forwards one attribute filter', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ 'attr.user_id': '42' })),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      attributes: { user_id: '42' },
    });
  });

  it('forwards multiple attribute filters', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(
        minimalParams({
          'attr.user_id': '42',
          'attr.region': 'eu-west',
        }),
      ),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '1m',
      attributes: { user_id: '42', region: 'eu-west' },
    });
  });

  it('forwards every supported aggregation filter together', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl(
        minimalParams({
          bucket: '5m',
          group_by: 'service',
          service: 'checkout',
          level: 'error',
          q: 'payment',
          'attr.user_id': '42',
          'attr.region': 'eu-west',
        }),
      ),
    });

    expect(getAggregatedLogsMock).toHaveBeenCalledWith({
      since,
      until,
      bucket: '5m',
      group_by: 'service',
      service: 'checkout',
      level: 'error',
      q: 'payment',
      attributes: { user_id: '42', region: 'eu-west' },
    });
  });

  it('returns 400 for a missing since without calling the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ until, bucket: '1m' }),
    });

    expect(response.statusCode).toBe(400);
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing until', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ since, bucket: '1m' }),
    });

    expect(response.statusCode).toBe(400);
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing bucket', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ since, until }),
    });

    expect(response.statusCode).toBe(400);
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid since timestamp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ since: 'not-a-timestamp' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid since timestamp' });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid until timestamp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ until: 'not-a-timestamp' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid until timestamp' });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 when until is not greater than since', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ until: since })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "'until' must be greater than 'since'",
    });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unsupported bucket', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ bucket: '10m' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'unsupported bucket' });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unsupported group_by value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ group_by: 'message' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'unsupported group_by' });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid level', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ level: 'critical' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid level filter' });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed empty attribute key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ 'attr.': '42' })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "invalid attribute filter: 'attr.'",
    });
    expect(getAggregatedLogsMock).not.toHaveBeenCalled();
  });

  it('returns a successful empty service result unchanged', async () => {
    getAggregatedLogsMock.mockResolvedValue(emptyResult);

    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams()),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });
  });

  it('returns a successful grouped result unchanged', async () => {
    const result = {
      results: [
        {
          bucket: '2026-08-12T10:00:00.000Z',
          group: 'checkout',
          count: '12',
        },
      ],
    };
    getAggregatedLogsMock.mockResolvedValue(result);

    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams({ group_by: 'service' })),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
  });

  it('preserves a bigint-like count as a string in the JSON response', async () => {
    const count = '9223372036854775807';
    getAggregatedLogsMock.mockResolvedValue({
      results: [
        {
          bucket: '2026-08-12T10:00:00.000Z',
          count,
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams()),
    });
    const body = response.json<{ results: Array<{ count: unknown }> }>();

    expect(body.results[0]?.count).toBe(count);
    expect(typeof body.results[0]?.count).toBe('string');
  });

  it('returns 500 when the aggregation service rejects unexpectedly', async () => {
    getAggregatedLogsMock.mockRejectedValue(new Error('database unavailable'));

    const response = await app.inject({
      method: 'GET',
      url: queryUrl(minimalParams()),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'database unavailable',
    });
  });
});
