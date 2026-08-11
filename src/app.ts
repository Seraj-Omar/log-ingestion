import fastify, { type FastifyInstance } from 'fastify';
import { healthRoute } from './routes/health.js';

export function buildApp():FastifyInstance{
    const app=fastify();
    app.register(healthRoute);
    return app;
}