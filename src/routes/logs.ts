import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { validateBatchEnvelope, validateLogBatch } from "../services/validate-log-batch.js";

import { ingestLogs } from "../services/ingest-logs.js";
import { IngestionBatcher } from "../services/ingestion-batcher.js";
import { getLogs } from "../services/query-logs.js";
import { parseLogQuery } from "../schemas/log-query.js";

import { parseAggregateQuery } from "../schemas/aggregate-query.js";
import { getAggregatedLogs } from "../services/aggregate-logs.js";

import { metrics } from "../metrics/metrics.js";

interface LogRouteOptions extends FastifyPluginOptions {
    maxInFlightIngestions: number;
    maxInFlightLogs: number;
    maxInFlightBytes: number;
    batchSize: number;
    batchDelayMs: number;
}

const MINIMUM_RETAINED_REQUEST_BYTES = 2_048;
const RETAINED_BODY_SIZE_MULTIPLIER = 8;

const ingestionSuccessResponseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["accepted", "rejected"],
    properties: {
        accepted: {type: "integer",minimum: 0},
        rejected: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["index", "reason"],
                properties: {
                    index: {type: "integer",minimum: 0},
                    reason: {type: "string"}
                }
            }
        }
    }
} as const;

const ingestionErrorResponseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["error"],
    properties: {
        error: {type: "string"}
    }
} as const;

const fastifyErrorResponseSchema = {
    type: "object",
    required: ["statusCode", "error", "message"],
    properties: {
        statusCode: {type: "integer"},
        code: {type: "string"},
        error: {type: "string"},
        message: {type: "string"}
    }
} as const;

function requestBodyBytes(body: unknown,contentLength: string | undefined): number {
    if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
        const parsed = Number(contentLength);

        if (Number.isSafeInteger(parsed)) {
            return parsed;
        }
    }
    return Buffer.byteLength(JSON.stringify(body),"utf8");
}

export async function logRoutes(app: FastifyInstance,options: LogRouteOptions): Promise<void> {
    const ingestionBatcher = new IngestionBatcher(
        ingestLogs,
        {
            maxInFlightRequests: options.maxInFlightIngestions,
            maxInFlightLogs: options.maxInFlightLogs,
            maxInFlightBytes: options.maxInFlightBytes,
            batchSize: options.batchSize,
            batchDelayMs: options.batchDelayMs
        }
    );

    app.addHook("onClose", async () => {
        await ingestionBatcher.close();
    });

    app.post("/logs",
        {
            onRequest: async () => {
                metrics.incrementCounter(
                    "ingestion_requests_total"
                );
            },

            schema: {
                response: {
                    200: ingestionSuccessResponseSchema,
                    400: {
                        oneOf: [
                            ingestionSuccessResponseSchema,
                            ingestionErrorResponseSchema,
                            fastifyErrorResponseSchema
                        ]
                    },
                    503: ingestionErrorResponseSchema
                }
            }
        },
        async (request, reply) => {
            const envelope = validateBatchEnvelope(request.body);

            if (!envelope.success) {
                return reply.code(400).send({error: envelope.error});
            }

            const result = validateLogBatch(envelope.logs);
            metrics.incrementCounter("logs_rejected_total",result.rejected.length);

            if (result.valid.length === 0) {
                return reply.code(400).send({accepted: 0,rejected: result.rejected});
            }

            const retainedBytes = Math.max(MINIMUM_RETAINED_REQUEST_BYTES,requestBodyBytes(request.body,request.headers["content-length"]) * RETAINED_BODY_SIZE_MULTIPLIER);
            const persistence=ingestionBatcher.tryIngest(result.valid,retainedBytes);

            if (persistence===null) {
                return reply.header("Retry-After", "1").code(503).send({error: "ingestion overloaded"});
            }

            await persistence;
            metrics.incrementCounter("logs_accepted_total",result.valid.length);
            return reply.code(200).send({accepted: result.valid.length,rejected: result.rejected});
        }
    );

   app.get("/logs", async (request, reply) => {
        metrics.incrementCounter("query_requests_total");

        const startedAt = process.hrtime.bigint();

        try {
            let filters;

            try {
                filters = parseLogQuery(request.query as Record<string, unknown>);
            } catch (error) {
                const message =error instanceof Error? error.message : "invalid query parameters";
                return reply.status(400).send({ error: message });
            }

            try {
                const result = await getLogs(filters);
                return reply.status(200).send(result);
            } catch (error) {
                if (error instanceof Error &&error.message === "invalid cursor") {
                    return reply.status(400).send({ error: error.message });
                }
                throw error;
            }
        } finally {
            const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
            const elapsedSeconds =Number(elapsedNanoseconds) / 1_000_000_000;
            metrics.observeHistogram("query_duration_seconds",elapsedSeconds);
        }
    });

    app.get("/logs/aggregate", async (request, reply) => {
        metrics.incrementCounter("aggregation_requests_total");

        const startedAt = process.hrtime.bigint();

        try {
            let filters;

            try {
                filters = parseAggregateQuery(request.query as Record<string, unknown>);
            } catch (error) {
                const message =error instanceof Error? error.message: "invalid aggregate query parameters";

                return reply.status(400).send({ error: message });
            }
            const result =await getAggregatedLogs(filters);

            return reply.status(200).send(result);
        } finally {
            const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
            const elapsedSeconds = Number(elapsedNanoseconds) / 1_000_000_000;
            metrics.observeHistogram("aggregation_duration_seconds",elapsedSeconds);
        }
    });
}