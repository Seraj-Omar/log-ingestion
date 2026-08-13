import { z } from "zod";
import { logLevels,type LogLevel } from "./log.js";

export const aggregateBuckets=["1m","5m","1h","1d"] as const;
export const aggregateGroupBy=["service","level"] as const;

export type AggregateBucket=(typeof aggregateBuckets)[number];
export type AggregateGroupBy=(typeof aggregateGroupBy)[number];

export interface AggregateQueryFilters {
    since:string;
    until:string;
    bucket:AggregateBucket;
    group_by?:AggregateGroupBy;
    service?:string;
    level?:LogLevel;
    q?:string;
    attributes:Record<string,string>;
}

const aggregateQuerySchema=z.object({
    since:z.string().datetime({offset:true,error:"invalid since timestamp"}),

    until:z.string().datetime({offset:true,error:"invalid until timestamp"}),

    bucket:z.enum(aggregateBuckets,{error:"unsupported bucket"}),

    group_by:z.enum(aggregateGroupBy,{error:"unsupported group_by"}).optional(),

    service:z.string().optional(),

    level:z.enum(logLevels,{error:"invalid level filter"}).optional(),

    q:z.string().optional()
});

export function parseAggregateQuery(rawQuery:Record<string,unknown>):AggregateQueryFilters{
    const attributes:Record<string,string>={};
    const baseQuery:Record<string,unknown>={};

    for(const [key,value] of Object.entries(rawQuery)){
        if(key.startsWith("attr.")){
            const attributeKey=key.slice("attr.".length);

            if(attributeKey.length==0||typeof value!=="string"){
                throw new Error(`invalid attribute filter: '${key}'`);
            }

            attributes[attributeKey]=value;
            continue;
        }
        baseQuery[key]=value;
    }

    const result=aggregateQuerySchema.safeParse(baseQuery);
    if(!result.success){
        throw new Error(result.error.issues[0]?.message??"invalid aggregate query parameters");
    }

    if(new Date(result.data.until).getTime()<=new Date(result.data.since).getTime()){
        throw new Error("'until' must be greater than 'since'");
    }

    return{...result.data,attributes};
}