import type { PoolClient } from 'pg';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const databaseMocks = vi.hoisted(() => {
  const query = vi.fn();
  const clientQuery = vi.fn();
  const release = vi.fn();

  const connect = vi.fn().mockResolvedValue({
    query: clientQuery,
    release,
  });

  return {
    query,
    clientQuery,
    release,
    connect,
  };
});

vi.mock('../../src/database/pool.js', () => ({
  pool: {
    query: databaseMocks.query,
    connect: databaseMocks.connect,
  },
}));

describe('partition creation cache', () => {
  beforeEach(() => {
    vi.resetModules();

    databaseMocks.query.mockReset();
    databaseMocks.clientQuery.mockReset();
    databaseMocks.release.mockReset();
    databaseMocks.connect.mockReset();

    databaseMocks.connect.mockResolvedValue({
      query: databaseMocks.clientQuery,
      release: databaseMocks.release,
    });
  });

  it('does not repeat DDL after a partition is successfully ensured', async () => {
    databaseMocks.query.mockResolvedValue(
      undefined,
    );

    const {
      ensureDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    const date = new Date(
      '2450-01-02T03:04:05.000Z',
    );

    await ensureDailyPartition(date);
    await ensureDailyPartition(date);

    expect(
      databaseMocks.query,
    ).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent creation of the same partition', async () => {
    let finishCreation:
      | (() => void)
      | undefined;

    databaseMocks.query.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
    );

    const {
      ensureDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    const date = new Date(
      '2451-02-03T00:00:00.000Z',
    );

    const first =
      ensureDailyPartition(date);

    const second =
      ensureDailyPartition(date);

    expect(
      databaseMocks.query,
    ).toHaveBeenCalledOnce();

    finishCreation?.();

    await Promise.all([
      first,
      second,
    ]);
  });

  it('allows a failed partition creation to be retried', async () => {
    databaseMocks.query
      .mockRejectedValueOnce(
        new Error(
          'database unavailable',
        ),
      )
      .mockResolvedValueOnce(
        undefined,
      );

    const {
      ensureDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    const date = new Date(
      '2452-03-04T00:00:00.000Z',
    );

    await expect(
      ensureDailyPartition(date),
    ).rejects.toThrow(
      'database unavailable',
    );

    await expect(
      ensureDailyPartition(date),
    ).resolves.toBeUndefined();

    expect(
      databaseMocks.query,
    ).toHaveBeenCalledTimes(2);
  });

  it('serializes retention drops with creation and recreates afterward', async () => {
    let finishDrop:
      | (() => void)
      | undefined;

    /*
     * Initial partition creation.
     */
    databaseMocks.query.mockResolvedValue(
      undefined,
    );

    /*
     * Transactional partition drop:
     *
     * BEGIN
     * DROP TABLE  <- deliberately block here
     * COMMIT
     */
    databaseMocks.clientQuery.mockImplementation(
      (sql: string) => {
        const normalized =
          sql.replace(/\s+/g, ' ').trim();

        if (normalized === 'BEGIN') {
          return Promise.resolve(
            undefined,
          );
        }

        if (
          normalized.includes(
            'DROP TABLE IF EXISTS',
          )
        ) {
          return new Promise<void>(
            (resolve) => {
              finishDrop = resolve;
            },
          );
        }

        if (
          normalized === 'COMMIT' ||
          normalized === 'ROLLBACK'
        ) {
          return Promise.resolve(
            undefined,
          );
        }

        return Promise.resolve(
          undefined,
        );
      },
    );

    const {
      dropDailyPartition,
      ensureDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    const date = new Date(
      '2453-04-05T00:00:00.000Z',
    );

    /*
     * Create and cache the partition first.
     */
    await ensureDailyPartition(date);

    expect(
      databaseMocks.query,
    ).toHaveBeenCalledTimes(1);

    /*
     * Start dropping it. The DROP TABLE call
     * remains pending until finishDrop().
     */
    const dropping =
      dropDailyPartition(
        'logs_2453_04_05',
      );

    /*
     * Give the async operation a chance to reach
     * the transactional DROP TABLE statement.
     */
    await vi.waitFor(() => {
      expect(
        databaseMocks.clientQuery,
      ).toHaveBeenCalledWith(
        expect.stringContaining(
          'DROP TABLE',
        ),
      );
    });

    /*
     * Request the same partition while its drop
     * is still in progress.
     *
     * runPartitionOperation must serialize this
     * creation behind the drop.
     */
    const ensuring =
      ensureDailyPartition(date);

    /*
     * The recreation must NOT run yet.
     */
    expect(
      databaseMocks.query,
    ).toHaveBeenCalledTimes(1);

    finishDrop?.();

    await Promise.all([
      dropping,
      ensuring,
    ]);

    /*
     * After the drop commits, the partition is
     * removed from knownPartitions and the queued
     * ensure operation recreates it.
     */
    expect(
      databaseMocks.query,
    ).toHaveBeenCalledTimes(2);

    expect(
      databaseMocks.query.mock.calls[1]?.[0],
    ).toContain('CREATE TABLE');

    expect(
      databaseMocks.clientQuery,
    ).toHaveBeenCalledWith(
      'BEGIN',
    );

    expect(
      databaseMocks.clientQuery,
    ).toHaveBeenCalledWith(
      expect.stringContaining(
        'DROP TABLE',
      ),
    );

    expect(
      databaseMocks.clientQuery,
    ).toHaveBeenCalledWith(
      'COMMIT',
    );

    expect(
      databaseMocks.release,
    ).toHaveBeenCalledOnce();
  });

  it('rolls back a failed transactional partition drop', async () => {
    const dropError =
      new Error('drop failed');

    databaseMocks.clientQuery.mockImplementation(
      (sql: string) => {
        const normalized =
          sql.replace(/\s+/g, ' ').trim();

        if (normalized === 'BEGIN') {
          return Promise.resolve(
            undefined,
          );
        }

        if (
          normalized.includes(
            'DROP TABLE IF EXISTS',
          )
        ) {
          return Promise.reject(
            dropError,
          );
        }

        if (
          normalized === 'ROLLBACK'
        ) {
          return Promise.resolve(
            undefined,
          );
        }

        return Promise.resolve(
          undefined,
        );
      },
    );

    const {
      dropDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    await expect(
      dropDailyPartition(
        'logs_2454_05_06',
      ),
    ).rejects.toBe(dropError);

    expect(
      databaseMocks.clientQuery,
    ).toHaveBeenCalledWith(
      'BEGIN',
    );

    expect(
      databaseMocks.clientQuery,
    ).toHaveBeenCalledWith(
      'ROLLBACK',
    );

    expect(
      databaseMocks.clientQuery,
    ).not.toHaveBeenCalledWith(
      'COMMIT',
    );

    expect(
      databaseMocks.release,
    ).toHaveBeenCalledOnce();
  });

  it('runs the before-drop callback inside the same transaction', async () => {
    databaseMocks.clientQuery.mockResolvedValue(
      undefined,
    );

    const {
      dropDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    const beforeDrop = vi.fn(
      async (client: PoolClient) => {
        await client.query(
          'DELETE FROM log_rollups_1m',
        );
      },
    );

    await dropDailyPartition(
      'logs_2455_06_07',
      beforeDrop,
    );

    expect(
      beforeDrop,
    ).toHaveBeenCalledOnce();

    const sqlCalls =
      databaseMocks.clientQuery.mock.calls.map(
        ([sql]) =>
          typeof sql === 'string'
            ? sql
                .replace(/\s+/g, ' ')
                .trim()
            : '',
      );

    const beginIndex =
      sqlCalls.indexOf('BEGIN');

    const deleteIndex =
      sqlCalls.indexOf(
        'DELETE FROM log_rollups_1m',
      );

    const dropIndex =
      sqlCalls.findIndex(
        (sql) =>
          sql.includes(
            'DROP TABLE IF EXISTS',
          ),
      );

    const commitIndex =
      sqlCalls.indexOf('COMMIT');

    expect(
      beginIndex,
    ).toBeGreaterThanOrEqual(0);

    expect(
      deleteIndex,
    ).toBeGreaterThan(
      beginIndex,
    );

    expect(
      dropIndex,
    ).toBeGreaterThan(
      deleteIndex,
    );

    expect(
      commitIndex,
    ).toBeGreaterThan(
      dropIndex,
    );
  });

  it('rejects an untrusted partition identifier without running SQL', async () => {
    const {
      dropDailyPartition,
    } = await import(
      '../../src/database/partitions.js'
    );

    await expect(
      dropDailyPartition(
        'logs_2026_08_13"; DROP TABLE logs; --',
      ),
    ).rejects.toThrow(
      'invalid daily partition name',
    );

    expect(
      databaseMocks.query,
    ).not.toHaveBeenCalled();

    expect(
      databaseMocks.connect,
    ).not.toHaveBeenCalled();

    expect(
      databaseMocks.clientQuery,
    ).not.toHaveBeenCalled();
  });
});