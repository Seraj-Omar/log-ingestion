import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseEnvironmentKeys = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
] as const;

const originalEnvironment = new Map(
  databaseEnvironmentKeys.map((key) => [key, process.env[key]]),
);

function clearDatabaseEnvironment(): void {
  for (const key of databaseEnvironmentKeys) {
    delete process.env[key];
  }
}

describe('databaseConfig', () => {
  beforeEach(() => {
    clearDatabaseEnvironment();
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of databaseEnvironmentKeys) {
      const originalValue = originalEnvironment.get(key);

      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }

    vi.resetModules();
  });

  it('uses PostgreSQL development defaults when environment variables are absent', async () => {
    const { databaseConfig } = await import('../../src/config/database.js');

    expect(databaseConfig).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'logs',
      user: 'postgres',
      password: 'postgres',
    });
  });

  it('uses environment overrides and parses the port as a number', async () => {
    process.env.DB_HOST = 'database.internal';
    process.env.DB_PORT = '6543';
    process.env.DB_NAME = 'test_logs';
    process.env.DB_USER = 'test_user';
    process.env.DB_PASSWORD = 'test_password';

    const { databaseConfig } = await import('../../src/config/database.js');

    expect(databaseConfig).toEqual({
      host: 'database.internal',
      port: 6543,
      database: 'test_logs',
      user: 'test_user',
      password: 'test_password',
    });
    expect(typeof databaseConfig.port).toBe('number');
  });
});
