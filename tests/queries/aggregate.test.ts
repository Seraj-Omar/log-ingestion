import { describe, expect, it } from 'vitest';

import {
  buildAggregateQuery,
  buildRollupAggregateQuery,
} from '../../src/queries/aggregate.js';
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

describe('buildRollupAggregateQuery adaptive edges', () => {
  it('uses a rollup minus the smaller raw prefix for an early first-minute boundary', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:10.000Z',
          until:
            '2026-08-12T10:03:00.000Z',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).toContain(
      'FROM log_rollups_1m',
    );

    expect(sql).toContain(
      '(-COUNT(*))::BIGINT AS count',
    );

    expect(query.values).toEqual([
      '2026-08-12T10:00:00.000Z',
      '2026-08-12T10:01:00.000Z',

      '2026-08-12T10:00:00.000Z',
      '2026-08-12T10:00:10.000Z',

      '2026-08-12T10:01:00.000Z',
      '2026-08-12T10:03:00.000Z',
    ]);
  });

  it('uses direct raw scanning for the first edge when the desired side is smaller', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:40.000Z',
          until:
            '2026-08-12T10:03:00.000Z',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).not.toContain(
      '(-COUNT(*))::BIGINT AS count',
    );

    expect(query.values).toEqual([
      '2026-08-12T10:00:40.000Z',
      '2026-08-12T10:01:00.000Z',

      '2026-08-12T10:01:00.000Z',
      '2026-08-12T10:03:00.000Z',
    ]);
  });

  it('uses direct raw scanning for an early last-minute boundary', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:00.000Z',
          until:
            '2026-08-12T10:03:20.000Z',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).not.toContain(
      '(-COUNT(*))::BIGINT AS count',
    );

    expect(query.values).toEqual([
      '2026-08-12T10:00:00.000Z',
      '2026-08-12T10:03:00.000Z',

      '2026-08-12T10:03:00.000Z',
      '2026-08-12T10:03:20.000Z',
    ]);
  });

  it('uses a rollup minus the smaller raw suffix for a late last-minute boundary', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:00.000Z',
          until:
            '2026-08-12T10:03:50.000Z',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).toContain(
      '(-COUNT(*))::BIGINT AS count',
    );

    expect(query.values).toEqual([
      '2026-08-12T10:00:00.000Z',
      '2026-08-12T10:03:00.000Z',

      '2026-08-12T10:03:00.000Z',
      '2026-08-12T10:04:00.000Z',

      '2026-08-12T10:03:50.000Z',
      '2026-08-12T10:04:00.000Z',
    ]);
  });

  it('keeps sub-minute intervals on the raw path', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:20.000Z',
          until:
            '2026-08-12T10:00:50.000Z',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).toContain(
      'FROM logs',
    );

    expect(sql).not.toContain(
      'FROM log_rollups_1m',
    );

    expect(sql).not.toContain(
      '(-COUNT(*))::BIGINT AS count',
    );

    expect(query.values).toEqual([
      '2026-08-12T10:00:20.000Z',
      '2026-08-12T10:00:50.000Z',
    ]);
  });

  it('removes zero-count buckets created by complement subtraction', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:00.000Z',
          until:
            '2026-08-12T10:03:50.000Z',
        }),
      );

    expect(
      normalizeSql(query.text),
    ).toContain(
      'HAVING SUM(count) > 0',
    );
  });

  it('keeps service filters on both rollup and subtraction parts', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:00.000Z',
          until:
            '2026-08-12T10:03:50.000Z',
          service:
            'checkout',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(
      sql.match(
        /service = \$\d+/g,
      )?.length,
    ).toBe(3);

    expect(
      query.text,
    ).not.toContain(
      'checkout',
    );

    expect(
      query.values.filter(
        (value) =>
          value === 'checkout',
      ),
    ).toHaveLength(3);
  });

  it('keeps grouped complement queries grouped by the requested dimension', () => {
    const query =
      buildRollupAggregateQuery(
        filters({
          since:
            '2026-08-12T10:00:00.000Z',
          until:
            '2026-08-12T10:03:50.000Z',
          group_by:
            'service',
        }),
      );

    const sql =
      normalizeSql(query.text);

    expect(sql).toContain(
      'service AS group_value',
    );

    expect(sql).toContain(
      'GROUP BY bucket, group_value',
    );

    expect(sql).toContain(
      'HAVING SUM(count) > 0',
    );
  });
});

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

  it('escapes LIKE metacharacters so q remains a literal substring', () => {
    const query = buildAggregateQuery(filters({ q: String.raw`50%_\\done` }));

    expect(query.text).toContain("message ILIKE $3 ESCAPE '\\'");
    expect(query.values).toEqual([
      since,
      until,
      String.raw`%50\%\_\\\\done%`,
    ]);
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
    expect(query.values).toEqual([since, until, "%x\\%' OR 1=1 --%"]);
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
