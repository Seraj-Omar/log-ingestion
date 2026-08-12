import {
    logBatchEnvelopeSchema,
    logSchema,
    type ValidLog
} from "../schemas/log.js";

export interface RejectedLog {
    index: number;
    reason: string;
}

export interface BatchValidationResult {
    valid: ValidLog[];
    rejected: RejectedLog[];
}

export type EnvelopeValidationResult =
    | {success: true;logs: unknown[];}
    | {success: false;error: string;};

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function validateBatchEnvelope(body: unknown): EnvelopeValidationResult {
    const result = logBatchEnvelopeSchema.safeParse(body);

    if (!result.success) {
        return {
            success: false,
            error: formatEnvelopeError(result.error)
        };
    }

    return {
        success: true,
        logs: result.data.logs
    };
}

export function validateLogBatch(logs: unknown[],now: Date = new Date()): BatchValidationResult {
    const valid: ValidLog[] = [];
    const rejected: RejectedLog[] = [];

    for (const [index, rawLog] of logs.entries()) {
        const result = logSchema.safeParse(rawLog);

        if (!result.success) {
            rejected.push({
                index,
                reason: formatLogError(rawLog, result.error)
            });
            continue;
        }

        const timestamp = new Date(result.data.timestamp);

        if (timestamp.getTime() > now.getTime() + FIVE_MINUTES_MS) {
            rejected.push({
                index,
                reason: "timestamp is more than 5 minutes in the future"
            });

            continue;
        }

        valid.push(result.data);
    }

    return {
        valid,
        rejected
    };
}

function formatEnvelopeError(error: {
    issues: Array<{
        path: PropertyKey[];
        code: string;
    }>;
}): string {
    const issue = error.issues[0];

    if (!issue) {
        return "invalid request body";
    }

    if (issue.path[0] === "logs") {
        if (issue.code === "too_small") {
            return "logs array must not be empty";
        }

        return "logs must be a non-empty array";
    }

    return "invalid request body";
}

function formatLogError(
    rawLog: unknown,
    error: {
        issues: Array<{
            path: PropertyKey[];
        }>;
    }
): string {
    const issue = error.issues[0];

    if (!issue) {
        return "invalid log entry";
    }

    const field = issue.path[0];

    switch (field) {
        case "timestamp":
            return "invalid timestamp";

        case "level":
            return formatInvalidLevel(rawLog);

        case "service":
            return "service must be a non-empty string";

        case "message":
            return "message must be a non-empty string";

        case "attributes":
            return "attributes must be a flat object with string, number, or boolean values";

        default:
            return "invalid log entry";
    }
}

function formatInvalidLevel(rawLog: unknown): string {
    if (
        typeof rawLog === "object" &&
        rawLog !== null &&
        "level" in rawLog
    ) {
        const level = (rawLog as { level?: unknown }).level;

        if (typeof level === "string") {
            return `invalid level: '${level}'`;
        }
    }

    return "invalid level";
}