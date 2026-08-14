import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { pool } from '../../src/database/pool.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';

const chunkingTestLog: ValidLog = {
  timestamp: '2450-01-01T00:00:00.000Z',
  level: 'info',
  service: 'chunking-test',
  message: 'reused payload',
  attributes: {},
};

function createMockClient() {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>();
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;

  return { client, query, release };
}

function mockPoolConnection(client: PoolClient) {
  const promisePool = pool as unknown as { connect: () => Promise<PoolClient> };

  return vi.spyOn(promisePool, 'connect').mockResolvedValue(client);
}

describe('insertLogs query batching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses one INSERT query for multiple logs', async () => {
    const logs: ValidLog[] = [
      {
        timestamp: '2450-01-01T00:00:00.000Z',
        level: 'info',
        service: 'batch-query-test',
        message: 'first',
        attributes: { sequence: 1 },
      },
      {
        timestamp: '2450-01-01T00:00:01.000Z',
        level: 'warn',
        service: 'batch-query-test',
        message: 'second',
        attributes: { sequence: 2 },
      },
    ];
    const querySpy = vi.spyOn(pool, 'query').mockResolvedValue(undefined);

    await insertLogs(logs);

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, values] = querySpy.mock.calls[0] ?? [];
    expect(sql).toEqual(expect.stringMatching(/INSERT\s+INTO\s+logs/i));
    expect(sql).toEqual(expect.stringMatching(/VALUES/i));
    expect(values).toHaveLength(10);
  });

  it('inserts more than 10,000 logs in two chunks within one transaction', async () => {
    const logs = Array.from({ length: 10_001 }, () => chunkingTestLog);
    const { client, query, release } = createMockClient();
    query.mockResolvedValue(undefined);
    const connectSpy = mockPoolConnection(client);
    const poolQuerySpy = vi.spyOn(pool, 'query');

    await insertLogs(logs);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query.mock.calls[1]?.[0]).toEqual(expect.stringMatching(/INSERT\s+INTO\s+logs/i));
    expect(query.mock.calls[1]?.[1]).toHaveLength(50_000);
    expect(query.mock.calls[2]?.[0]).toEqual(expect.stringMatching(/INSERT\s+INTO\s+logs/i));
    expect(query.mock.calls[2]?.[1]).toHaveLength(5);
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client when the second chunk fails', async () => {
    const logs = Array.from({ length: 10_001 }, () => chunkingTestLog);
    const secondChunkError = new Error('second chunk failed');
    const { client, query, release } = createMockClient();
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(secondChunkError)
      .mockResolvedValueOnce(undefined);
    mockPoolConnection(client);

    await expect(insertLogs(logs)).rejects.toBe(secondChunkError);

    expect(query).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query.mock.calls[1]?.[0]).toEqual(expect.stringMatching(/INSERT\s+INTO\s+logs/i));
    expect(query.mock.calls[2]?.[0]).toEqual(expect.stringMatching(/INSERT\s+INTO\s+logs/i));
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
