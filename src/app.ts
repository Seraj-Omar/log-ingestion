import fastify, { type FastifyInstance } from 'fastify';
import { ingestionConfigFromEnvironment } from './config/ingestion.js';
import { healthRoute } from './routes/health.js';
import { logRoutes } from './routes/logs.js';
import { metricsRoutes } from './routes/metrics.js';
import { liveTailRoutes } from "./routes/live-tail.js";
import { createApiKeyAuthHook } from './auth/api-key.js';
import { authConfigFromEnvironment } from './config/auth.js';

export interface BuildAppOptions {
    maxInFlightIngestions?: number;
    maxInFlightLogs?: number;
    maxInFlightBytes?: number;
    ingestionBatchSize?: number;
    ingestionBatchDelayMs?: number;

    authEnabled?:boolean;
    apiKey?:string;
}

export function buildApp(options: BuildAppOptions = {}):FastifyInstance{
    const environmentIngestionConfig=ingestionConfigFromEnvironment();

    const environmentAuthConfig=authConfigFromEnvironment();
    const authEnabled=options.authEnabled??environmentAuthConfig.enabled;
    const apiKey=options.apiKey??environmentAuthConfig.apiKey;

    if(authEnabled&&!apiKey){
        throw new Error("API key is required when authentication is enabled");
    }

    const app=fastify({bodyLimit:1024*1024});

    app.register(healthRoute);
    app.register(metricsRoutes);

    app.register(async(protectedRoutes)=>{
        if(authEnabled&&apiKey){
            protectedRoutes.addHook("onRequest",createApiKeyAuthHook(apiKey));
        }

        protectedRoutes.register(logRoutes, {
            maxInFlightIngestions:options.maxInFlightIngestions??environmentIngestionConfig.maxInFlightIngestions,
            maxInFlightLogs:options.maxInFlightLogs??environmentIngestionConfig.maxInFlightLogs,
            maxInFlightBytes:options.maxInFlightBytes??environmentIngestionConfig.maxInFlightBytes,
            batchSize:options.ingestionBatchSize??environmentIngestionConfig.batchSize,
            batchDelayMs:options.ingestionBatchDelayMs??environmentIngestionConfig.batchDelayMs
        });

        protectedRoutes.register(liveTailRoutes);
    })

    return app;
}
