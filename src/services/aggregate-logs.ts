import { aggregateLogs } from "../repositories/aggregate.js";
import type { AggregateQueryFilters } from "../schemas/aggregate-query.js";

export interface AggregateLogItem{
    bucket:string;
    count:string;
    group?:string;
}

export interface AggregateLogsResult{
    results:AggregateLogItem[];
}

export async function getAggregatedLogs(filters:AggregateQueryFilters):Promise<AggregateLogsResult>{
    const rows=await aggregateLogs(filters);

    const results:AggregateLogItem[]=rows.map((row)=>{
        const item:AggregateLogItem={bucket:row.bucket.toISOString(),count:row.count};

        if(row.group_value!==undefined){
            item.group=row.group_value;
        }

        return item;
    })

    return{results};
}
