import { describe, expect, it } from 'vitest';

import { parseLogQuery } from '../../src/schemas/log-query.js';

describe('parseLogQuery', () => {
  it('applies defaults to an empty query', () => {
    expect(parseLogQuery({})).toEqual({
      limit: 100,
      attributes: {},
    });
  });

  it('accepts a service filter', () => {
    expect(parseLogQuery({ service: 'checkout' })).toEqual({
      service: 'checkout',
      limit: 100,
      attributes: {},
    });
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'accepts the %s level',
    (level) => {
      expect(parseLogQuery({ level })).toMatchObject({ level });
    },
  );

  it('rejects an invalid level with a useful error', () => {
    expect(() => parseLogQuery({ level: 'critical' })).toThrow(
      'invalid level filter',
    );
  });

  it('accepts a valid since timestamp', () => {
    const since = '2026-08-12T10:00:00.000Z';

    expect(parseLogQuery({ since })).toMatchObject({ since });
  });

  it('rejects an invalid since timestamp with a useful error', () => {
    expect(() => parseLogQuery({ since: 'not-a-timestamp' })).toThrow(
      'invalid since timestamp',
    );
  });

  it('accepts a valid until timestamp', () => {
    const until = '2026-08-12T11:00:00.000Z';

    expect(parseLogQuery({ until })).toMatchObject({ until });
  });

  it('rejects an invalid until timestamp with a useful error', () => {
    expect(() => parseLogQuery({ until: 'not-a-timestamp' })).toThrow(
      'invalid until timestamp',
    );
  });

  it('accepts until strictly greater than since', () => {
    const since = '2026-08-12T10:00:00.000Z';
    const until = '2026-08-12T10:00:00.001Z';

    expect(parseLogQuery({ since, until })).toMatchObject({ since, until });
  });

  it('rejects until equal to since', () => {
    const timestamp = '2026-08-12T10:00:00.000Z';

    expect(() =>
      parseLogQuery({ since: timestamp, until: timestamp }),
    ).toThrow("'until' must be greater than 'since'");
  });

  it('rejects until earlier than since', () => {
    expect(() =>
      parseLogQuery({
        since: '2026-08-12T10:00:00.001Z',
        until: '2026-08-12T10:00:00.000Z',
      }),
    ).toThrow("'until' must be greater than 'since'");
  });

  it('accepts the minimum limit of 1', () => {
    expect(parseLogQuery({ limit: 1 }).limit).toBe(1);
  });

  it('accepts the maximum limit of 1000', () => {
    expect(parseLogQuery({ limit: 1000 }).limit).toBe(1000);
  });

  it('coerces a numeric-string limit', () => {
    expect(parseLogQuery({ limit: '500' }).limit).toBe(500);
  });

  it('rejects a limit below the minimum', () => {
    expect(() => parseLogQuery({ limit: 0 })).toThrow(
      'limit must be at least 1',
    );
  });

  it('rejects a limit above the maximum', () => {
    expect(() => parseLogQuery({ limit: 1001 })).toThrow(
      'limit must not exceed 1000',
    );
  });

  it('rejects a non-numeric limit', () => {
    expect(() => parseLogQuery({ limit: 'abc' })).toThrow('invalid limit');
  });

  it('rejects a decimal limit', () => {
    expect(() => parseLogQuery({ limit: '10.5' })).toThrow('invalid limit');
  });

  it('accepts a text-search query', () => {
    expect(parseLogQuery({ q: 'payment accepted' })).toMatchObject({
      q: 'payment accepted',
    });
  });

  it('accepts a non-empty cursor', () => {
    expect(parseLogQuery({ cursor: 'cursor-token' })).toMatchObject({
      cursor: 'cursor-token',
    });
  });

  it('rejects an empty cursor', () => {
    expect(() => parseLogQuery({ cursor: '' })).toThrow('invalid cursor');
  });

  it('extracts one attribute filter', () => {
    expect(parseLogQuery({ 'attr.user_id': '42' })).toEqual({
      limit: 100,
      attributes: { user_id: '42' },
    });
  });

  it('extracts multiple attribute filters', () => {
    expect(
      parseLogQuery({
        'attr.user_id': '42',
        'attr.region': 'eu-west',
      }),
    ).toEqual({
      limit: 100,
      attributes: {
        user_id: '42',
        region: 'eu-west',
      },
    });
  });

  it('rejects an empty attribute key', () => {
    expect(() => parseLogQuery({ 'attr.': '42' })).toThrow(
      "invalid attribute filter: 'attr.'",
    );
  });

  it('rejects a non-string attribute value', () => {
    expect(() => parseLogQuery({ 'attr.user_id': 42 })).toThrow(
      "invalid attribute filter: 'attr.user_id'",
    );
  });

  it('parses all supported filters together', () => {
    expect(
      parseLogQuery({
        service: 'checkout',
        level: 'warn',
        since: '2026-08-12T10:00:00.000Z',
        until: '2026-08-12T11:00:00.000Z',
        q: 'payment',
        limit: '500',
        cursor: 'cursor-token',
        'attr.user_id': '42',
        'attr.region': 'eu-west',
      }),
    ).toEqual({
      service: 'checkout',
      level: 'warn',
      since: '2026-08-12T10:00:00.000Z',
      until: '2026-08-12T11:00:00.000Z',
      q: 'payment',
      limit: 500,
      cursor: 'cursor-token',
      attributes: {
        user_id: '42',
        region: 'eu-west',
      },
    });
  });

  it('strips an unknown non-attribute query parameter', () => {
    expect(parseLogQuery({ unsupported: 'value' })).toEqual({
      limit: 100,
      attributes: {},
    });
  });

  it('rejects a repeated level represented as an array', () => {
    expect(() => parseLogQuery({ level: ['info', 'error'] })).toThrow(
      'invalid level filter',
    );
  });

  it('rejects a repeated service represented as an array', () => {
    expect(() => parseLogQuery({ service: ['checkout', 'billing'] })).toThrow();
  });

  it('rejects a repeated cursor represented as an array', () => {
    expect(() => parseLogQuery({ cursor: ['first', 'second'] })).toThrow();
  });
});
