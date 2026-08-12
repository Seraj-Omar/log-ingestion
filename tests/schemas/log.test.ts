import { describe, expect, it } from 'vitest';

import { logSchema } from '../../src/schemas/log.js';

const validLog = {
  timestamp: '2026-08-12T10:00:00.000Z',
  level: 'info',
  service: 'billing-api',
  message: 'Payment processed',
};

describe('logSchema', () => {
  it('accepts a valid log with all fields', () => {
    const result = logSchema.safeParse({
      ...validLog,
      attributes: {
        requestId: 'req-123',
        durationMs: 42,
        cached: false,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ...validLog,
        attributes: {
          requestId: 'req-123',
          durationMs: 42,
          cached: false,
        },
      });
    }
  });

  it('accepts a valid log without attributes and supplies the default', () => {
    const result = logSchema.safeParse(validLog);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attributes).toEqual({});
    }
  });

  it('accepts a string attribute', () => {
    expect(
      logSchema.safeParse({
        ...validLog,
        attributes: { requestId: 'req-123' },
      }).success,
    ).toBe(true);
  });

  it('accepts a number attribute', () => {
    expect(
      logSchema.safeParse({
        ...validLog,
        attributes: { durationMs: 42 },
      }).success,
    ).toBe(true);
  });

  it('accepts a boolean attribute', () => {
    expect(
      logSchema.safeParse({
        ...validLog,
        attributes: { cached: false },
      }).success,
    ).toBe(true);
  });

  it('rejects a nested object attribute', () => {
    const result = logSchema.safeParse({
      ...validLog,
      attributes: { context: { requestId: 'req-123' } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an array attribute', () => {
    const result = logSchema.safeParse({
      ...validLog,
      attributes: { tags: ['payments', 'production'] },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid level', () => {
    const result = logSchema.safeParse({
      ...validLog,
      level: 'critical',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty service', () => {
    const result = logSchema.safeParse({ ...validLog, service: '' });

    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only service', () => {
    const result = logSchema.safeParse({ ...validLog, service: '   ' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = logSchema.safeParse({ ...validLog, message: '' });

    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only message', () => {
    const result = logSchema.safeParse({ ...validLog, message: '\t  ' });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed timestamp', () => {
    const result = logSchema.safeParse({
      ...validLog,
      timestamp: 'not-a-timestamp',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    const { timestamp: _timestamp, ...logWithoutTimestamp } = validLog;
    const result = logSchema.safeParse(logWithoutTimestamp);

    expect(result.success).toBe(false);
  });

  it('rejects unexpected fields', () => {
    const result = logSchema.safeParse({
      ...validLog,
      hostname: 'worker-01',
    });

    expect(result.success).toBe(false);
  });
});
