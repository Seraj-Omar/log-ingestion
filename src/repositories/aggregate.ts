import { pool } from "../database/pool.js";
import { buildAggregateQuery } from "../queries/aggregate.js";
import type { AggregateQueryFilters } from "../schemas/aggregate-query.js";

export interface AggregateRow{
    bucket:Date;
    group_value?:string;
    count:string;
}

export async function aggregateLogs(filters:AggregateQueryFilters):Promise<AggregateRow[]>{
    const query=buildAggregateQuery(filters);

    const result=await pool.query<AggregateRow>(query.text,query.values);

    return result.rows;
}