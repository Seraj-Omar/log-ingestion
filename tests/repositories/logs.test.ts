import { Writable } from 'node:stream';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PoolClient } from 'pg';

const pgCopyMocks = vi.hoisted(() => ({
  from: vi.fn((sql: string) => ({
    sql,
  })),
}));

vi.mock('pg-copy-streams', () => ({
  from: pgCopyMocks.from,
}));

import { pool } from '../../src/database/pool.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';

function createWritableCollector() {
  let output = '';
  const chunkSizes: number[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      chunkSizes.push(chunk.length);
      callback();
    },
  });

  return {
    stream,
    getOutput: () => output,
    getChunkSizes: () => chunkSizes,
  };
}

function createFailingWritable(error: Error) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(error);
    },
  });
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function createMockClient(
  copyStream: Writable,
  rollupError?: Error,
) {
  const query = vi.fn(
    (
      statement: unknown,
      _values?: unknown[],
    ): unknown => {
      if (typeof statement === 'string') {
        const normalized = normalizeSql(statement);

        if (
          normalized === 'BEGIN' ||
          normalized === 'COMMIT' ||
          normalized === 'ROLLBACK'
        ) {
          return Promise.resolve();
        }

        if (
          normalized.includes(
            'INSERT INTO log_rollups_1m',
          )
        ) {
          if (rollupError !== undefined) {
            return Promise.reject(rollupError);
          }

          return Promise.resolve();
        }
      }

      // COPY query object produced by pg-copy-streams.
      return copyStream;
    },
  );

  const release = vi.fn();

  const client = {
    query,
    release,
  } as unknown as PoolClient;

  return {
    client,
    query,
    release,
  };
}

function mockPoolConnection(client: PoolClient) {
  const promisePool = pool as unknown as {
    connect: () => Promise<PoolClient>;
  };

  return vi
    .spyOn(promisePool, 'connect')
    .mockResolvedValue(client);
}

describe('insertLogs COPY persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pgCopyMocks.from.mockClear();
  });

  it('does nothing for an empty log batch', async () => {
    const connectSpy = vi.spyOn(pool, 'connect');

    await insertLogs([]);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(pgCopyMocks.from).not.toHaveBeenCalled();
  });

  it('uses one COPY operation for multiple logs', async () => {
    const logs: ValidLog[] = [
      {
        timestamp: '2450-01-01T00:00:00.000Z',
        level: 'info',
        service: 'copy-test',
        message: 'first',
        attributes: {
          sequence: 1,
        },
      },
      {
        timestamp: '2450-01-01T00:00:01.000Z',
        level: 'warn',
        service: 'copy-test',
        message: 'second',
        attributes: {
          sequence: 2,
        },
      },
    ];

    const {
      stream,
      getOutput,
    } = createWritableCollector();

    const {
      client,
      release,
    } = createMockClient(stream);

    const connectSpy =
      mockPoolConnection(client);

    await insertLogs(logs);

    expect(
      connectSpy,
    ).toHaveBeenCalledTimes(1);

    expect(
      pgCopyMocks.from,
    ).toHaveBeenCalledTimes(1);

    const copySql =
      pgCopyMocks.from.mock.calls[0]?.[0];

    expect(copySql).toBeDefined();

    expect(
      normalizeSql(copySql ?? ''),
    ).toMatch(
      /COPY logs \( timestamp, level, service, message, attributes \) FROM STDIN WITH \(FORMAT csv\)/i,
    );

    expect(getOutput()).toBe(
      [
        '"2450-01-01T00:00:00.000Z","info","copy-test","first","{""sequence"":1}"',
        '"2450-01-01T00:00:01.000Z","warn","copy-test","second","{""sequence"":2}"',
        '',
      ].join('\n'),
    );

    expect(
      release,
    ).toHaveBeenCalledTimes(1);
  });

  it('groups COPY rows into bounded UTF-8 chunks', async () => {
    const logs: ValidLog[] = Array.from(
      { length: 300 },
      (_, index) => ({
        timestamp:
          '2450-01-01T00:00:00.000Z',
        level: 'info',
        service: 'copy-chunk-test',
        message:
          `${index}-${'€'.repeat(150)}`,
        attributes: { index },
      }),
    );

    const {
      stream,
      getOutput,
      getChunkSizes,
    } = createWritableCollector();

    const {
      client,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs(logs);

    const chunkSizes = getChunkSizes();

    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(chunkSizes.length).toBeLessThan(
      logs.length,
    );

    expect(
      chunkSizes.every(
        (size) => size <= 64 * 1024,
      ),
    ).toBe(true);

    expect(
      chunkSizes.reduce(
        (total, size) => total + size,
        0,
      ),
    ).toBe(
      Buffer.byteLength(
        getOutput(),
        'utf8',
      ),
    );
  });

  it('correctly escapes CSV-sensitive log values', async () => {
    const logs: ValidLog[] = [
      {
        timestamp:
          '2450-01-01T00:00:00.000Z',
        level: 'info',
        service: 'csv,test',
        message:
          'hello, "quoted"\nnext line',
        attributes: {
          text: 'value,with,"quotes"',
        },
      },
    ];

    const {
      stream,
      getOutput,
    } = createWritableCollector();

    const {
      client,
      release,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs(logs);

    const output = getOutput();

    expect(output).toContain(
      '"csv,test"',
    );

    expect(output).toContain(
      '"hello, ""quoted""\nnext line"',
    );

    const json = JSON.stringify(
      logs[0]?.attributes,
    );

    const expectedCsvJson =
      `"${json.replace(/"/g, '""')}"`;

    expect(output).toContain(
      expectedCsvJson,
    );

    expect(
      release,
    ).toHaveBeenCalledTimes(1);
  });

  it('serializes attributes as JSON before copying them', async () => {
    const logs: ValidLog[] = [
      {
        timestamp:
          '2450-01-01T00:00:00.000Z',
        level: 'error',
        service: 'attributes-test',
        message: 'request failed',
        attributes: {
          user_id: 'u123',
          retries: 2,
          cached: false,
          region: 'eu-west',
        },
      },
    ];

    const {
      stream,
      getOutput,
    } = createWritableCollector();

    const {
      client,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs(logs);

    const expectedJson =
      JSON.stringify(
        logs[0]?.attributes,
      ).replace(/"/g, '""');

    expect(
      getOutput(),
    ).toContain(
      `"${expectedJson}"`,
    );
  });

  it('releases the database client after a successful COPY', async () => {
    const log: ValidLog = {
      timestamp:
        '2450-01-01T00:00:00.000Z',
      level: 'info',
      service: 'release-test',
      message: 'success',
      attributes: {},
    };

    const {
      stream,
    } = createWritableCollector();

    const {
      client,
      release,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs([log]);

    expect(
      release,
    ).toHaveBeenCalledTimes(1);
  });

  it('rejects, rolls back, and releases the database client when COPY fails', async () => {
    const log: ValidLog = {
      timestamp:
        '2450-01-01T00:00:00.000Z',
      level: 'info',
      service: 'failure-test',
      message: 'copy should fail',
      attributes: {},
    };

    const copyError = new Error(
      'COPY stream failed',
    );

    const stream =
      createFailingWritable(copyError);

    const {
      client,
      query,
      release,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await expect(
      insertLogs([log]),
    ).rejects.toBe(copyError);

    const sqlCalls = query.mock.calls.map(
      ([statement]) =>
        typeof statement === 'string'
          ? normalizeSql(statement)
          : '',
    );

    expect(sqlCalls).toContain('BEGIN');
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');

    expect(
      release,
    ).toHaveBeenCalledTimes(1);
  });

  it('rolls back when rollup persistence fails', async () => {
    const log: ValidLog = {
      timestamp:
        '2450-01-01T00:00:10.000Z',
      level: 'info',
      service:
        'rollup-failure-test',
      message: 'must rollback',
      attributes: {},
    };

    const {
      stream,
    } = createWritableCollector();

    const rollupError = new Error(
      'rollup persistence failed',
    );

    const {
      client,
      query,
      release,
    } = createMockClient(
      stream,
      rollupError,
    );

    mockPoolConnection(client);

    await expect(
      insertLogs([log]),
    ).rejects.toBe(rollupError);

    const sqlCalls = query.mock.calls.map(
      ([statement]) =>
        typeof statement === 'string'
          ? normalizeSql(statement)
          : '',
    );

    expect(sqlCalls).toContain('BEGIN');
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');

    expect(
      release,
    ).toHaveBeenCalledTimes(1);
  });

  it('coalesces logs with the same minute, service, and level into one rollup delta', async () => {
    const logs: ValidLog[] = [
      {
        timestamp:
          '2450-01-01T00:00:01.000Z',
        level: 'info',
        service: 'rollup-test',
        message: 'first',
        attributes: {},
      },
      {
        timestamp:
          '2450-01-01T00:00:20.000Z',
        level: 'info',
        service: 'rollup-test',
        message: 'second',
        attributes: {},
      },
      {
        timestamp:
          '2450-01-01T00:00:59.000Z',
        level: 'info',
        service: 'rollup-test',
        message: 'third',
        attributes: {},
      },
    ];

    const {
      stream,
    } = createWritableCollector();

    const {
      client,
      query,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs(logs);

    const rollupCall =
      query.mock.calls.find(
        ([statement]) =>
          typeof statement ===
            'string' &&
          normalizeSql(
            statement,
          ).includes(
            'INSERT INTO log_rollups_1m',
          ),
      );

    expect(
      rollupCall,
    ).toBeDefined();

    expect(
      rollupCall?.[1],
    ).toEqual([
      '2450-01-01T00:00:00.000Z',
      'rollup-test',
      'info',
      3,
    ]);
  });

  it('keeps different service or level combinations as separate rollup deltas', async () => {
    const logs: ValidLog[] = [
      {
        timestamp:
          '2450-01-01T00:00:01.000Z',
        level: 'info',
        service: 'service-a',
        message: 'first',
        attributes: {},
      },
      {
        timestamp:
          '2450-01-01T00:00:10.000Z',
        level: 'error',
        service: 'service-a',
        message: 'second',
        attributes: {},
      },
      {
        timestamp:
          '2450-01-01T00:00:20.000Z',
        level: 'info',
        service: 'service-b',
        message: 'third',
        attributes: {},
      },
    ];

    const {
      stream,
    } = createWritableCollector();

    const {
      client,
      query,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs(logs);

    const rollupCall =
      query.mock.calls.find(
        ([statement]) =>
          typeof statement ===
            'string' &&
          normalizeSql(
            statement,
          ).includes(
            'INSERT INTO log_rollups_1m',
          ),
      );

    expect(
      rollupCall,
    ).toBeDefined();

    expect(
      rollupCall?.[1],
    ).toEqual([
      '2450-01-01T00:00:00.000Z',
      'service-a',
      'info',
      1,

      '2450-01-01T00:00:00.000Z',
      'service-a',
      'error',
      1,

      '2450-01-01T00:00:00.000Z',
      'service-b',
      'info',
      1,
    ]);
  });

  it('commits after COPY and rollup persistence succeed', async () => {
    const log: ValidLog = {
      timestamp:
        '2450-01-01T00:00:10.000Z',
      level: 'info',
      service: 'commit-test',
      message: 'success',
      attributes: {},
    };

    const {
      stream,
    } = createWritableCollector();

    const {
      client,
      query,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await insertLogs([log]);

    const sqlCalls = query.mock.calls.map(
      ([statement]) =>
        typeof statement === 'string'
          ? normalizeSql(statement)
          : 'COPY',
    );

    const beginIndex =
      sqlCalls.indexOf('BEGIN');

    const rollupIndex =
      sqlCalls.findIndex(
        (sql) =>
          sql.includes(
            'INSERT INTO log_rollups_1m',
          ),
      );

    const commitIndex =
      sqlCalls.indexOf('COMMIT');

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(rollupIndex).toBeGreaterThan(
      beginIndex,
    );
    expect(commitIndex).toBeGreaterThan(
      rollupIndex,
    );

    expect(sqlCalls).not.toContain(
      'ROLLBACK',
    );
  });
});
