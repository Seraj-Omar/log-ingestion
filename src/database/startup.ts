import { checkDatabaseConnection } from "./pool.js";
import { ensureRollingPartitions } from "./partitions.js";

export async function prepareDatabase():Promise<void>{
    await checkDatabaseConnection();
    await ensureRollingPartitions();
}