import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDailyPartition } from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import { dropExpiredPartitions } from '../../src/database/retention.js';
import { prepareDatabase } from '../../src/database/startup.js';

const referenceDate = new Date('2580-08-13T12:00:00.000Z');
const cutoffPartition = 'logs_2580_07_14';
const expiredPartitions = ['logs_2580_07_12', 'logs_2580_07_13'] as const;
const keptPartitions = [
  cutoffPartition,
  'logs_2580_07_15',
  'logs_2580_08_13',
  'logs_2580_08_14',
] as const;
const boundaryPartitions = [...expiredPartitions, ...keptPartitions] as const;
const customPartitions = ['logs_2581_08_10', 'logs_2581_08_11'] as const;
const startupPartition = 'logs_1987_01_02';
const ordinaryTable = 'logs_2580_07_11_retention_test';
const allTestRelations = [
  ...boundaryPartitions,
  ...customPartitions,
  startupPartition,
  ordinaryTable,
] as const;

async function dropTestRelations(): Promise<void> {
  for (const name of allTestRelations) {
    await pool.query(`DROP TABLE IF EXISTS "${name}"`);
  }
}

async function createBoundaryPartitions(): Promise<void> {
  for (const name of boundaryPartitions) {
    const [, year, month, day] = name.split('_');
    await ensureDailyPartition(
      new Date(`${year}-${month}-${day}T12:00:00.000Z`),
    );
  }
}

async function relationExists(name: string): Promise<boolean> {
  const result = await pool.query<{ relation: string | null }>(
    'SELECT to_regclass($1)::text AS relation',
    [`public.${name}`],
  );

  return result.rows[0]?.relation === name;
}

async function expectRelationsToExist(names: readonly string[]): Promise<void> {
  for (const name of names) {
    expect(await relationExists(name), name).toBe(true);
  }
}

async function expectRelationsToBeAbsent(names: readonly string[]): Promise<void> {
  for (const name of names) {
    expect(await relationExists(name), name).toBe(false);
  }
}

describe('dropExpiredPartitions', () => {
  beforeEach(async () => {
    await dropTestRelations();
    await createBoundaryPartitions();
  });

  afterEach(async () => {
    await dropTestRelations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('drops a partition older than the cutoff', async () => {
    await dropExpiredPartitions(30, referenceDate);

    expect(await relationExists(expiredPartitions[0])).toBe(false);
  });

  it('drops multiple expired partitions', async () => {
    await dropExpiredPartitions(30, referenceDate);

    await expectRelationsToBeAbsent(expiredPartitions);
  });

  it('keeps a partition exactly on the cutoff day', async () => {
    await dropExpiredPartitions(30, referenceDate);

    expect(await relationExists(cutoffPartition)).toBe(true);
  });

  it('keeps a partition newer than the cutoff', async () => {
    await dropExpiredPartitions(30, referenceDate);

    expect(await relationExists('logs_2580_07_15')).toBe(true);
  });

  it('keeps the partition for the reference day', async () => {
    await dropExpiredPartitions(30, referenceDate);

    expect(await relationExists('logs_2580_08_13')).toBe(true);
  });

  it('keeps a future partition', async () => {
    await dropExpiredPartitions(30, referenceDate);

    expect(await relationExists('logs_2580_08_14')).toBe(true);
  });

  it('returns the names of dropped partitions', async () => {
    const dropped = await dropExpiredPartitions(30, referenceDate);

    expect(dropped).toEqual(expect.arrayContaining([...expiredPartitions]));
  });

  it('does not return partitions on or after the cutoff', async () => {
    const dropped = await dropExpiredPartitions(30, referenceDate);

    for (const name of keptPartitions) {
      expect(dropped).not.toContain(name);
    }
  });

  it('is safe and idempotent when run twice', async () => {
    const firstDropped = await dropExpiredPartitions(30, referenceDate);
    const secondDropped = await dropExpiredPartitions(30, referenceDate);

    expect(firstDropped).toEqual(
      expect.arrayContaining([...expiredPartitions]),
    );
    expect(secondDropped).toEqual([]);
    await expectRelationsToExist(keptPartitions);
  });

  it('honors a custom retention period with the same strict boundary', async () => {
    await ensureDailyPartition(new Date('2581-08-10T12:00:00.000Z'));
    await ensureDailyPartition(new Date('2581-08-11T12:00:00.000Z'));

    const dropped = await dropExpiredPartitions(
      2,
      new Date('2581-08-13T18:00:00.000Z'),
    );

    expect(dropped).toContain('logs_2581_08_10');
    expect(dropped).not.toContain('logs_2581_08_11');
    expect(await relationExists('logs_2581_08_10')).toBe(false);
    expect(await relationExists('logs_2581_08_11')).toBe(true);
  });

  it('considers only child partitions of logs', async () => {
    await pool.query(`CREATE TABLE "${ordinaryTable}" (id integer)`);

    const dropped = await dropExpiredPartitions(30, referenceDate);

    expect(dropped).not.toContain(ordinaryTable);
    expect(await relationExists(ordinaryTable)).toBe(true);
  });

  it('prepareDatabase completes only after retention cleanup has run', async () => {
    await ensureDailyPartition(new Date('1987-01-02T12:00:00.000Z'));
    expect(await relationExists(startupPartition)).toBe(true);

    await expect(prepareDatabase()).resolves.toBeUndefined();

    expect(await relationExists(startupPartition)).toBe(false);
  });
});
