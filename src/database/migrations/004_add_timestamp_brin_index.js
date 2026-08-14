export const up=(pgm)=>{
  pgm.sql(`
    CREATE INDEX logs_timestamp_brin_idx
    ON logs USING BRIN (timestamp)
    WITH (pages_per_range = 32, autosummarize = on);
  `);
};

export const down=(pgm)=>{
  pgm.sql(`
    DROP INDEX IF EXISTS logs_timestamp_brin_idx;
  `);
};
