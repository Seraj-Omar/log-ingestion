import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

function validLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'checkout',
    message: 'payment accepted',
    attributes: { user_id: '42' },
    ...overrides,
  };
}

describe('POST /logs', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 for a valid single-log batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog()] },
    });

    expect(response.statusCode).toBe(200);
  });

  it('reports the correct accepted count for a valid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog({ message: 'first event' }),
          validLog({ message: 'second event' }),
          validLog({ message: 'third event' }),
        ],
      },
    });

    expect(response.json()).toMatchObject({ accepted: 3 });
  });

  it('returns an empty rejected array for a valid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog(), validLog({ level: 'warn' })] },
    });

    expect(response.json()).toEqual({ accepted: 2, rejected: [] });
  });

  it('returns 200 for a partially valid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validLog(), validLog({ level: 'critical' })],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('preserves the original rejection index in a partial batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog({ message: 'first valid event' }),
          validLog({ message: 'second valid event' }),
          validLog({ level: 'critical' }),
        ],
      },
    });

    expect(response.json().rejected).toEqual([
      { index: 2, reason: "invalid level: 'critical'" },
    ]);
  });

  it('reports the correct accepted count for a partial batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog(),
          validLog({ service: '' }),
          validLog({ level: 'error' }),
        ],
      },
    });

    expect(response.json()).toMatchObject({ accepted: 2 });
  });

  it('returns 400 for an entirely invalid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validLog({ level: 'critical' }), validLog({ message: '' })],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('reports zero accepted logs for an entirely invalid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validLog({ service: '' }), validLog({ message: '   ' })],
      },
    });

    expect(response.json()).toMatchObject({
      accepted: 0,
      rejected: [
        { index: 0, reason: 'service must be a non-empty string' },
        { index: 1, reason: 'message must be a non-empty string' },
      ],
    });
  });

  it('returns 400 when logs is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'logs must be a non-empty array' });
  });

  it('returns 400 for an empty logs array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'logs array must not be empty' });
  });

  it('returns 400 when logs is not an array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: 'not-an-array' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'logs must be a non-empty array' });
  });

  it('returns 400 for an invalid top-level shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: [validLog()],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid request body' });
  });

  it('returns a useful rejection reason for an invalid level', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog(), validLog({ level: 'critical' })] },
    });

    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });
  });

  it('rejects a log with a nested attribute', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validLog({ attributes: { context: { user_id: '42' } } })],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().rejected).toEqual([
      {
        index: 0,
        reason: 'attributes must be a flat object with string, number, or boolean values',
      },
    ]);
  });

  it('rejects a log with an array attribute', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ attributes: { tags: ['payments'] } })] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().rejected).toEqual([
      {
        index: 0,
        reason: 'attributes must be a flat object with string, number, or boolean values',
      },
    ]);
  });

  it('rejects a log with an empty service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ service: '' })] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().rejected).toEqual([
      { index: 0, reason: 'service must be a non-empty string' },
    ]);
  });

  it('rejects a log with an empty message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: '' })] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().rejected).toEqual([
      { index: 0, reason: 'message must be a non-empty string' },
    ]);
  });
});
