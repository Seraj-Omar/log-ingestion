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

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    getOutput: () => output,
  };
}

function createFailingWritable(error: Error) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(error);
    },
  });
}

function createMockClient(copyStream: Writable) {
  const query = vi.fn().mockReturnValue(copyStream);
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

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
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
      query,
      release,
    } = createMockClient(stream);

    const connectSpy = mockPoolConnection(client);

    await insertLogs(logs);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(pgCopyMocks.from).toHaveBeenCalledTimes(1);

    const copySql = pgCopyMocks.from.mock.calls[0]?.[0];

    expect(copySql).toBeDefined();

    expect(
      normalizeSql(copySql ?? ''),
    ).toMatch(
      /COPY logs \( timestamp, level, service, message, attributes \) FROM STDIN WITH \(FORMAT csv\)/i,
    );

    expect(query).toHaveBeenCalledTimes(1);

    expect(getOutput()).toBe(
      [
        '"2450-01-01T00:00:00.000Z","info","copy-test","first","{""sequence"":1}"',
        '"2450-01-01T00:00:01.000Z","warn","copy-test","second","{""sequence"":2}"',
        '',
      ].join('\n'),
    );

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('correctly escapes CSV-sensitive log values', async () => {
    const logs: ValidLog[] = [
      {
        timestamp: '2450-01-01T00:00:00.000Z',
        level: 'info',
        service: 'csv,test',
        message: 'hello, "quoted"\nnext line',
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

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('serializes attributes as JSON before copying them', async () => {
    const logs: ValidLog[] = [
      {
        timestamp: '2450-01-01T00:00:00.000Z',
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

    const expectedJson = JSON.stringify(
      logs[0]?.attributes,
    ).replace(/"/g, '""');

    expect(getOutput()).toContain(
      `"${expectedJson}"`,
    );
  });

  it('releases the database client after a successful COPY', async () => {
    const log: ValidLog = {
      timestamp: '2450-01-01T00:00:00.000Z',
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

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects and releases the database client when COPY fails', async () => {
    const log: ValidLog = {
      timestamp: '2450-01-01T00:00:00.000Z',
      level: 'info',
      service: 'failure-test',
      message: 'copy should fail',
      attributes: {},
    };

    const copyError = new Error(
      'COPY stream failed',
    );

    const stream = createFailingWritable(
      copyError,
    );

    const {
      client,
      release,
    } = createMockClient(stream);

    mockPoolConnection(client);

    await expect(
      insertLogs([log]),
    ).rejects.toBe(copyError);

    expect(release).toHaveBeenCalledTimes(1);
  });
});