export const up = (pgm) => {
  pgm.sql(`
    CREATE INDEX logs_attr_user_id_timestamp_id_idx
    ON logs (
      (attributes ->> 'user_id'),
      timestamp DESC,
      id DESC
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS logs_attr_user_id_timestamp_id_idx;
  `);
};