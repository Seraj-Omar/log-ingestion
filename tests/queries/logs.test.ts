import { describe, expect, it } from 'vitest';

import { buildLogQuery } from '../../src/queries/logs.js';
import type { LogQueryFilters } from '../../src/schemas/log-query.js';
import type { LogCursor } from '../../src/utils/cursor.js';

function filters(
  overrides: Partial<LogQueryFilters> = {},
): LogQueryFilters {
  return {
    limit: 100,
    attributes: {},
    ...overrides,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('buildLogQuery', () => {
  it('builds an unfiltered query with descending order and limit lookahead', () => {
    const query = buildLogQuery(filters());
    const sql = normalizeSql(query.text);

    expect(sql).not.toMatch(/\bWHERE\b/i);
    expect(sql).toContain('ORDER BY timestamp DESC, id DESC');
    expect(sql).toContain('LIMIT $1');
    expect(query.values).toEqual([101]);
  });

  it('parameterizes a service filter', () => {
    const query = buildLogQuery(filters({ service: 'checkout' }));
    const sql = normalizeSql(query.text);

    expect(sql).toContain('WHERE service = $1');
    expect(query.values).toEqual(['checkout', 101]);
  });

  it('parameterizes a level filter', () => {
    const query = buildLogQuery(filters({ level: 'error' }));

    expect(normalizeSql(query.text)).toContain('WHERE level = $1');
    expect(query.values).toEqual(['error', 101]);
  });

  it('uses an inclusive lower timestamp bound for since', () => {
    const since = '2026-08-12T10:00:00.000Z';
    const query = buildLogQuery(filters({ since }));

    expect(normalizeSql(query.text)).toContain('timestamp >= $1');
    expect(query.values).toEqual([since, 101]);
  });

  it('uses an exclusive upper timestamp bound for until', () => {
    const until = '2026-08-12T11:00:00.000Z';
    const query = buildLogQuery(filters({ until }));

    expect(normalizeSql(query.text)).toContain('timestamp < $1');
    expect(query.values).toEqual([until, 101]);
  });

  it('parameterizes both key and value for one attribute filter', () => {
    const query = buildLogQuery(
      filters({ attributes: { user_id: '42' } }),
    );

    expect(normalizeSql(query.text)).toContain('attributes ->> $1 = $2');
    expect(query.values).toEqual(['user_id', '42', 101]);
  });

  it('numbers multiple attribute-filter placeholders correctly', () => {
    const query = buildLogQuery(
      filters({
        attributes: {
          user_id: '42',
          region: 'eu-west',
        },
      }),
    );
    const sql = normalizeSql(query.text);

    expect(sql).toContain('attributes ->> $1 = $2');
    expect(sql).toContain('attributes ->> $3 = $4');
    expect(sql).toContain('LIMIT $5');
    expect(query.values).toEqual([
      'user_id',
      '42',
      'region',
      'eu-west',
      101,
    ]);
  });

  it('wraps and parameterizes the q filter for ILIKE', () => {
    const query = buildLogQuery(filters({ q: 'payment' }));

    expect(normalizeSql(query.text)).toContain('message ILIKE $1');
    expect(query.values).toEqual(['%payment%', 101]);
  });

  it('parameterizes both cursor components in the tuple comparison', () => {
    const cursor: LogCursor = {
      timestamp: '2026-08-12T10:00:00.000Z',
      id: '42',
    };
    const query = buildLogQuery(filters(), cursor);

    expect(normalizeSql(query.text)).toContain(
      '(timestamp, id) < ($1, $2)',
    );
    expect(query.values).toEqual([cursor.timestamp, cursor.id, 101]);
  });

  it('uses 2 as the query limit when the requested limit is 1', () => {
    const query = buildLogQuery(filters({ limit: 1 }));

    expect(normalizeSql(query.text)).toContain('LIMIT $1');
    expect(query.values).toEqual([2]);
  });

  it('uses 1001 as the query limit when the requested limit is 1000', () => {
    const query = buildLogQuery(filters({ limit: 1000 }));

    expect(normalizeSql(query.text)).toContain('LIMIT $1');
    expect(query.values).toEqual([1001]);
  });

  it('numbers combined-filter placeholders without gaps or duplicates', () => {
    const cursor: LogCursor = {
      timestamp: '2026-08-12T10:30:00.000Z',
      id: '9001',
    };
    const query = buildLogQuery(
      filters({
        service: 'checkout',
        level: 'warn',
        since: '2026-08-12T09:00:00.000Z',
        until: '2026-08-12T11:00:00.000Z',
        attributes: {
          user_id: '42',
          region: 'eu-west',
        },
        q: 'payment',
        limit: 25,
      }),
      cursor,
    );
    const placeholders = [...query.text.matchAll(/\$(\d+)/g)].map(
      (match) => Number(match[1]),
    );

    expect(placeholders).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(query.values).toEqual([
      'checkout',
      'warn',
      '2026-08-12T09:00:00.000Z',
      '2026-08-12T11:00:00.000Z',
      'user_id',
      '42',
      'region',
      'eu-west',
      '%payment%',
      cursor.timestamp,
      cursor.id,
      26,
    ]);
  });

  it('keeps an injection-looking service value out of SQL text', () => {
    const service = "x' OR 1=1 --";
    const query = buildLogQuery(filters({ service }));

    expect(query.text).not.toContain(service);
    expect(query.text).toContain('service = $1');
    expect(query.values).toContain(service);
  });

  it('keeps injection-looking attribute keys and values out of SQL text', () => {
    const key = "user_id' OR '1'='1";
    const value = "42'; DROP TABLE logs; --";
    const query = buildLogQuery(filters({ attributes: { [key]: value } }));

    expect(query.text).not.toContain(key);
    expect(query.text).not.toContain(value);
    expect(query.text).toContain('attributes ->> $1 = $2');
    expect(query.values).toEqual([key, value, 101]);
  });

  it('keeps an injection-looking q value out of SQL text', () => {
    const q = "x%' OR 1=1 --";
    const query = buildLogQuery(filters({ q }));

    expect(query.text).not.toContain(q);
    expect(query.text).toContain('message ILIKE $1');
    expect(query.values).toEqual([`%${q}%`, 101]);
  });

  it('keeps injection-looking cursor strings as parameters', () => {
    const cursor: LogCursor = {
      timestamp: "2026-08-12T10:00:00.000Z' OR 1=1 --",
      id: "42' OR 1=1 --",
    };
    const query = buildLogQuery(filters(), cursor);

    expect(query.text).not.toContain(cursor.timestamp);
    expect(query.text).not.toContain(cursor.id);
    expect(query.text).toContain('(timestamp, id) < ($1, $2)');
    expect(query.values).toEqual([cursor.timestamp, cursor.id, 101]);
  });

  it('adds no attribute condition for an empty attributes object', () => {
    const query = buildLogQuery(filters({ attributes: {} }));

    expect(query.text).not.toContain('attributes ->>');
    expect(query.values).toEqual([101]);
  });

  it('selects every log response column', () => {
    const sql = normalizeSql(buildLogQuery(filters()).text);

    expect(sql).toMatch(
      /SELECT id, timestamp, level, service, message, attributes FROM logs/i,
    );
  });
});
