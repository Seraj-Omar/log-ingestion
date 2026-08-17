import type {AggregateQueryFilters,AggregateBucket,} from "../schemas/aggregate-query.js";
import { escapeLikePattern } from "../utils/like-pattern.js";

export interface BuiltAggregateQuery {
    text: string;
    values: unknown[];
}

const MINUTE_MS = 60_000;

function bucketInterval(bucket: AggregateBucket): string {
    switch (bucket) {
        case "1m":
            return "1 minute";
        case "5m":
            return "5 minutes";
        case "1h":
            return "1 hour";
        case "1d":
            return "1 day";
    }
}

function dateBinExpression(interval: string,column: "timestamp" | "bucket_start"): string {
    return `date_bin('${interval}',${column},TIMESTAMPTZ '1970-01-01 00:00:00+00')`;
}

export function canUseAggregateRollups(filters: AggregateQueryFilters): boolean {
    return (filters.q === undefined &&Object.keys(filters.attributes).length === 0);
}

export function buildAggregateQuery(filters: AggregateQueryFilters): BuiltAggregateQuery {
    const conditions: string[] = [];
    const values: unknown[] = [];

    const addValue = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
    };

    const sinceParam = addValue(filters.since);
    const untilParam = addValue(filters.until);

    conditions.push(`timestamp >= ${sinceParam}`);
    conditions.push(`timestamp < ${untilParam}`);

    if (filters.service !== undefined) {
        const p = addValue(filters.service);
        conditions.push(`service = ${p}`);
    }

    if (filters.level !== undefined) {
        const p = addValue(filters.level);
        conditions.push(`level = ${p}`);
    }

    for (const [key, value]of Object.entries(filters.attributes)) {
        const keyParam = addValue(key);
        const valueParam = addValue(value);

        conditions.push(`COALESCE(attributes ->> ${keyParam} = ${valueParam}, FALSE)`);
    }

    if (filters.q !== undefined) {
        const p = addValue(`%${escapeLikePattern(filters.q)}%`);
        conditions.push(`message ILIKE ${p} ESCAPE '\\'`);
    }

    const interval = bucketInterval(filters.bucket);

    const selectParts = [
        `${dateBinExpression(interval, "timestamp")} AS bucket`,
        `COUNT(*)::BIGINT AS count`,
    ];

    const groupParts = ["bucket"];

    if (filters.group_by !== undefined) {
        selectParts.splice(1,0,`${filters.group_by} AS group_value`);
        groupParts.push(filters.group_by);
    }

    const text = `
        SELECT
            ${selectParts.join(",\n            ")}
        FROM logs
        WHERE ${conditions.join(" AND ")}
        GROUP BY ${groupParts.join(", ")}
        ORDER BY bucket ASC
    `.trim();

    return {text,values,};
}

function ceilToMinute(timestampMs: number): number {
    return (Math.ceil(timestampMs / MINUTE_MS) *MINUTE_MS);
}

function floorToMinute(timestampMs: number): number {
    return (Math.floor(timestampMs / MINUTE_MS) *MINUTE_MS);
}

export function buildRollupAggregateQuery(filters: AggregateQueryFilters): BuiltAggregateQuery {
    if (!canUseAggregateRollups(filters)) {
        throw new Error("aggregate rollups cannot satisfy q or attribute filters");
    }

    const values: unknown[] = [];
    const parts: string[] = [];

    const addValue = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
    };

    const interval = bucketInterval(filters.bucket);
    const sinceMs = new Date(filters.since).getTime();
    const untilMs = new Date(filters.until).getTime();
    const rollupStartMs =ceilToMinute(sinceMs);
    const rollupEndMs =floorToMinute(untilMs);

    const buildCommonConditions = (timeColumn: string,start: string,end: string): string[] => {
        const conditions: string[] = [];

        const startParam = addValue(start);
        const endParam = addValue(end);

        conditions.push(`${timeColumn} >= ${startParam}`);
        conditions.push(`${timeColumn} < ${endParam}`);

        if (filters.service !== undefined) {
            const p = addValue(filters.service);
            conditions.push(`service = ${p}`);
        }

        if (filters.level !== undefined) {
            const p = addValue(filters.level);
            conditions.push(`level = ${p}`);
        }
        return conditions;
    };

    const buildRawPart = (start: string,end: string): string => {
        const conditions = buildCommonConditions("timestamp",start,end);

        const selectParts = [
            `${dateBinExpression(interval, "timestamp")} AS bucket`,
            `COUNT(*)::BIGINT AS count`,
        ];

        const groupParts = ["bucket"];

        if (filters.group_by !== undefined) {
            selectParts.splice(1,0,`${filters.group_by} AS group_value`);
            groupParts.push(filters.group_by);
        }

        return `
            SELECT
                ${selectParts.join(",\n                ")}
            FROM logs
            WHERE ${conditions.join(" AND ")}
            GROUP BY ${groupParts.join(", ")}
        `.trim();
    };

    const buildRollupPart = (start: string,end: string): string => {
        const conditions = buildCommonConditions("bucket_start",start,end);

        const selectParts = [
            `${dateBinExpression(interval, "bucket_start")} AS bucket`,
            `SUM(count)::BIGINT AS count`,
        ];

        const groupParts = ["bucket"];

        if (filters.group_by !== undefined) {
            selectParts.splice(1,0,`${filters.group_by} AS group_value`);
            groupParts.push(filters.group_by);
        }

        return `
            SELECT
                ${selectParts.join(",\n                ")}
            FROM log_rollups_1m
            WHERE ${conditions.join(" AND ")}
            GROUP BY ${groupParts.join(", ")}
        `.trim();
    };
    if (rollupStartMs < rollupEndMs) {
        if (sinceMs < rollupStartMs) {
            parts.push(buildRawPart(filters.since,new Date(rollupStartMs).toISOString()));
        }

        parts.push(buildRollupPart(new Date(rollupStartMs).toISOString(),new Date(rollupEndMs).toISOString()));

        if (rollupEndMs < untilMs) {
            parts.push(buildRawPart(new Date(rollupEndMs).toISOString(),filters.until));
        }
    } else {
        parts.push(buildRawPart(filters.since,filters.until));
    }

    const finalSelectParts = ["bucket","SUM(count)::BIGINT AS count"];
    const finalGroupParts = ["bucket"];

    if (filters.group_by !== undefined) {
        finalSelectParts.splice(1,0,"group_value");
        finalGroupParts.push("group_value");
    }

    const text = `
        WITH aggregate_parts AS (
            ${parts.join("\n            UNION ALL\n            ")}
        )
        SELECT
            ${finalSelectParts.join(",\n            ")}
        FROM aggregate_parts
        GROUP BY ${finalGroupParts.join(", ")}
        ORDER BY bucket ASC
    `.trim();

    return {text,values};
}