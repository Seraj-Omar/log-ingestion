import { describe, expect, it } from 'vitest';

import { maxInFlightIngestionsFromEnvironment } from '../../src/config/ingestion.js';

describe('maxInFlightIngestionsFromEnvironment', () => {
  it('defaults to five in-flight ingestion requests', () => {
    const configuredValue = process.env.MAX_IN_FLIGHT_INGESTIONS;
    delete process.env.MAX_IN_FLIGHT_INGESTIONS;

    try {
      expect(maxInFlightIngestionsFromEnvironment()).toBe(5);
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
