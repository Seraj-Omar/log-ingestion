import { ensurePartitionsForTimestamps } from "../database/partitions.js";
import { insertLogs } from "../repositories/logs.js";
import type { ValidLog } from "../schemas/log.js";

export async function ingestLogs(logs:readonly ValidLog[]):Promise<void>{
    if(logs.length===0){
        return;
    }

    await ensurePartitionsForTimestamps(logs.map((log)=>log.timestamp));
    
    await insertLogs(logs);
}
