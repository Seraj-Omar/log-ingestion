import { afterEach, describe, expect, it, vi } from 'vitest';

import { pool } from '../../src/database/pool.js';
import { insertLogs } from '../../src/repositories/logs.js';
import type { ValidLog } from '../../src/schemas/log.js';

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
});
