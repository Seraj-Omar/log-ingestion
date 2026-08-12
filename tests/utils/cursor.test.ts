import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  type LogCursor,
} from '../../src/utils/cursor.js';

const timestamp = '2026-08-12T10:00:00.000Z';

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectInvalidCursor(value: string): void {
  expect(() => decodeCursor(value)).toThrow('invalid cursor');
}

describe('cursor utility', () => {
  it('encodes and decodes a cursor', () => {
    const cursor: LogCursor = { timestamp, id: '42' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('preserves a large bigint-like id as a string', () => {
    const cursor: LogCursor = {
      timestamp,
      id: '9223372036854775807',
    };

    const decoded = decodeCursor(encodeCursor(cursor));

    expect(decoded.id).toBe('9223372036854775807');
    expect(typeof decoded.id).toBe('string');
  });

  it.each([
    { timestamp: '2025-01-01T00:00:00.000Z', id: '1' },
    { timestamp: '2030-12-31T23:59:59.999Z', id: '999' },
  ] satisfies LogCursor[])('decodes the cursor %# independently', (cursor) => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('produces a URL-safe encoded value', () => {
    const encoded = encodeCursor({ timestamp, id: '9223372036854775807' });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('rejects a malformed non-decodable cursor', () => {
    expectInvalidCursor('%%%not-a-cursor%%%');
  });

  it('rejects Base64URL that decodes to non-JSON text', () => {
    const encoded = Buffer.from('plain text', 'utf8').toString('base64url');

    expectInvalidCursor(encoded);
  });

  it('rejects JSON null', () => {
    expectInvalidCursor(encodeRaw(null));
  });

  it('rejects a JSON array', () => {
    expectInvalidCursor(encodeRaw([timestamp, '42']));
  });

  it('rejects an object missing timestamp', () => {
    expectInvalidCursor(encodeRaw({ id: '42' }));
  });

  it('rejects an object missing id', () => {
    expectInvalidCursor(encodeRaw({ timestamp }));
  });

  it('rejects a timestamp with the wrong type', () => {
    expectInvalidCursor(encodeRaw({ timestamp: 1_786_528_800_000, id: '42' }));
  });

  it('rejects an invalid timestamp string', () => {
    expectInvalidCursor(encodeRaw({ timestamp: 'not-a-timestamp', id: '42' }));
  });

  it('rejects an id with the wrong type', () => {
    expectInvalidCursor(encodeRaw({ timestamp, id: 42 }));
  });

  it('rejects an empty id', () => {
    expectInvalidCursor(encodeRaw({ timestamp, id: '' }));
  });

  it('rejects a negative id string', () => {
    expectInvalidCursor(encodeRaw({ timestamp, id: '-1' }));
  });

  it('rejects a decimal id string', () => {
    expectInvalidCursor(encodeRaw({ timestamp, id: '10.5' }));
  });

  it('rejects a non-numeric id string', () => {
    expectInvalidCursor(encodeRaw({ timestamp, id: 'abc' }));
  });

  it('accepts zero as an id', () => {
    const cursor: LogCursor = { timestamp, id: '0' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('ignores extra decoded fields', () => {
    const encoded = encodeRaw({
      timestamp,
      id: '42',
      service: 'checkout',
    });

    expect(decodeCursor(encoded)).toEqual({ timestamp, id: '42' });
  });
});
