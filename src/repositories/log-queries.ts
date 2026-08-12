import { pool } from "../database/pool.js";
import { buildLogQuery } from "../queries/logs.js";
import type { LogQueryFilters } from "../schemas/log-query.js";
import type { LogCursor } from "../utils/cursor.js";

export interface LogRow{
    id:string;
    timestamp:Date;
    level:string;
    service:string;
    message:string;
    attributes:Record<string,unknown>;
}

export async function queryLogs(filters:LogQueryFilters,cursor?:LogCursor):Promise<LogRow[]>{
    const query=buildLogQuery(filters,cursor);

    const result=await pool.query<LogRow>(query.text,query.values);

    return result.rows;
}