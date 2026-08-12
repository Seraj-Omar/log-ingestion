import { queryLogs } from "../repositories/log-queries.js";
import type { LogQueryFilters } from "../schemas/log-query.js";
import { decodeCursor,encodeCursor } from "../utils/cursor.js";

export interface QueryLogItem {
    id:string;
    timestamp:string;
    level:string;
    service:string;
    message:string;
    attributes:Record<string,unknown>;
}

export interface QueryLogsResult {
    logs:QueryLogItem[];
    next_cursor:string|null;
}

export async function getLogs(filters:LogQueryFilters):Promise<QueryLogsResult>{
    const cursor=filters.cursor?decodeCursor(filters.cursor):undefined;

    const rows=await queryLogs(filters,cursor);

    const hasMore=rows.length>filters.limit;

    const visibleRows=hasMore?rows.slice(0,filters.limit):rows;

    const logs:QueryLogItem[]=visibleRows.map((row)=>({
        id:row.id,
        timestamp:row.timestamp.toISOString(),
        level:row.level,
        service:row.service,
        message:row.message,
        attributes:row.attributes
    }));

    let nextCursor:string|null=null;
    if(hasMore&&logs.length>0){
        const lastLog=logs.at(-1);
        
        if(lastLog)
            nextCursor=encodeCursor({timestamp:lastLog.timestamp,id:lastLog.id});
    }

    return {logs,next_cursor:nextCursor};
}