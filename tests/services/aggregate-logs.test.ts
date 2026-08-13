import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repositories/aggregate.js', () => ({
  aggregateLogs: vi.fn(),
}));

import {
  aggregateLogs,
  type AggregateRow,
} from '../../src/repositories/aggregate.js';
import type { AggregateQueryFilters } from '../../src/schemas/aggregate-query.js';
import { getAggregatedLogs } from '../../src/services/aggregate-logs.js';

const aggregateLogsMock = vi.mocked(aggregateLogs);

function filters(
  overrides: Partial<AggregateQueryFilters> = {},
): AggregateQueryFilters {
  return {
    since: '2026-08-12T10:00:00.000Z',
    until: '2026-08-12T11:00:00.000Z',
    bucket: '1m',
    attributes: {},
    ...overrides,
  };
}

function row(
  timestamp: string,
  count: string,
  group_value?: string,
): AggregateRow {
  return {
    bucket: new Date(timestamp),
    count,
    ...(group_value === undefined ? {} : { group_value }),
  };
}

describe('getAggregatedLogs', () => {
  beforeEach(() => {
    aggregateLogsMock.mockReset();
  });

  it('returns an empty buckets array for an empty repository result', async () => {
    aggregateLogsMock.mockResolvedValue([]);

    await expect(getAggregatedLogs(filters())).resolves.toEqual({
      buckets: [],
    });
  });

  it('shapes one ungrouped repository row', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '5'),
    ]);

    await expect(getAggregatedLogs(filters())).resolves.toEqual({
      buckets: [
        {
          start: '2026-08-12T10:00:00.000Z',
          group: null,
          count: 5,
        },
      ],
    });
  });

  it('converts repository bucket Dates to ISO strings', async () => {
    const bucket = new Date('2026-08-12T10:00:00.123Z');
    aggregateLogsMock.mockResolvedValue([{ bucket, count: '1' }]);

    const result = await getAggregatedLogs(filters());

    expect(result.buckets[0]?.start).toBe(bucket.toISOString());
    expect(typeof result.buckets[0]?.start).toBe('string');
  });

  it('converts the repository bigint count to a contract JSON number', async () => {
    const count = '2147483647';
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', count),
    ]);

    const result = await getAggregatedLogs(filters());

    expect(result.buckets[0]?.count).toBe(2147483647);
    expect(typeof result.buckets[0]?.count).toBe('number');
  });

  it('shapes a grouped repository row', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '12', 'checkout'),
    ]);

    await expect(getAggregatedLogs(filters())).resolves.toEqual({
      buckets: [
        {
          start: '2026-08-12T10:00:00.000Z',
          group: 'checkout',
          count: 12,
        },
      ],
    });
  });

  it('renames group_value to group without exposing the repository field', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '12', 'checkout'),
    ]);

    const result = await getAggregatedLogs(filters());
    const item = result.buckets[0];

    expect(item).toHaveProperty('group', 'checkout');
    expect(item).not.toHaveProperty('group_value');
  });

  it('uses null group when the repository row has no group_value', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '5'),
    ]);

    const result = await getAggregatedLogs(filters());

    expect(result.buckets[0]).toHaveProperty('group', null);
  });

  it('preserves repository ordering across multiple rows', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '2'),
      row('2026-08-12T10:01:00.000Z', '3'),
      row('2026-08-12T10:05:00.000Z', '1'),
    ]);

    const result = await getAggregatedLogs(filters());

    expect(result.buckets.map(({ start }) => start)).toEqual([
      '2026-08-12T10:00:00.000Z',
      '2026-08-12T10:01:00.000Z',
      '2026-08-12T10:05:00.000Z',
    ]);
  });

  it('shapes multiple grouped rows correctly', async () => {
    aggregateLogsMock.mockResolvedValue([
      row('2026-08-12T10:00:00.000Z', '4', 'checkout'),
      row('2026-08-12T10:00:00.000Z', '2', 'billing'),
    ]);

    await expect(getAggregatedLogs(filters())).resolves.toEqual({
      buckets: [
        {
          start: '2026-08-12T10:00:00.000Z',
          group: 'checkout',
          count: 4,
        },
        {
          start: '2026-08-12T10:00:00.000Z',
          group: 'billing',
          count: 2,
        },
      ],
    });
  });

  it('passes the original complete filters object to the repository', async () => {
    const inputFilters = filters({
      since: '2026-08-12T08:00:00.000Z',
      until: '2026-08-12T12:00:00.000Z',
      bucket: '5m',
      group_by: 'service',
      service: 'checkout',
      level: 'warn',
      q: 'payment',
      attributes: { user_id: '42', region: 'eu-west' },
    });
    aggregateLogsMock.mockResolvedValue([]);

    await getAggregatedLogs(inputFilters);

    expect(aggregateLogsMock.mock.calls[0]?.[0]).toBe(inputFilters);
  });

  it('calls the repository exactly once', async () => {
    const inputFilters = filters();
    aggregateLogsMock.mockResolvedValue([]);

    await getAggregatedLogs(inputFilters);

    expect(aggregateLogsMock).toHaveBeenCalledTimes(1);
    expect(aggregateLogsMock).toHaveBeenCalledWith(inputFilters);
  });

  it('propagates the original repository error', async () => {
    const error = new Error('database unavailable');
    aggregateLogsMock.mockRejectedValue(error);

    await expect(getAggregatedLogs(filters())).rejects.toBe(error);
  });
});
