import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  ensureDailyPartition,
  forgetKnownPartition,
} from '../../src/database/partitions.js';
import { pool } from '../../src/database/pool.js';
import { dropExpiredPartitions } from '../../src/database/retention.js';
import { prepareDatabase } from '../../src/database/startup.js';

const referenceDate = new Date(
  '1980-08-13T12:00:00.000Z',
);

const cutoffPartition =
  'logs_1980_07_14';

const expiredPartitions = [
  'logs_1980_07_12',
  'logs_1980_07_13',
] as const;

const keptPartitions = [
  cutoffPartition,
  'logs_1980_07_15',
  'logs_1980_08_13',
  'logs_1980_08_14',
] as const;

const boundaryPartitions = [
  ...expiredPartitions,
  ...keptPartitions,
] as const;

const customPartitions = [
  'logs_1981_08_10',
  'logs_1981_08_11',
] as const;

const startupPartition =
  'logs_1971_01_02';

const ordinaryTable =
  'logs_1980_07_11_retention_test';

const retentionRollupService =
  'retention-rollup-integration';

const dependentView =
  'retention_partition_dependency';

const allTestRelations = [
  ...boundaryPartitions,
  ...customPartitions,
  startupPartition,
  ordinaryTable,
] as const;

async function deleteTestRollups(): Promise<void> {
  await pool.query(
    `
      DELETE FROM log_rollups_1m
      WHERE service = $1
    `,
    [retentionRollupService],
  );
}

async function insertTestRollup(
  bucketStart: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO log_rollups_1m (
        bucket_start,
        service,
        level,
        count
      )
      VALUES ($1, $2, 'info', 1)
    `,
    [
      bucketStart,
      retentionRollupService,
    ],
  );
}

async function rollupExists(
  bucketStart: string,
): Promise<boolean> {
  const result = await pool.query<{
    count: string;
  }>(
    `
      SELECT COUNT(*)::BIGINT AS count
      FROM log_rollups_1m
      WHERE bucket_start = $1
        AND service = $2
    `,
    [
      bucketStart,
      retentionRollupService,
    ],
  );

  return result.rows[0]?.count === '1';
}

async function dropTestRelations(): Promise<void> {
  /*
   * Remove the dependency first so an earlier failed
   * test cannot prevent its partition from being
   * cleaned up.
   */
  await pool.query(
    `DROP VIEW IF EXISTS "${dependentView}"`,
  );

  for (const name of allTestRelations) {
    await pool.query(
      `DROP TABLE IF EXISTS "${name}"`,
    );

    forgetKnownPartition(name);
  }
}

async function createBoundaryPartitions(): Promise<void> {
  for (const name of boundaryPartitions) {
    const [, year, month, day] =
      name.split('_');

    await ensureDailyPartition(
      new Date(
        `${year}-${month}-${day}T12:00:00.000Z`,
      ),
    );
  }
}

async function relationExists(
  name: string,
): Promise<boolean> {
  const result = await pool.query<{
    relation: string | null;
  }>(
    `
      SELECT to_regclass($1)::text AS relation
    `,
    [`public.${name}`],
  );

  return (
    result.rows[0]?.relation === name
  );
}

async function expectRelationsToExist(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    expect(
      await relationExists(name),
      name,
    ).toBe(true);
  }
}

async function expectRelationsToBeAbsent(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    expect(
      await relationExists(name),
      name,
    ).toBe(false);
  }
}

describe('dropExpiredPartitions', () => {
  beforeEach(async () => {
    await dropTestRelations();
    await deleteTestRollups();
    await createBoundaryPartitions();
  });

  afterEach(async () => {
    await dropTestRelations();
    await deleteTestRollups();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('drops a partition older than the cutoff', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await relationExists(
        expiredPartitions[0],
      ),
    ).toBe(false);
  });

  it('drops multiple expired partitions', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    await expectRelationsToBeAbsent(
      expiredPartitions,
    );
  });

  it('keeps a partition exactly on the cutoff day', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await relationExists(
        cutoffPartition,
      ),
    ).toBe(true);
  });

  it('keeps a partition newer than the cutoff', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await relationExists(
        'logs_1980_07_15',
      ),
    ).toBe(true);
  });

  it('keeps the partition for the reference day', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await relationExists(
        'logs_1980_08_13',
      ),
    ).toBe(true);
  });

  it('keeps a future partition', async () => {
    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await relationExists(
        'logs_1980_08_14',
      ),
    ).toBe(true);
  });

  it('returns the names of dropped partitions', async () => {
    const dropped =
      await dropExpiredPartitions(
        30,
        referenceDate,
      );

    expect(dropped).toEqual(
      expect.arrayContaining([
        ...expiredPartitions,
      ]),
    );
  });

  it('does not return partitions on or after the cutoff', async () => {
    const dropped =
      await dropExpiredPartitions(
        30,
        referenceDate,
      );

    for (const name of keptPartitions) {
      expect(
        dropped,
      ).not.toContain(name);
    }
  });

  it('is safe and idempotent when run twice', async () => {
    const firstDropped =
      await dropExpiredPartitions(
        30,
        referenceDate,
      );

    const secondDropped =
      await dropExpiredPartitions(
        30,
        referenceDate,
      );

    expect(firstDropped).toEqual(
      expect.arrayContaining([
        ...expiredPartitions,
      ]),
    );

    expect(
      secondDropped,
    ).toEqual([]);

    await expectRelationsToExist(
      keptPartitions,
    );
  });

  it('honors a custom retention period with the same strict boundary', async () => {
    await ensureDailyPartition(
      new Date(
        '1981-08-10T12:00:00.000Z',
      ),
    );

    await ensureDailyPartition(
      new Date(
        '1981-08-11T12:00:00.000Z',
      ),
    );

    const dropped =
      await dropExpiredPartitions(
        2,
        new Date(
          '1981-08-13T18:00:00.000Z',
        ),
      );

    expect(
      dropped,
    ).toContain(
      'logs_1981_08_10',
    );

    expect(
      dropped,
    ).not.toContain(
      'logs_1981_08_11',
    );

    expect(
      await relationExists(
        'logs_1981_08_10',
      ),
    ).toBe(false);

    expect(
      await relationExists(
        'logs_1981_08_11',
      ),
    ).toBe(true);
  });

  it('considers only child partitions of logs', async () => {
    await pool.query(
      `
        CREATE TABLE "${ordinaryTable}" (
          id integer
        )
      `,
    );

    const dropped =
      await dropExpiredPartitions(
        30,
        referenceDate,
      );

    expect(
      dropped,
    ).not.toContain(
      ordinaryTable,
    );

    expect(
      await relationExists(
        ordinaryTable,
      ),
    ).toBe(true);
  });

  it('removes rollups belonging to an expired partition while preserving retained rollups', async () => {
    const expiredBucket =
      '1980-07-12T10:15:00.000Z';

    const cutoffBucket =
      '1980-07-14T10:15:00.000Z';

    const newerBucket =
      '1980-07-15T10:15:00.000Z';

    await insertTestRollup(
      expiredBucket,
    );

    await insertTestRollup(
      cutoffBucket,
    );

    await insertTestRollup(
      newerBucket,
    );

    await dropExpiredPartitions(
      30,
      referenceDate,
    );

    expect(
      await rollupExists(
        expiredBucket,
      ),
    ).toBe(false);

    /*
     * The cutoff day itself is retained.
     */
    expect(
      await rollupExists(
        cutoffBucket,
      ),
    ).toBe(true);

    expect(
      await rollupExists(
        newerBucket,
      ),
    ).toBe(true);
  });

  it('rolls back rollup deletion when dropping the partition fails', async () => {
    const partition =
      expiredPartitions[0];

    const bucket =
      '1980-07-12T10:15:00.000Z';

    await insertTestRollup(
      bucket,
    );

    /*
     * PostgreSQL will refuse to DROP the
     * partition while this dependent view
     * exists.
     */
    await pool.query(
      `
        CREATE VIEW "${dependentView}" AS
        SELECT *
        FROM "${partition}"
      `,
    );

    try {
      await expect(
        dropExpiredPartitions(
          30,
          referenceDate,
        ),
      ).rejects.toThrow();

      /*
       * The rollup DELETE happened before
       * DROP TABLE inside the same transaction.
       *
       * Because DROP TABLE failed, ROLLBACK
       * must restore the deleted rollup.
       */
      expect(
        await rollupExists(
          bucket,
        ),
      ).toBe(true);

      /*
       * The raw partition must also still exist.
       */
      expect(
        await relationExists(
          partition,
        ),
      ).toBe(true);
    }
    finally {
      await pool.query(
        `DROP VIEW IF EXISTS "${dependentView}"`,
      );
    }
  });

  it('prepareDatabase completes only after retention cleanup has run', async () => {
    await ensureDailyPartition(
      new Date(
        '1971-01-02T12:00:00.000Z',
      ),
    );

    expect(
      await relationExists(
        startupPartition,
      ),
    ).toBe(true);

    await expect(
      prepareDatabase(),
    ).resolves.toBeUndefined();

    expect(
      await relationExists(
        startupPartition,
      ),
    ).toBe(false);
  });
});