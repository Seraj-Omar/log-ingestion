import { describe, expect, it } from 'vitest';

import {
  validateBatchEnvelope,
  validateLogBatch,
} from '../../src/services/validate-log-batch.js';

const now = new Date('2026-08-12T10:00:00.000Z');

function validRawLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-12T09:59:00.000Z',
    level: 'info',
    service: 'billing-api',
    message: 'Payment processed',
    attributes: { requestId: 'req-123' },
    ...overrides,
  };
}

describe('validateBatchEnvelope', () => {
  it('accepts a valid logs envelope', () => {
    const logs = [validRawLog()];

    expect(validateBatchEnvelope({ logs })).toEqual({
      success: true,
      logs,
    });
  });

  it('rejects a body missing logs', () => {
    expect(validateBatchEnvelope({})).toEqual({
      success: false,
      error: 'logs must be a non-empty array',
    });
  });

  it('rejects logs that is not an array', () => {
    expect(validateBatchEnvelope({ logs: 'not-an-array' })).toEqual({
      success: false,
      error: 'logs must be a non-empty array',
    });
  });

  it('rejects an empty logs array', () => {
    expect(validateBatchEnvelope({ logs: [] })).toEqual({
      success: false,
      error: 'logs array must not be empty',
    });
  });

  it('rejects null as an invalid request body', () => {
    expect(validateBatchEnvelope(null)).toEqual({
      success: false,
      error: 'invalid request body',
    });
  });

  it('rejects unexpected top-level fields', () => {
    expect(
      validateBatchEnvelope({ logs: [validRawLog()], source: 'external' }),
    ).toEqual({
      success: false,
      error: 'invalid request body',
    });
  });
});

describe('validateLogBatch', () => {
  it('accepts a completely valid batch', () => {
    const first = validRawLog();
    const second = validRawLog({
      level: 'error',
      service: 'checkout-api',
      message: 'Checkout failed',
    });

    const result = validateLogBatch([first, second], now);

    expect(result.rejected).toEqual([]);
    expect(result.valid).toEqual([first, second]);
  });

  it('accepts a timestamp exactly at the current time', () => {
    const log = validRawLog({ timestamp: '2026-08-12T10:00:00.000Z' });

    expect(validateLogBatch([log], now)).toEqual({
      valid: [log],
      rejected: [],
    });
  });

  it('accepts a timestamp less than five minutes in the future', () => {
    const log = validRawLog({ timestamp: '2026-08-12T10:04:59.999Z' });

    expect(validateLogBatch([log], now)).toEqual({
      valid: [log],
      rejected: [],
    });
  });

  it('accepts a timestamp exactly five minutes in the future', () => {
    const log = validRawLog({ timestamp: '2026-08-12T10:05:00.000Z' });

    expect(validateLogBatch([log], now)).toEqual({
      valid: [log],
      rejected: [],
    });
  });

  it('rejects a timestamp more than five minutes in the future', () => {
    const log = validRawLog({ timestamp: '2026-08-12T10:05:00.001Z' });

    expect(validateLogBatch([log], now)).toEqual({
      valid: [],
      rejected: [
        {
          index: 0,
          reason: 'timestamp is more than 5 minutes in the future',
        },
      ],
    });
  });

  it('rejects an invalid timestamp', () => {
    const result = validateLogBatch(
      [validRawLog({ timestamp: 'not-a-timestamp' })],
      now,
    );

    expect(result).toEqual({
      valid: [],
      rejected: [{ index: 0, reason: 'invalid timestamp' }],
    });
  });

  it('returns a useful reason for an invalid level', () => {
    const result = validateLogBatch(
      [validRawLog({ level: 'critical' })],
      now,
    );

    expect(result).toEqual({
      valid: [],
      rejected: [{ index: 0, reason: "invalid level: 'critical'" }],
    });
  });

  it('rejects an empty service', () => {
    const result = validateLogBatch([validRawLog({ service: '' })], now);

    expect(result.rejected).toEqual([
      { index: 0, reason: 'service must be a non-empty string' },
    ]);
  });

  it('rejects an empty message', () => {
    const result = validateLogBatch([validRawLog({ message: '' })], now);

    expect(result.rejected).toEqual([
      { index: 0, reason: 'message must be a non-empty string' },
    ]);
  });

  it('rejects nested attributes', () => {
    const result = validateLogBatch(
      [validRawLog({ attributes: { context: { requestId: 'req-123' } } })],
      now,
    );

    expect(result.rejected).toEqual([
      {
        index: 0,
        reason: 'attributes must be a flat object with string, number, or boolean values',
      },
    ]);
  });

  it('rejects array attributes', () => {
    const result = validateLogBatch(
      [validRawLog({ attributes: { tags: ['payments'] } })],
      now,
    );

    expect(result.rejected).toEqual([
      {
        index: 0,
        reason: 'attributes must be a flat object with string, number, or boolean values',
      },
    ]);
  });

  it('keeps valid entries and reports invalid entries at their original indexes', () => {
    const firstValid = validRawLog({ message: 'First valid log' });
    const invalidLevel = validRawLog({ level: 'critical' });
    const secondValid = validRawLog({ message: 'Second valid log' });
    const futureLog = validRawLog({
      timestamp: '2026-08-12T10:05:00.001Z',
    });

    const result = validateLogBatch(
      [firstValid, invalidLevel, secondValid, futureLog],
      now,
    );

    expect(result.valid).toEqual([firstValid, secondValid]);
    expect(result.rejected).toEqual([
      { index: 1, reason: "invalid level: 'critical'" },
      {
        index: 3,
        reason: 'timestamp is more than 5 minutes in the future',
      },
    ]);
  });

  it('reports every entry in an entirely invalid batch', () => {
    const result = validateLogBatch(
      [
        validRawLog({ timestamp: 'invalid' }),
        validRawLog({ service: '   ' }),
        validRawLog({ attributes: { nested: { value: true } } }),
      ],
      now,
    );

    expect(result.valid).toEqual([]);
    expect(result.rejected).toEqual([
      { index: 0, reason: 'invalid timestamp' },
      { index: 1, reason: 'service must be a non-empty string' },
      {
        index: 2,
        reason: 'attributes must be a flat object with string, number, or boolean values',
      },
    ]);
  });

  it('normalizes omitted attributes to an empty object', () => {
    const log = validRawLog();
    delete log.attributes;

    const result = validateLogBatch([log], now);

    expect(result.rejected).toEqual([]);
    expect(result.valid).toEqual([{ ...log, attributes: {} }]);
  });
});
