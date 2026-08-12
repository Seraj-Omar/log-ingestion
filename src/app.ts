import fastify, { type FastifyInstance } from 'fastify';
import { healthRoute } from './routes/health.js';
import { logRoutes } from './routes/logs.js';

export function buildApp():FastifyInstance{
    const app=fastify();
    app.register(healthRoute);
    app.register(logRoutes);
    return app;
}