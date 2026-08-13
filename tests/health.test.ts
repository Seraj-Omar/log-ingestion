import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { markNotReady, markReady } from '../src/config/readiness.js';

const databaseMocks = vi.hoisted(() => ({
  checkDatabaseConnection: vi.fn(),
}));

vi.mock('../src/database/pool.js', () => ({
  checkDatabaseConnection: databaseMocks.checkDatabaseConnection,
}));

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    databaseMocks.checkDatabaseConnection.mockReset();
    databaseMocks.checkDatabaseConnection.mockResolvedValue(undefined);
    markNotReady();
    app = buildApp();
  });

  afterEach(async () => {
    markNotReady();
    await app.close();
  });

  it('returns 503 with a starting status before readiness is marked', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'starting' });
  });

  it('returns 200 with an ok status after readiness is marked', async () => {
    markReady();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(databaseMocks.checkDatabaseConnection).toHaveBeenCalledOnce();
  });

  it('returns 503 when readiness was reached but PostgreSQL is unavailable', async () => {
    databaseMocks.checkDatabaseConnection.mockRejectedValue(
      new Error('database unavailable'),
    );
    markReady();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  });
});
