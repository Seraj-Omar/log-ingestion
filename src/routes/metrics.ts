import type { FastifyInstance } from "fastify";
import { metrics } from "../metrics/metrics.js";

export async function metricsRoutes(app:FastifyInstance):Promise<void>{
    app.get("/metrics",async(request,reply)=>{
        return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
    });
}