import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/ingest-logs.js', () => ({
  ingestLogs: vi.fn(),
}));

import { buildApp } from '../../src/app.js';
import { ingestLogs } from '../../src/services/ingest-logs.js';

const ingestLogsMock = vi.mocked(ingestLogs);

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
    ingestLogsMock.mockReset();
    app = buildApp({ maxInFlightIngestions: 1 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the accepted response after passing a valid batch to ingestion', async () => {
    const logs = [
      validLog({ message: 'first event' }),
      validLog({ message: 'second event', level: 'warn' }),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, rejected: [] });
    expect(ingestLogsMock).toHaveBeenCalledOnce();
    expect(ingestLogsMock).toHaveBeenCalledWith(logs);
  });

  it('returns partial success and ingests only valid entries', async () => {
    const firstValid = validLog({ message: 'first valid event' });
    const secondValid = validLog({ message: 'second valid event' });

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          firstValid,
          validLog({ level: 'critical' }),
          secondValid,
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });
    expect(ingestLogsMock).toHaveBeenCalledWith([firstValid, secondValid]);
  });

  it('returns 400 and skips ingestion when every entry is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog({ service: '' }),
          validLog({ message: '', level: 'warn' }),
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: 'service must be a non-empty string' },
        { index: 1, reason: 'message must be a non-empty string' },
      ],
    });
    expect(ingestLogsMock).not.toHaveBeenCalled();
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

  it('returns 400 for malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      headers: { 'content-type': 'application/json' },
      payload: '{"logs": [',
    });

    expect(response.statusCode).toBe(400);
    expect(ingestLogsMock).not.toHaveBeenCalled();
  });

  it('does not return 200 until persistence completes', async () => {
    let completePersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      completePersistence = resolve;
    });
    let responseSettled = false;

    ingestLogsMock.mockReturnValueOnce(persistence);

    const responsePromise = app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog()] },
    });
    void responsePromise.finally(() => {
      responseSettled = true;
    });

    await vi.waitFor(() => {
      expect(ingestLogsMock).toHaveBeenCalledOnce();
    });
    expect(responseSettled).toBe(false);

    completePersistence?.();

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
  });

  it('returns 503 immediately when ingestion capacity is exhausted', async () => {
    let completeFirstIngestion: (() => void) | undefined;
    const firstIngestion = new Promise<void>((resolve) => {
      completeFirstIngestion = resolve;
    });
    ingestLogsMock
      .mockReturnValueOnce(firstIngestion)
      .mockResolvedValue(undefined);

    const firstResponsePromise = app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: 'first' })] },
    });

    await vi.waitFor(() => {
      expect(ingestLogsMock).toHaveBeenCalledOnce();
    });

    const overloaded = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: 'overloaded' })] },
    });

    expect(overloaded.statusCode).toBe(503);
    expect(overloaded.headers['retry-after']).toBe('1');
    expect(overloaded.json()).toEqual({ error: 'ingestion overloaded' });
    expect(ingestLogsMock).toHaveBeenCalledOnce();

    completeFirstIngestion?.();
    expect((await firstResponsePromise).statusCode).toBe(200);

    const afterRelease = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: 'after release' })] },
    });
    expect(afterRelease.statusCode).toBe(200);
    expect(ingestLogsMock).toHaveBeenCalledTimes(2);
  });

  it('preserves validation errors while ingestion is saturated', async () => {
    let completeIngestion: (() => void) | undefined;
    ingestLogsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        completeIngestion = resolve;
      }),
    );

    const activeResponse = app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog()] },
    });

    await vi.waitFor(() => {
      expect(ingestLogsMock).toHaveBeenCalledOnce();
    });

    const invalidEnvelope = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {},
    });
    const allInvalid = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ level: 'critical' })] },
    });

    expect(invalidEnvelope.statusCode).toBe(400);
    expect(invalidEnvelope.json()).toEqual({
      error: 'logs must be a non-empty array',
    });
    expect(allInvalid.statusCode).toBe(400);
    expect(allInvalid.json()).toEqual({
      accepted: 0,
      rejected: [{ index: 0, reason: "invalid level: 'critical'" }],
    });
    expect(ingestLogsMock).toHaveBeenCalledOnce();

    completeIngestion?.();
    await activeResponse;
  });

  it('releases ingestion capacity when persistence fails', async () => {
    ingestLogsMock
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);

    const failed = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: 'failed' })] },
    });
    const retried = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [validLog({ message: 'retried' })] },
    });

    expect(failed.statusCode).toBe(500);
    expect(retried.statusCode).toBe(200);
    expect(ingestLogsMock).toHaveBeenCalledTimes(2);
  });
});
