import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('buildApp', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a Fastify application', async () => {
    await app.ready();

    expect(app.inject).toBeTypeOf('function');
    expect(app.server).toBeDefined();
  });

  it('returns 404 for an unknown route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
  });
});
