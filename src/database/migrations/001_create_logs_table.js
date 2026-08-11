export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE logs (
      id BIGINT GENERATED ALWAYS AS IDENTITY,
      timestamp TIMESTAMPTZ NOT NULL,
      level TEXT NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,

      CONSTRAINT logs_level_check
        CHECK (level IN ('debug', 'info', 'warn', 'error')),

      PRIMARY KEY (timestamp, id)
    ) PARTITION BY RANGE (timestamp);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS logs CASCADE;
  `);
};
