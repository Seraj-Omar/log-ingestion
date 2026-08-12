import { z } from "zod";

export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];
export type LogAttributeValue = string | number | boolean;

export interface ValidLog {
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    attributes: Record<string, LogAttributeValue>;
}

const attributeValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean()
]);

const attributesSchema = z.record(
    z.string(),
    attributeValueSchema
);

export const logSchema = z.object({
    timestamp: z
        .string()
        .datetime({ offset: true }),

    level: z.enum(logLevels),

    service: z
        .string()
        .trim()
        .min(1),

    message: z
        .string()
        .trim()
        .min(1),

    attributes: attributesSchema.optional().default({})
}).strict();

export const logBatchEnvelopeSchema = z.object({
    logs: z
        .array(z.unknown())
        .min(1)
}).strict();