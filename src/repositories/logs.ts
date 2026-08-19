import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { from as copyFrom } from "pg-copy-streams";

import { pool } from "../database/pool.js";
import { logLevels, type ValidLog } from "../schemas/log.js";

const COPY_SQL = `
    COPY logs (
        timestamp,
        level,
        service,
        message,
        attributes
    )
    FROM STDIN
    WITH (FORMAT csv)
`;

const COPY_CHUNK_TARGET_BYTES = 64 * 1024;
const MINUTE_MS = 60_000;

interface RollupDelta {
    bucketStart: string;
    service: string;
    level: ValidLog["level"];
    count: number;
}

type LevelCounts = Record<ValidLog["level"],number>;
type ServiceRollups = Map<string,LevelCounts>;
type RollupAccumulator = Map<number,ServiceRollups>;

function csvField(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function serializeLog(log: ValidLog): string {
    return [
        csvField(log.timestamp),
        csvField(log.level),
        csvField(log.service),
        csvField(log.message),
        csvField(JSON.stringify(log.attributes)),
    ].join(",") + "\n";
}

function createLevelCounts(): LevelCounts {
    return {debug: 0,info: 0,warn: 0,error: 0};
}

function accumulateRollup(rollups: RollupAccumulator,log: ValidLog): void {
    const timestampMs = Date.parse(log.timestamp);
    const bucketStartMs = Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;
    let services = rollups.get(bucketStartMs);

    if (services === undefined) {
        services = new Map<string,LevelCounts>();
        rollups.set(bucketStartMs,services);
    }

    let counts = services.get(log.service);

    if (counts === undefined) {
        counts = createLevelCounts();
        services.set(log.service,counts);
    }
    counts[log.level] += 1;
}

function* serializeLogs(logs: readonly ValidLog[],rollups: RollupAccumulator): Generator<string> {
    let rows: string[] = [];
    let chunkBytes = 0;

    for (const log of logs) {
        accumulateRollup(rollups,log);
        const row = serializeLog(log);
        const rowBytes = Buffer.byteLength(row,"utf8");

        if (rows.length > 0 && chunkBytes + rowBytes > COPY_CHUNK_TARGET_BYTES) {
            const chunk = rows.join("");
            rows = [];
            chunkBytes = 0;
            yield chunk;
        }

        rows.push(row);
        chunkBytes += rowBytes;

        if (chunkBytes >= COPY_CHUNK_TARGET_BYTES) {
            const chunk = rows.join("");
            rows = [];
            chunkBytes = 0;
            yield chunk;
        }
    }

    if (rows.length > 0) {
        yield rows.join("");
    }
}

function buildRollupDeltas(rollups: RollupAccumulator): RollupDelta[] {
    const deltas: RollupDelta[] = [];

    for (const [bucketStartMs,services] of rollups) {
        const bucketStart = new Date(bucketStartMs).toISOString();

        for (const [service,counts] of services) {
            for (const level of logLevels) {
                const count = counts[level];

                if (count === 0) {
                    continue;
                }
                deltas.push({bucketStart,service,level,count});
            }
        }
    }
    return deltas;
}

function buildRollupUpsert(deltas: readonly RollupDelta[]): {text: string;values: unknown[];} {
    const values: unknown[] = [];

    const rows = deltas.map(
        (delta) => {
            const offset = values.length;

            values.push(
                delta.bucketStart,
                delta.service,
                delta.level,
                delta.count
            );

            return `(
                $${offset + 1},
                $${offset + 2},
                $${offset + 3},
                $${offset + 4}
            )`;
        }
    );

    return {
        text: `
            INSERT INTO log_rollups_1m (
                bucket_start,
                service,
                level,
                count
            )
            VALUES
                ${rows.join(",\n")}
            ON CONFLICT (
                bucket_start,
                service,
                level
            )
            DO UPDATE SET
                count =
                    log_rollups_1m.count +
                    EXCLUDED.count
        `,
        values,
    };
}

export async function insertLogs(logs: readonly ValidLog[]): Promise<void> {
    if (logs.length === 0) {
        return;
    }

    const client = await pool.connect();

    const rollups:RollupAccumulator = new Map();

    try {
        await client.query("BEGIN");
        const copyStream = client.query(copyFrom(COPY_SQL));
        const source = Readable.from(serializeLogs(logs,rollups),{objectMode: false});
        await pipeline(source,copyStream);

        const rollupQuery =buildRollupUpsert(buildRollupDeltas(rollups));
        await client.query(rollupQuery.text,rollupQuery.values);
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}