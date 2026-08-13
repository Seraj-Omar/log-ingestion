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
});
