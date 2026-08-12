import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/query-logs.js', () => ({
  getLogs: vi.fn(),
}));

import { buildApp } from '../../src/app.js';
import { getLogs } from '../../src/services/query-logs.js';

const getLogsMock = vi.mocked(getLogs);
const emptyResult = { logs: [], next_cursor: null };

function queryUrl(params: Record<string, string>): string {
  return `/logs?${new URLSearchParams(params).toString()}`;
}

describe('GET /logs', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    getLogsMock.mockReset();
    getLogsMock.mockResolvedValue(emptyResult);
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 and forwards default filters when no query params are supplied', async () => {
    const response = await app.inject({ method: 'GET', url: '/logs' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(emptyResult);
    expect(getLogsMock).toHaveBeenCalledWith({
      limit: 100,
      attributes: {},
    });
  });

  it('forwards the service filter', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl({ service: 'checkout' }),
    });

    expect(getLogsMock).toHaveBeenCalledWith({
      service: 'checkout',
      limit: 100,
      attributes: {},
    });
  });

  it('forwards the level filter', async () => {
    await app.inject({ method: 'GET', url: queryUrl({ level: 'warn' }) });

    expect(getLogsMock).toHaveBeenCalledWith({
      level: 'warn',
      limit: 100,
      attributes: {},
    });
  });

  it('forwards since and until filters', async () => {
    const since = '2026-08-12T10:00:00.000Z';
    const until = '2026-08-12T11:00:00.000Z';

    await app.inject({
      method: 'GET',
      url: queryUrl({ since, until }),
    });

    expect(getLogsMock).toHaveBeenCalledWith({
      since,
      until,
      limit: 100,
      attributes: {},
    });
  });

  it('forwards the q filter', async () => {
    await app.inject({ method: 'GET', url: queryUrl({ q: 'payment failed' }) });

    expect(getLogsMock).toHaveBeenCalledWith({
      q: 'payment failed',
      limit: 100,
      attributes: {},
    });
  });

  it('extracts an attr.user_id filter into attributes', async () => {
    await app.inject({
      method: 'GET',
      url: queryUrl({ 'attr.user_id': '42' }),
    });

    expect(getLogsMock).toHaveBeenCalledWith({
      limit: 100,
      attributes: { user_id: '42' },
    });
  });

  it('forwards several filters together', async () => {
    const since = '2026-08-12T10:00:00.000Z';
    const until = '2026-08-12T11:00:00.000Z';

    await app.inject({
      method: 'GET',
      url: queryUrl({
        service: 'checkout',
        level: 'error',
        since,
        until,
        q: 'payment',
        limit: '50',
        cursor: 'cursor-token',
        'attr.user_id': '42',
        'attr.region': 'eu-west',
      }),
    });

    expect(getLogsMock).toHaveBeenCalledWith({
      service: 'checkout',
      level: 'error',
      since,
      until,
      q: 'payment',
      limit: 50,
      cursor: 'cursor-token',
      attributes: { user_id: '42', region: 'eu-west' },
    });
  });

  it('forwards limit=50 as the number 50', async () => {
    await app.inject({ method: 'GET', url: queryUrl({ limit: '50' }) });

    expect(getLogsMock).toHaveBeenCalledWith({
      limit: 50,
      attributes: {},
    });
  });

  it('returns 400 for an invalid level without calling the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ level: 'critical' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid level filter' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid since timestamp without calling the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ since: 'not-a-timestamp' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid since timestamp' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid until timestamp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ until: 'not-a-timestamp' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid until timestamp' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 when until is not greater than since', async () => {
    const timestamp = '2026-08-12T10:00:00.000Z';
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ since: timestamp, until: timestamp }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "'until' must be greater than 'since'",
    });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for limit=0', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ limit: '0' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'limit must be at least 1' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for limit=1001', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ limit: '1001' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'limit must not exceed 1000' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ limit: 'abc' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid limit' });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty attribute key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ 'attr.': '42' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid attribute filter: 'attr.'" });
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the query service rejects with invalid cursor', async () => {
    getLogsMock.mockRejectedValue(new Error('invalid cursor'));

    const response = await app.inject({
      method: 'GET',
      url: queryUrl({ cursor: 'malformed-but-non-empty' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid cursor' });
  });

  it('returns 500 when the query service rejects unexpectedly', async () => {
    getLogsMock.mockRejectedValue(new Error('database unavailable'));

    const response = await app.inject({ method: 'GET', url: '/logs' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'database unavailable',
    });
  });

  it('returns a successful service result unchanged', async () => {
    const result = {
      logs: [
        {
          id: '123',
          timestamp: '2026-08-12T10:00:00.000Z',
          level: 'info',
          service: 'checkout',
          message: 'payment accepted',
          attributes: { user_id: '42' },
        },
      ],
      next_cursor: 'next-page-token',
    };
    getLogsMock.mockResolvedValue(result);

    const response = await app.inject({ method: 'GET', url: '/logs' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
  });

  it('preserves a BIGINT-like id as a string in the JSON response', async () => {
    const id = '9223372036854775807';
    getLogsMock.mockResolvedValue({
      logs: [
        {
          id,
          timestamp: '2026-08-12T10:00:00.000Z',
          level: 'info',
          service: 'checkout',
          message: 'payment accepted',
          attributes: {},
        },
      ],
      next_cursor: null,
    });

    const response = await app.inject({ method: 'GET', url: '/logs' });
    const body = response.json<{ logs: Array<{ id: unknown }> }>();

    expect(body.logs[0]?.id).toBe(id);
    expect(typeof body.logs[0]?.id).toBe('string');
  });
});
