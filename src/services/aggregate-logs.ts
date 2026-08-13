import { aggregateLogs } from "../repositories/aggregate.js";
import type { AggregateQueryFilters } from "../schemas/aggregate-query.js";

export interface AggregateLogItem{
    start:string;
    group:string|null;
    count:number;
}

export interface AggregateLogsResult{
    buckets:AggregateLogItem[];
}

export async function getAggregatedLogs(filters:AggregateQueryFilters):Promise<AggregateLogsResult>{
    const rows=await aggregateLogs(filters);

    const buckets:AggregateLogItem[]=rows.map((row)=>({
        start:row.bucket.toISOString(),
        group:row.group_value??null,
        count:Number(row.count)
    }));

    return{buckets};
}
