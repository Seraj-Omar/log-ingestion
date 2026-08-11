import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  checkDatabaseConnection: vi.fn(),
  ensureRollingPartitions: vi.fn(),
}));

vi.mock('../../src/database/pool.js', () => ({
  checkDatabaseConnection: databaseMocks.checkDatabaseConnection,
}));

vi.mock('../../src/database/partitions.js', () => ({
  ensureRollingPartitions: databaseMocks.ensureRollingPartitions,
}));

import { prepareDatabase } from '../../src/database/startup.js';

describe('prepareDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks connectivity before preparing rolling partitions', async () => {
    await prepareDatabase();

    expect(databaseMocks.checkDatabaseConnection).toHaveBeenCalledOnce();
    expect(databaseMocks.ensureRollingPartitions).toHaveBeenCalledOnce();
    expect(
      databaseMocks.checkDatabaseConnection.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      databaseMocks.ensureRollingPartitions.mock.invocationCallOrder[0]!,
    );
  });
});
