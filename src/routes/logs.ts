import type { FastifyInstance } from "fastify";
import {validateBatchEnvelope,validateLogBatch} from "../services/validate-log-batch.js";

import { ingestLogs } from "../services/ingest-logs.js";
import { getLogs } from "../services/query-logs.js";
import { parseLogQuery } from "../schemas/log-query.js";

import { parseAggregateQuery } from "../schemas/aggregate-query.js";
import { getAggregatedLogs } from "../services/aggregate-logs.js";

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

    app.get("/logs",async(request,reply)=>{
        let filters;

        try{
            filters=parseLogQuery(request.query as Record<string,unknown>);
        }
        catch(error){
            const message=error instanceof Error
                ?error.message
                :"invalid query parameters";

            return reply.status(400).send({error:message});
        }

        try{
            const result=await getLogs(filters);

            return reply.status(200).send(result);
        }
        catch(error){
            if(error instanceof Error&&error.message==="invalid cursor"){
                return reply.status(400).send({error:error.message});
            }

            throw error;
        }
    });

    app.get("/logs/aggregate",async(request,reply)=>{
        let filters;

        try{
            filters=parseAggregateQuery(request.query as Record<string,unknown>);
        }
        catch(error){
            const message=error instanceof Error?error.message:"invalid aggregate query parameters";

            return reply.status(400).send({error:message});
        }

        const result=await getAggregatedLogs(filters);
        return reply.status(200).send(result);
    });
}
