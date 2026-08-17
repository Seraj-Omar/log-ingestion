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

export async function insertLogs(logs: readonly ValidLog[]): Promise<void> {
    if (logs.length === 0) {
        return;
    }

    const client = await pool.connect();

    try {
        const copyStream = client.query(copyFrom(COPY_SQL));

        const source = Readable.from(
            serializeLogs(logs),
            {
                objectMode: false,
            }
        );

        await pipeline(source,copyStream);
    }
    finally {
        client.release();
    }
}