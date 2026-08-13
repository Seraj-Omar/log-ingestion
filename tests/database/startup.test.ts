import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  checkDatabaseConnection: vi.fn(),
  ensureRollingPartitions: vi.fn(),
  dropExpiredPartitions: vi.fn(),
}));

vi.mock('../../src/database/pool.js', () => ({
  checkDatabaseConnection: databaseMocks.checkDatabaseConnection,
}));

vi.mock('../../src/database/partitions.js', () => ({
  ensureRollingPartitions: databaseMocks.ensureRollingPartitions,
}));

vi.mock('../../src/database/retention.js', () => ({
  dropExpiredPartitions: databaseMocks.dropExpiredPartitions,
}));

import { prepareDatabase } from '../../src/database/startup.js';

describe('prepareDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.dropExpiredPartitions.mockResolvedValue([]);
  });

  it('checks connectivity, prepares partitions, then applies retention', async () => {
    await prepareDatabase();

    expect(databaseMocks.checkDatabaseConnection).toHaveBeenCalledOnce();
    expect(databaseMocks.ensureRollingPartitions).toHaveBeenCalledOnce();
    expect(databaseMocks.dropExpiredPartitions).toHaveBeenCalledOnce();
    expect(
      databaseMocks.checkDatabaseConnection.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      databaseMocks.ensureRollingPartitions.mock.invocationCallOrder[0]!,
    );
    expect(
      databaseMocks.ensureRollingPartitions.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      databaseMocks.dropExpiredPartitions.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps startup available when retention cleanup fails', async () => {
    const error = new Error('retention unavailable');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    databaseMocks.dropExpiredPartitions.mockRejectedValue(error);

    await expect(prepareDatabase()).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      'retention cleanup failed',
      error,
    );
    consoleError.mockRestore();
  });
});
