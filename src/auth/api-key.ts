import { timingSafeEqual } from "node:crypto";
import type { FastifyReply,FastifyRequest } from "fastify";

function apiKeysMatch(provided:string,expected:string):boolean{
    const providedBuffer=Buffer.from(provided);
    const expectedBuffer=Buffer.from(expected);

    if(providedBuffer.length!==expectedBuffer.length){
        return false;
    }

    return timingSafeEqual(providedBuffer,expectedBuffer);
}

export function createApiKeyAuthHook(apiKey:string){
    return async function authenticateApiKey(request:FastifyRequest,reply:FastifyReply):Promise<void>{
        const providedApiKey=request.headers["x-api-key"];

        if(typeof providedApiKey!=="string"||!(apiKeysMatch(providedApiKey,apiKey))){
            await reply.code(401).send({error:"Unauthorized"})
        }
    };
}