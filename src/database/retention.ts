import { pool } from "./pool.js";
import { startOfUtcDay,addDays,dropDailyPartition,} from "./partitions.js";

const DEFAULT_RETENTION_DAYS = 30;
const PARTITION_NAME_PATTERN = /^logs_(\d{4})_(\d{2})_(\d{2})$/;

export function retentionDaysFromEnvironment(value: string | undefined =process.env.RETENTION_DAYS): number {
    if (value === undefined) {
        return DEFAULT_RETENTION_DAYS;
    }

    const retentionDays = Number(value);

    if (!Number.isInteger(retentionDays) ||retentionDays < 0) {
        throw new Error("RETENTION_DAYS must be a non-negative integer");
    }
    return retentionDays;
}

export function retentionCutOff(referenceDate: Date,retentionDays: number = DEFAULT_RETENTION_DAYS): Date {
    return addDays(startOfUtcDay(referenceDate),-retentionDays);
}

function partitionDate(name: string): Date | null {
    const match =PARTITION_NAME_PATTERN.exec(name);

    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    return new Date(Date.UTC(year,month - 1,day));
}

export async function dropExpiredPartitions(retentionDays: number = retentionDaysFromEnvironment(),referenceDate: Date = new Date()): Promise<string[]> {
    const cutoff = retentionCutOff(referenceDate,retentionDays);

    const result =await pool.query<{partition_name: string;}>
        (`
            SELECT
                child.relname AS partition_name
            FROM pg_inherits
            JOIN pg_class parent
                ON pg_inherits.inhparent = parent.oid
            JOIN pg_class child
                ON pg_inherits.inhrelid = child.oid
            WHERE parent.relname = 'logs'
        `);

    const dropped: string[] = [];

    for (const row of result.rows) {
        const date = partitionDate(row.partition_name);

        if (date === null || date >= cutoff) {
            continue;
        }

        const nextDay = addDays(date,1);

        await dropDailyPartition(row.partition_name,
            async (client) => {
                await client.query(
                    `
                        DELETE FROM log_rollups_1m
                        WHERE bucket_start >= $1
                        AND bucket_start < $2
                    `,
                    [date.toISOString(),nextDay.toISOString()]
                );
            }
        );

        dropped.push(row.partition_name);
    }
    return dropped;
}