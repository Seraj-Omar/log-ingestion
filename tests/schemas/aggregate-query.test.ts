import { describe, expect, it } from 'vitest';

import { parseAggregateQuery } from '../../src/schemas/aggregate-query.js';

const since = '2026-08-12T10:00:00.000Z';
const until = '2026-08-12T11:00:00.000Z';

const minimalQuery = {
  since,
  until,
  bucket: '1m',
};

describe('parseAggregateQuery', () => {
  it('accepts a valid minimal query', () => {
    expect(parseAggregateQuery(minimalQuery)).toEqual({
      ...minimalQuery,
      attributes: {},
    });
  });

  it('rejects a missing since timestamp', () => {
    expect(() => parseAggregateQuery({ until, bucket: '1m' })).toThrow();
  });

  it('rejects a missing until timestamp', () => {
    expect(() => parseAggregateQuery({ since, bucket: '1m' })).toThrow();
  });

  it('rejects a missing bucket', () => {
    expect(() => parseAggregateQuery({ since, until })).toThrow(
      'unsupported bucket',
    );
  });

  it.each(['1m', '5m', '1h', '1d'] as const)(
    'accepts the %s bucket',
    (bucket) => {
      expect(parseAggregateQuery({ since, until, bucket })).toMatchObject({
        bucket,
      });
    },
  );

  it('rejects an unsupported bucket', () => {
    expect(() =>
      parseAggregateQuery({ since, until, bucket: '10m' }),
    ).toThrow('unsupported bucket');
  });

  it.each(['service', 'level'] as const)(
    'accepts the %s group_by value',
    (group_by) => {
      expect(
        parseAggregateQuery({ ...minimalQuery, group_by }),
      ).toMatchObject({ group_by });
    },
  );

  it('rejects an unsupported group_by value', () => {
    expect(() =>
      parseAggregateQuery({ ...minimalQuery, group_by: 'message' }),
    ).toThrow('unsupported group_by');
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'accepts the %s level filter',
    (level) => {
      expect(parseAggregateQuery({ ...minimalQuery, level })).toMatchObject({
        level,
      });
    },
  );

  it('rejects an invalid level filter', () => {
    expect(() =>
      parseAggregateQuery({ ...minimalQuery, level: 'critical' }),
    ).toThrow('invalid level filter');
  });

  it('accepts until strictly greater than since', () => {
    expect(
      parseAggregateQuery({
        since: '2026-08-12T10:00:00.000Z',
        until: '2026-08-12T10:00:00.001Z',
        bucket: '1m',
      }),
    ).toMatchObject({
      since: '2026-08-12T10:00:00.000Z',
      until: '2026-08-12T10:00:00.001Z',
    });
  });

  it('rejects until equal to since', () => {
    expect(() =>
      parseAggregateQuery({ since, until: since, bucket: '1m' }),
    ).toThrow("'until' must be greater than 'since'");
  });

  it('rejects until earlier than since', () => {
    expect(() =>
      parseAggregateQuery({ since: until, until: since, bucket: '1m' }),
    ).toThrow("'until' must be greater than 'since'");
  });

  it('accepts a service filter', () => {
    expect(
      parseAggregateQuery({ ...minimalQuery, service: 'checkout' }),
    ).toMatchObject({ service: 'checkout' });
  });

  it('accepts a text-search query', () => {
    expect(
      parseAggregateQuery({ ...minimalQuery, q: 'payment accepted' }),
    ).toMatchObject({ q: 'payment accepted' });
  });

  it('extracts one attribute filter', () => {
    expect(
      parseAggregateQuery({ ...minimalQuery, 'attr.user_id': '42' }),
    ).toEqual({
      ...minimalQuery,
      attributes: { user_id: '42' },
    });
  });

  it('preserves multiple attribute filters', () => {
    expect(
      parseAggregateQuery({
        ...minimalQuery,
        'attr.user_id': '42',
        'attr.region': 'eu-west',
      }),
    ).toEqual({
      ...minimalQuery,
      attributes: {
        user_id: '42',
        region: 'eu-west',
      },
    });
  });

  it('rejects an empty attribute key', () => {
    expect(() =>
      parseAggregateQuery({ ...minimalQuery, 'attr.': '42' }),
    ).toThrow("invalid attribute filter: 'attr.'");
  });

  it('rejects a non-string attribute value', () => {
    expect(() =>
      parseAggregateQuery({ ...minimalQuery, 'attr.user_id': 42 }),
    ).toThrow("invalid attribute filter: 'attr.user_id'");
  });

  it('parses all supported aggregation filters together', () => {
    expect(
      parseAggregateQuery({
        since,
        until,
        bucket: '5m',
        group_by: 'service',
        service: 'checkout',
        level: 'warn',
        q: 'payment',
        'attr.user_id': '42',
        'attr.region': 'eu-west',
      }),
    ).toEqual({
      since,
      until,
      bucket: '5m',
      group_by: 'service',
      service: 'checkout',
      level: 'warn',
      q: 'payment',
      attributes: {
        user_id: '42',
        region: 'eu-west',
      },
    });
  });

  it('defaults attributes to an empty object', () => {
    expect(parseAggregateQuery(minimalQuery).attributes).toEqual({});
  });

  it('leaves group_by undefined when omitted', () => {
    expect(parseAggregateQuery(minimalQuery).group_by).toBeUndefined();
  });

  it.each([
    ['since', ['2026-08-12T10:00:00.000Z', '2026-08-12T10:30:00.000Z']],
    ['until', ['2026-08-12T11:00:00.000Z', '2026-08-12T11:30:00.000Z']],
    ['bucket', ['1m', '5m']],
    ['group_by', ['service', 'level']],
    ['service', ['checkout', 'billing']],
    ['level', ['info', 'error']],
    ['q', ['payment', 'refund']],
  ])('rejects an array-shaped %s parameter', (key, value) => {
    expect(() =>
      parseAggregateQuery({ ...minimalQuery, [key]: value }),
    ).toThrow();
  });

  it('strips an unknown non-attribute query parameter', () => {
    expect(
      parseAggregateQuery({ ...minimalQuery, unsupported: 'value' }),
    ).toEqual({
      ...minimalQuery,
      attributes: {},
    });
  });
});
