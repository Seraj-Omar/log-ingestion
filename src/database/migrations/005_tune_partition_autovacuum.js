export const up=(pgm)=>{
  pgm.sql(`
    DO $$
    DECLARE
      partition_record RECORD;
    BEGIN
      FOR partition_record IN
        SELECT
          partition_namespace.nspname AS schema_name,
          partition.relname AS table_name
        FROM pg_inherits AS inheritance
        JOIN pg_class AS partition
          ON partition.oid = inheritance.inhrelid
        JOIN pg_namespace AS partition_namespace
          ON partition_namespace.oid = partition.relnamespace
        WHERE inheritance.inhparent = 'public.logs'::regclass
      LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I SET (
            autovacuum_vacuum_insert_scale_factor = 0.005,
            autovacuum_vacuum_insert_threshold = 10000,
            autovacuum_analyze_scale_factor = 0.01,
            autovacuum_analyze_threshold = 10000
          )',
          partition_record.schema_name,
          partition_record.table_name
        );
      END LOOP;
    END
    $$;
  `);
};

export const down=(pgm)=>{
  pgm.sql(`
    DO $$
    DECLARE
      partition_record RECORD;
    BEGIN
      FOR partition_record IN
        SELECT
          partition_namespace.nspname AS schema_name,
          partition.relname AS table_name
        FROM pg_inherits AS inheritance
        JOIN pg_class AS partition
          ON partition.oid = inheritance.inhrelid
        JOIN pg_namespace AS partition_namespace
          ON partition_namespace.oid = partition.relnamespace
        WHERE inheritance.inhparent = 'public.logs'::regclass
      LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I RESET (
            autovacuum_vacuum_insert_scale_factor,
            autovacuum_vacuum_insert_threshold,
            autovacuum_analyze_scale_factor,
            autovacuum_analyze_threshold
          )',
          partition_record.schema_name,
          partition_record.table_name
        );
      END LOOP;
    END
    $$;
  `);
};
