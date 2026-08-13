import { describe, expect, it } from 'vitest';

import { buildAggregateQuery } from '../../src/queries/aggregate.js';
import type { AggregateQueryFilters } from '../../src/schemas/aggregate-query.js';

const since = '2026-08-12T10:00:00.000Z';
const until = '2026-08-12T11:00:00.000Z';

function filters(
  overrides: Partial<AggregateQueryFilters> = {},
): AggregateQueryFilters {
  return {
    since,
    until,
    bucket: '1m',
    attributes: {},
    ...overrides,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('buildAggregateQuery', () => {
  it('builds a minimal aggregation query grouped and ordered by bucket', () => {
    const query = buildAggregateQuery(filters());
    const sql = normalizeSql(query.text);

    expect(sql).toContain('timestamp >= $1');
    expect(sql).toContain('timestamp < $2');
    expect(sql).toContain('GROUP BY bucket');
    expect(sql).toContain('ORDER BY bucket ASC');
  });

  it('uses an inclusive lower timestamp bound for since', () => {
    const query = buildAggregateQuery(filters());

    expect(normalizeSql(query.text)).toContain('timestamp >= $1');
  });

  it('uses an exclusive upper timestamp bound for until', () => {
    const query = buildAggregateQuery(filters());

    expect(normalizeSql(query.text)).toContain('timestamp < $2');
  });

  it('places since and until first in the values array', () => {
    const query = buildAggregateQuery(
      filters({ service: 'checkout', q: 'payment' }),
    );

    expect(query.values.slice(0, 2)).toEqual([since, until]);
  });

  it.each([
    ['1m', '1 minute'],
    ['5m', '5 minutes'],
    ['1h', '1 hour'],
    ['1d', '1 day'],
  ] as const)('uses a %s bucket as a %s interval', (bucket, interval) => {
    const sql = normalizeSql(buildAggregateQuery(filters({ bucket })).text);

    expect(sql).toContain(`date_bin('${interval}',timestamp,`);
  });

  it('parameterizes a service filter', () => {
    const service = 'checkout';
    const query = buildAggregateQuery(filters({ service }));

    expect(normalizeSql(query.text)).toContain('service = $3');
    expect(query.text).not.toContain(service);
    expect(query.values).toEqual([since, until, service]);
  });

  it('parameterizes a level filter', () => {
    const query = buildAggregateQuery(filters({ level: 'error' }));

    expect(normalizeSql(query.text)).toContain('level = $3');
    expect(query.values).toEqual([since, until, 'error']);
  });

  it('parameterizes both key and value for one attribute filter', () => {
    const query = buildAggregateQuery(
      filters({ attributes: { user_id: '42' } }),
    );

    expect(normalizeSql(query.text)).toContain('attributes ->> $3 = $4');
    expect(query.values).toEqual([since, until, 'user_id', '42']);
  });

  it('numbers multiple attribute-filter placeholders correctly', () => {
    const query = buildAggregateQuery(
      filters({
        attributes: {
          user_id: '42',
          region: 'eu-west',
        },
      }),
    );
    const sql = normalizeSql(query.text);

    expect(sql).toContain('attributes ->> $3 = $4');
    expect(sql).toContain('attributes ->> $5 = $6');
    expect(query.values).toEqual([
      since,
      until,
      'user_id',
      '42',
      'region',
      'eu-west',
    ]);
  });

  it('wraps and parameterizes the q filter for ILIKE', () => {
    const query = buildAggregateQuery(filters({ q: 'payment' }));

    expect(normalizeSql(query.text)).toContain('message ILIKE $3');
    expect(query.values).toEqual([since, until, '%payment%']);
  });

  it('omits group_value and groups only by bucket when group_by is omitted', () => {
    const sql = normalizeSql(buildAggregateQuery(filters()).text);

    expect(sql).not.toContain('group_value');
    expect(sql).toMatch(/GROUP BY bucket ORDER BY/);
  });

  it('selects and groups by service when group_by is service', () => {
    const sql = normalizeSql(
      buildAggregateQuery(filters({ group_by: 'service' })).text,
    );

    expect(sql).toContain('service AS group_value');
    expect(sql).toContain('GROUP BY bucket, service');
  });

  it('selects and groups by level when group_by is level', () => {
    const sql = normalizeSql(
      buildAggregateQuery(filters({ group_by: 'level' })).text,
    );

    expect(sql).toContain('level AS group_value');
    expect(sql).toContain('GROUP BY bucket, level');
  });

  it('numbers combined-filter placeholders sequentially in value order', () => {
    const query = buildAggregateQuery(
      filters({
        service: 'checkout',
        level: 'warn',
        attributes: {
          user_id: '42',
          region: 'eu-west',
        },
        q: 'payment',
      }),
    );
    const placeholders = [...query.text.matchAll(/\$(\d+)/g)].map(
      (match) => Number(match[1]),
    );

    expect(placeholders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(query.values).toEqual([
      since,
      until,
      'checkout',
      'warn',
      'user_id',
      '42',
      'region',
      'eu-west',
      '%payment%',
    ]);
  });

  it('keeps an injection-looking service value out of SQL text', () => {
    const service = "x' OR 1=1 --";
    const query = buildAggregateQuery(filters({ service }));

    expect(query.text).not.toContain(service);
    expect(normalizeSql(query.text)).toContain('service = $3');
    expect(query.values).toEqual([since, until, service]);
  });

  it('keeps injection-looking attribute keys and values parameterized', () => {
    const key = "user_id' OR '1'='1";
    const value = "42'; DROP TABLE logs; --";
    const query = buildAggregateQuery(
      filters({ attributes: { [key]: value } }),
    );

    expect(query.text).not.toContain(key);
    expect(query.text).not.toContain(value);
    expect(normalizeSql(query.text)).toContain('attributes ->> $3 = $4');
    expect(query.values).toEqual([since, until, key, value]);
  });

  it('keeps an injection-looking q value out of SQL text', () => {
    const q = "x%' OR 1=1 --";
    const query = buildAggregateQuery(filters({ q }));

    expect(query.text).not.toContain(q);
    expect(normalizeSql(query.text)).toContain('message ILIKE $3');
    expect(query.values).toEqual([since, until, `%${q}%`]);
  });

  it('selects a bigint count', () => {
    const sql = normalizeSql(buildAggregateQuery(filters()).text);

    expect(sql).toContain('COUNT(*)::BIGINT AS count');
  });

  it('selects the date_bin result as bucket', () => {
    const sql = normalizeSql(buildAggregateQuery(filters()).text);

    expect(sql).toMatch(
      /date_bin\('1 minute',\s*timestamp,\s*TIMESTAMPTZ '[^']+'\) AS bucket/,
    );
  });

  it('does not add a LIMIT clause', () => {
    const sql = normalizeSql(buildAggregateQuery(filters()).text);

    expect(sql).not.toMatch(/\bLIMIT\b/i);
  });

  it('does not add a cursor condition', () => {
    const sql = normalizeSql(buildAggregateQuery(filters()).text);

    expect(sql).not.toContain('(timestamp, id)');
    expect(sql).not.toMatch(/\bcursor\b/i);
  });
});
