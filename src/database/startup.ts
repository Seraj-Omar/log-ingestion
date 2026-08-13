import { checkDatabaseConnection } from "./pool.js";
import { ensureRollingPartitions } from "./partitions.js";
import { dropExpiredPartitions } from "./retention.js";


export async function prepareDatabase():Promise<void>{
    await checkDatabaseConnection();
    await ensureRollingPartitions();

    try{
        await dropExpiredPartitions();
    }
    catch(error){
        console.error("retention cleanup failed",error);
    }
}
