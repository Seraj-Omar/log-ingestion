import { describe, expect, it } from 'vitest';

import {
  ingestionConfigFromEnvironment,
  maxInFlightIngestionsFromEnvironment,
} from '../../src/config/ingestion.js';

describe('maxInFlightIngestionsFromEnvironment', () => {
  it('defaults to 2,048 in-flight ingestion requests', () => {
    const configuredValue = process.env.MAX_IN_FLIGHT_INGESTIONS;
    delete process.env.MAX_IN_FLIGHT_INGESTIONS;

    try {
      expect(maxInFlightIngestionsFromEnvironment()).toBe(2_048);
    } finally {
      if (configuredValue === undefined) {
        delete process.env.MAX_IN_FLIGHT_INGESTIONS;
      } else {
        process.env.MAX_IN_FLIGHT_INGESTIONS = configuredValue;
      }
    }
  });

  it('accepts a configured positive integer', () => {
    expect(maxInFlightIngestionsFromEnvironment('8')).toBe(8);
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid MAX_IN_FLIGHT_INGESTIONS=%s',
    (value) => {
      expect(() => maxInFlightIngestionsFromEnvironment(value)).toThrow(
        'MAX_IN_FLIGHT_INGESTIONS must be a positive integer',
      );
    },
  );
});

describe('ingestionConfigFromEnvironment', () => {
  it('returns measured defaults when ingestion settings are absent', () => {
    expect(ingestionConfigFromEnvironment({})).toEqual({
      maxInFlightIngestions: 2_048,
      maxInFlightLogs: 50_000,
      maxInFlightBytes: 64 * 1024 * 1024,
      batchSize: 2000,
      batchDelayMs: 10,
    });
  });

  it('accepts configured ingestion limits and batching settings', () => {
    expect(
      ingestionConfigFromEnvironment({
        MAX_IN_FLIGHT_INGESTIONS: '100',
        MAX_IN_FLIGHT_INGESTION_LOGS: '25000',
        MAX_IN_FLIGHT_INGESTION_BYTES: '33554432',
        INGESTION_BATCH_SIZE: '250',
        INGESTION_BATCH_DELAY_MS: '0',
      }),
    ).toEqual({
      maxInFlightIngestions: 100,
      maxInFlightLogs: 25_000,
      maxInFlightBytes: 33_554_432,
      batchSize: 250,
      batchDelayMs: 0,
    });
  });

  it.each([
    ['MAX_IN_FLIGHT_INGESTIONS', '0', 'positive'],
    ['MAX_IN_FLIGHT_INGESTION_LOGS', '-1', 'positive'],
    ['MAX_IN_FLIGHT_INGESTION_BYTES', '1.5', 'positive'],
    ['INGESTION_BATCH_SIZE', 'not-a-number', 'positive'],
    ['INGESTION_BATCH_DELAY_MS', '-1', 'non-negative'],
    ['INGESTION_BATCH_DELAY_MS', '1.5', 'non-negative'],
  ] as const)(
    'rejects invalid %s=%s',
    (name, value, requirement) => {
      expect(() =>
        ingestionConfigFromEnvironment({ [name]: value }),
      ).toThrow(`${name} must be a ${requirement} integer`);
    },
  );
});
