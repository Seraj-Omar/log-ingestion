import type { FastifyInstance } from "fastify";
import {
    validateBatchEnvelope,
    validateLogBatch
} from "../services/validate-log-batch.js";
import { ingestLogs } from "../services/ingest-logs.js";

export async function logRoutes(app:FastifyInstance):Promise<void>{
    app.post("/logs",async(request,reply)=>{
        const envelope=validateBatchEnvelope(request.body);

        if(!envelope.success){
            return reply.code(400).send({error:envelope.error});
        }

        const result=validateLogBatch(envelope.logs);

        if(result.valid.length==0){
            return reply.code(400).send({accepted:0,rejected:result.rejected});
        }

        await ingestLogs(result.valid);
        
        return reply.code(200).send({accepted:result.valid.length,rejected:result.rejected});
    })
}