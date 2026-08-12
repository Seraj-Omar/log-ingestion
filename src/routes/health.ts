import type { FastifyInstance } from "fastify";
import { isReady } from "../config/readiness.js";

export async function healthRoute(app:FastifyInstance):Promise<void>{
    app.get("/health",async(_request,reply)=>{
        if(!isReady()){
            return reply.code(503).send({status:"starting"});
        }

        return{status:"ok"};
    });
}