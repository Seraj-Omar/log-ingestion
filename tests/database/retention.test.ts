import { describe, expect, it } from 'vitest';

import {
  retentionCutOff,
  retentionDaysFromEnvironment,
} from '../../src/database/retention.js';

describe('retentionCutOff', () => {
  it('normalizes the reference date to the start of its UTC day', () => {
    const cutoff = retentionCutOff(
      new Date('2026-08-13T15:30:00.000Z'),
      0,
    );

    expect(cutoff.toISOString()).toBe('2026-08-13T00:00:00.000Z');
  });

  it('defaults to a 30-day retention period', () => {
    const cutoff = retentionCutOff(
      new Date('2026-08-13T15:30:00.000Z'),
    );

    expect(cutoff.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('supports a custom retention period', () => {
    const cutoff = retentionCutOff(
      new Date('2026-08-13T15:30:00.000Z'),
      7,
    );

    expect(cutoff.toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });

  it('calculates across a month boundary', () => {
    const cutoff = retentionCutOff(
      new Date('2026-03-05T23:59:59.999Z'),
      10,
    );

    expect(cutoff.toISOString()).toBe('2026-02-23T00:00:00.000Z');
  });

  it('calculates across a year boundary', () => {
    const cutoff = retentionCutOff(
      new Date('2026-01-10T08:00:00.000Z'),
      30,
    );

    expect(cutoff.toISOString()).toBe('2025-12-11T00:00:00.000Z');
  });

  it('includes leap day in UTC date arithmetic', () => {
    const cutoff = retentionCutOff(
      new Date('2024-03-01T20:00:00.000Z'),
      1,
    );

    expect(cutoff.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });
});

describe('retentionDaysFromEnvironment', () => {
  it('defaults to 30 days when RETENTION_DAYS is omitted', () => {
    expect(retentionDaysFromEnvironment(undefined)).toBe(30);
  });

  it('uses a configured non-negative integer', () => {
    expect(retentionDaysFromEnvironment('45')).toBe(45);
  });

  it.each(['-1', '1.5', 'not-a-number'])(
    'rejects invalid RETENTION_DAYS=%s',
    (value) => {
      expect(() => retentionDaysFromEnvironment(value)).toThrow(
        'RETENTION_DAYS must be a non-negative integer',
      );
    },
  );
});
