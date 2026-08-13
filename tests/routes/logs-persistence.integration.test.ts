import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { forgetKnownPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';

const testService = 'integration-test-route-persistence';
const historicalPartition = 'logs_1996_07_04';

function validLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: testService,
    message: 'route persistence event',
    attributes: {},
    ...overrides,
  };
}

async function storedRows(): Promise<Array<{
  timestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}>> {
  const result = await pool.query<{
    timestamp: Date;
    level: string;
    service: string;
    message: string;
    attributes: Record<string, unknown>;
  }>(
    `
      SELECT timestamp, level, service, message, attributes
      FROM logs
      WHERE service = $1
      ORDER BY message
    `,
    [testService],
  );

  return result.rows;
}

describe('POST /logs persistence', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await pool.query('DELETE FROM logs WHERE service = $1', [testService]);
    await pool.query(`DROP TABLE IF EXISTS ${historicalPartition}`);
    forgetKnownPartition(historicalPartition);
  });

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pool.query('DELETE FROM logs WHERE service = $1', [testService]);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${historicalPartition}`);
    forgetKnownPartition(historicalPartition);
    await pool.end();
  });

  it('returns 200 only after a valid single log is persisted', async () => {
    const log = validLog();

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: { logs: [log] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, rejected: [] });
    expect(await storedRows()).toHaveLength(1);
  });

  it('persists only valid entries from a partially valid batch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog({ message: 'partial-first' }),
          validLog({ message: 'must-not-persist', level: 'critical' }),
          validLog({ message: 'partial-second' }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [{ index: 1, reason: "invalid level: 'critical'" }],
    });
    expect((await storedRows()).map(({ message }) => message)).toEqual([
      'partial-first',
      'partial-second',
    ]);
  });

  it('stores no rows when the entire batch is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [
          validLog({ level: 'critical' }),
          validLog({ message: '', level: 'warn' }),
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ accepted: 0 });
    expect(await storedRows()).toEqual([]);
  });

  it('creates a missing historical partition and persists before responding', async () => {
    const timestamp = '1996-07-04T12:34:56.000Z';

    const response = await app.inject({
      method: 'POST',
      url: '/logs',
      payload: {
        logs: [validLog({ timestamp, message: 'historical-route-event' })],
      },
    });

    const partitionResult = await pool.query<{ partition: string | null }>(
      'SELECT to_regclass($1)::text AS partition',
      [`public.${historicalPartition}`],
    );
    const rows = await storedRows();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, rejected: [] });
    expect(partitionResult.rows).toEqual([{ partition: historicalPartition }]);
    expect(rows[0]?.timestamp.toISOString()).toBe(timestamp);
  });
});
