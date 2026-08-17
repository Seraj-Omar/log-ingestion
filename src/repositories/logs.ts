import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { from as copyFrom } from "pg-copy-streams";

import { pool } from "../database/pool.js";
import type { ValidLog } from "../schemas/log.js";

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

interface RollupDelta {
    bucketStart: string;
    service: string;
    level: ValidLog["level"];
    count: number;
}

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

function* serializeLogs(logs: readonly ValidLog[]): Generator<string> {
    for (const log of logs) {
        yield serializeLog(log);
    }
}

function minuteBucket(timestamp: string): string {
    const date = new Date(timestamp);

    date.setUTCSeconds(0, 0);

    return date.toISOString();
}

function buildRollupDeltas(logs: readonly ValidLog[]): RollupDelta[] {
    const deltas = new Map<string,RollupDelta>();

    for (const log of logs) {
        const bucketStart = minuteBucket(log.timestamp);

        const key = JSON.stringify([
            bucketStart,
            log.service,
            log.level,
        ]);

        const existing = deltas.get(key);

        if (existing !== undefined) {
            existing.count += 1;
            continue;
        }

        deltas.set(key, {
            bucketStart,
            service: log.service,
            level: log.level,
            count: 1,
        });
    }

    return [...deltas.values()];
}

function buildRollupUpsert(deltas: readonly RollupDelta[]): {text: string;values: unknown[];} {
    const values: unknown[] = [];

    const rows = deltas.map((delta) => {
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
    });

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

    try {
        await client.query("BEGIN");
        const copyStream = client.query(copyFrom(COPY_SQL));
        const source = Readable.from(
            serializeLogs(logs),
            {
                objectMode: false,
            }
        );

        await pipeline(source,copyStream);
        const rollupQuery = buildRollupUpsert(buildRollupDeltas(logs));
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