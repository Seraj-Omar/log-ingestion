import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repositories/log-queries.js', () => ({
  queryLogs: vi.fn(),
}));

import { queryLogs, type LogRow } from '../../src/repositories/log-queries.js';
import type { LogQueryFilters } from '../../src/schemas/log-query.js';
import { getLogs } from '../../src/services/query-logs.js';
import { decodeCursor, encodeCursor } from '../../src/utils/cursor.js';

const queryLogsMock = vi.mocked(queryLogs);

function filters(
  overrides: Partial<LogQueryFilters> = {},
): LogQueryFilters {
  return {
    limit: 2,
    attributes: {},
    ...overrides,
  };
}

function row(
  id: string,
  timestamp: string,
  overrides: Partial<LogRow> = {},
): LogRow {
  return {
    id,
    timestamp: new Date(timestamp),
    level: 'info',
    service: 'query-test',
    message: `message-${id}`,
    attributes: { user_id: id },
    ...overrides,
  };
}

const firstRow = row('123', '2026-08-12T10:00:00.000Z');
const secondRow = row('122', '2026-08-12T09:00:00.000Z');
const lookaheadRow = row('121', '2026-08-12T08:00:00.000Z');

describe('getLogs', () => {
  beforeEach(() => {
    queryLogsMock.mockReset();
  });

  it('returns all repository rows and no cursor when fewer than limit are returned', async () => {
    queryLogsMock.mockResolvedValue([firstRow]);

    const result = await getLogs(filters());

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      id: firstRow.id,
      message: firstRow.message,
    });
    expect(result.next_cursor).toBeNull();
  });

  it('does not create a next cursor when exactly limit rows are returned', async () => {
    queryLogsMock.mockResolvedValue([firstRow, secondRow]);

    const result = await getLogs(filters({ limit: 2 }));

    expect(result.logs).toHaveLength(2);
    expect(result.next_cursor).toBeNull();
  });

  it('trims a limit + 1 result and creates a next cursor', async () => {
    queryLogsMock.mockResolvedValue([firstRow, secondRow, lookaheadRow]);

    const result = await getLogs(filters({ limit: 2 }));

    expect(result.logs.map(({ id }) => id)).toEqual(['123', '122']);
    expect(result.next_cursor).not.toBeNull();
  });

  it('builds the next cursor from the last visible row, not the lookahead row', async () => {
    queryLogsMock.mockResolvedValue([firstRow, secondRow, lookaheadRow]);

    const result = await getLogs(filters({ limit: 2 }));

    expect(result.next_cursor).not.toBeNull();
    expect(decodeCursor(result.next_cursor ?? '')).toEqual({
      timestamp: secondRow.timestamp.toISOString(),
      id: secondRow.id,
    });
    expect(decodeCursor(result.next_cursor ?? '').id).not.toBe(lookaheadRow.id);
  });

  it('converts repository Date timestamps to ISO strings', async () => {
    const timestamp = new Date('2026-08-12T10:00:00.123Z');
    queryLogsMock.mockResolvedValue([
      row('123', timestamp.toISOString(), { timestamp }),
    ]);

    const result = await getLogs(filters());

    expect(result.logs[0]?.timestamp).toBe(timestamp.toISOString());
    expect(typeof result.logs[0]?.timestamp).toBe('string');
  });

  it('preserves BIGINT-like ids exactly as strings', async () => {
    const id = '9223372036854775807';
    queryLogsMock.mockResolvedValue([
      row(id, '2026-08-12T10:00:00.000Z'),
    ]);

    const result = await getLogs(filters());

    expect(result.logs[0]?.id).toBe(id);
    expect(typeof result.logs[0]?.id).toBe('string');
  });

  it('preserves attributes in returned logs', async () => {
    const attributes = {
      user_id: '42',
      attempt: 3,
      successful: true,
    };
    queryLogsMock.mockResolvedValue([
      row('123', '2026-08-12T10:00:00.000Z', { attributes }),
    ]);

    const result = await getLogs(filters());

    expect(result.logs[0]?.attributes).toEqual(attributes);
  });

  it('returns an empty result with no next cursor', async () => {
    queryLogsMock.mockResolvedValue([]);

    await expect(getLogs(filters())).resolves.toEqual({
      logs: [],
      next_cursor: null,
    });
  });

  it('decodes an incoming cursor and passes it to the repository', async () => {
    const decodedCursor = {
      timestamp: '2026-08-12T10:00:00.000Z',
      id: '123',
    };
    const inputFilters = filters({ cursor: encodeCursor(decodedCursor) });
    queryLogsMock.mockResolvedValue([]);

    await getLogs(inputFilters);

    expect(queryLogsMock).toHaveBeenCalledWith(inputFilters, decodedCursor);
  });

  it('passes undefined as the repository cursor when none is supplied', async () => {
    const inputFilters = filters();
    queryLogsMock.mockResolvedValue([]);

    await getLogs(inputFilters);

    expect(queryLogsMock).toHaveBeenCalledWith(inputFilters, undefined);
  });

  it('rejects a malformed incoming cursor before calling the repository', async () => {
    const inputFilters = filters({ cursor: 'not-a-valid-cursor' });

    await expect(getLogs(inputFilters)).rejects.toThrow('invalid cursor');
    expect(queryLogsMock).not.toHaveBeenCalled();
  });

  it('passes the original filter object to the repository', async () => {
    const inputFilters = filters({
      service: 'checkout',
      level: 'warn',
      since: '2026-08-12T08:00:00.000Z',
      until: '2026-08-12T11:00:00.000Z',
      q: 'payment',
      attributes: { region: 'eu-west' },
      limit: 25,
    });
    queryLogsMock.mockResolvedValue([]);

    await getLogs(inputFilters);

    expect(queryLogsMock.mock.calls[0]?.[0]).toBe(inputFilters);
  });

  it('returns one visible row and a next cursor for limit 1 with two rows', async () => {
    queryLogsMock.mockResolvedValue([firstRow, secondRow]);

    const result = await getLogs(filters({ limit: 1 }));

    expect(result.logs.map(({ id }) => id)).toEqual([firstRow.id]);
    expect(result.next_cursor).not.toBeNull();
    expect(decodeCursor(result.next_cursor ?? '')).toEqual({
      timestamp: firstRow.timestamp.toISOString(),
      id: firstRow.id,
    });
  });
});
