import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../src/database/pool.js', () => ({
  pool: {
    query: databaseMocks.query,
  },
}));

describe('partition creation cache', () => {
  beforeEach(() => {
    vi.resetModules();
    databaseMocks.query.mockReset();
  });

  it('does not repeat DDL after a partition is successfully ensured', async () => {
    databaseMocks.query.mockResolvedValue(undefined);
    const { ensureDailyPartition } = await import(
      '../../src/database/partitions.js'
    );
    const date = new Date('2450-01-02T03:04:05.000Z');

    await ensureDailyPartition(date);
    await ensureDailyPartition(date);

    expect(databaseMocks.query).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent creation of the same partition', async () => {
    let finishCreation: (() => void) | undefined;
    databaseMocks.query.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
    );
    const { ensureDailyPartition } = await import(
      '../../src/database/partitions.js'
    );
    const date = new Date('2451-02-03T00:00:00.000Z');

    const first = ensureDailyPartition(date);
    const second = ensureDailyPartition(date);

    expect(databaseMocks.query).toHaveBeenCalledOnce();

    finishCreation?.();
    await Promise.all([first, second]);
  });

  it('allows a failed partition creation to be retried', async () => {
    databaseMocks.query
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const { ensureDailyPartition } = await import(
      '../../src/database/partitions.js'
    );
    const date = new Date('2452-03-04T00:00:00.000Z');

    await expect(ensureDailyPartition(date)).rejects.toThrow(
      'database unavailable',
    );
    await expect(ensureDailyPartition(date)).resolves.toBeUndefined();

    expect(databaseMocks.query).toHaveBeenCalledTimes(2);
  });

  it('serializes retention drops with creation and recreates afterward', async () => {
    let finishDrop: (() => void) | undefined;
    databaseMocks.query
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishDrop = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);
    const { dropDailyPartition, ensureDailyPartition } = await import(
      '../../src/database/partitions.js'
    );
    const date = new Date('2453-04-05T00:00:00.000Z');

    await ensureDailyPartition(date);
    const dropping = dropDailyPartition('logs_2453_04_05');
    const ensuring = ensureDailyPartition(date);

    expect(databaseMocks.query).toHaveBeenCalledTimes(2);

    finishDrop?.();
    await Promise.all([dropping, ensuring]);

    expect(databaseMocks.query).toHaveBeenCalledTimes(3);
    expect(databaseMocks.query.mock.calls[1]?.[0]).toContain('DROP TABLE');
    expect(databaseMocks.query.mock.calls[2]?.[0]).toContain('CREATE TABLE');
  });

  it('rejects an untrusted partition identifier without running SQL', async () => {
    const { dropDailyPartition } = await import(
      '../../src/database/partitions.js'
    );

    await expect(
      dropDailyPartition('logs_2026_08_13"; DROP TABLE logs; --'),
    ).rejects.toThrow('invalid daily partition name');
    expect(databaseMocks.query).not.toHaveBeenCalled();
  });
});
