import fastify, { type FastifyInstance } from 'fastify';

export function buildApp():FastifyInstance{
    const app=fastify();
    return app;
}