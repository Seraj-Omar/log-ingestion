export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE log_rollups_1m (
      bucket_start TIMESTAMPTZ NOT NULL,
      service TEXT NOT NULL,
      level TEXT NOT NULL,
      count BIGINT NOT NULL,

      CONSTRAINT log_rollups_1m_count_check
        CHECK (count > 0),

      PRIMARY KEY (
        bucket_start,
        service,
        level
      )
    );

    CREATE INDEX log_rollups_1m_service_bucket_idx
    ON log_rollups_1m (
      service,
      bucket_start
    );

    CREATE INDEX log_rollups_1m_level_bucket_idx
    ON log_rollups_1m (
      level,
      bucket_start
    );

    INSERT INTO log_rollups_1m (
      bucket_start,
      service,
      level,
      count
    )
    SELECT
      date_trunc('minute', timestamp),
      service,
      level,
      COUNT(*)::BIGINT
    FROM logs
    GROUP BY
      date_trunc('minute', timestamp),
      service,
      level;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS log_rollups_1m;
  `);
};