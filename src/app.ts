import fastify, { type FastifyInstance } from 'fastify';
import { maxInFlightIngestionsFromEnvironment } from './config/ingestion.js';
import { healthRoute } from './routes/health.js';
import { logRoutes } from './routes/logs.js';

export interface BuildAppOptions {
    maxInFlightIngestions?: number;
}

export function buildApp(options: BuildAppOptions = {}):FastifyInstance{
    const app=fastify();
    app.register(healthRoute);
    app.register(logRoutes, {
        maxInFlightIngestions:
            options.maxInFlightIngestions ??
            maxInFlightIngestionsFromEnvironment()
    });
    return app;
}
