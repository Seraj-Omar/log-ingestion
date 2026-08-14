import fastify, { type FastifyInstance } from 'fastify';
import { ingestionConfigFromEnvironment } from './config/ingestion.js';
import { healthRoute } from './routes/health.js';
import { logRoutes } from './routes/logs.js';

export interface BuildAppOptions {
    maxInFlightIngestions?: number;
    maxInFlightLogs?: number;
    maxInFlightBytes?: number;
    ingestionBatchSize?: number;
    ingestionBatchDelayMs?: number;
}

export function buildApp(options: BuildAppOptions = {}):FastifyInstance{
    const environmentConfig=ingestionConfigFromEnvironment();
    const app=fastify({bodyLimit:1024*1024});
    app.register(healthRoute);
    app.register(logRoutes, {
        maxInFlightIngestions:
            options.maxInFlightIngestions ??
            environmentConfig.maxInFlightIngestions,
        maxInFlightLogs:
            options.maxInFlightLogs ??
            environmentConfig.maxInFlightLogs,
        maxInFlightBytes:
            options.maxInFlightBytes ??
            environmentConfig.maxInFlightBytes,
        batchSize:
            options.ingestionBatchSize ??
            environmentConfig.batchSize,
        batchDelayMs:
            options.ingestionBatchDelayMs ??
            environmentConfig.batchDelayMs
    });
    return app;
}
