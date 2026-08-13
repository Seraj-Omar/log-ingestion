import type { AggregateQueryFilters,AggregateBucket } from "../schemas/aggregate-query.js";

export interface BuiltAggregateQuery{
    text:string;
    values:unknown[];
}

function bucketInterval(bucket:AggregateBucket):string{
    switch(bucket){
        case "1m":
            return "1 minute";
        case "5m":
            return "5 minutes";
        case "1h":
            return "1 hour";
        case "1d":
            return "1 day";
    }
}

export function buildAggregateQuery(filters:AggregateQueryFilters):BuiltAggregateQuery{
    const conditions:string[]=[];
    const values:unknown[]=[];

    const addValue=(value:unknown):string=>{
        values.push(value);
        return `$${values.length}`;
    }

    const sinceParam=addValue(filters.since);
    const untilParam=addValue(filters.until);

    conditions.push(`timestamp >= ${sinceParam}`);
    conditions.push(`timestamp < ${untilParam}`);

    if(filters.service!==undefined){
        const p=addValue(filters.service);
        conditions.push(`service = ${p}`);
    }

    if(filters.level!==undefined){
        const p=addValue(filters.level);
        conditions.push(`level = ${p}`);
    }

    for(const [key,value] of Object.entries(filters.attributes)){
        const keyParam=addValue(key);
        const valueParam=addValue(value);

        conditions.push(`COALESCE(attributes ->> ${keyParam} = ${valueParam}, FALSE)`);
    }

    if(filters.q!==undefined){
        const p=addValue(`%${filters.q}%`);
        conditions.push(`message ILIKE ${p}`);
    }

    const interval=bucketInterval(filters.bucket);

    const selectParts=[
        `date_bin('${interval}',timestamp,TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket`,
        `COUNT(*)::BIGINT AS count`
    ];

    const groupParts=["bucket"];

    if(filters.group_by!==undefined){
        selectParts.splice(1,0,`${filters.group_by} AS group_value`);
        groupParts.push(filters.group_by);
    }

    const text=`
        SELECT
            ${selectParts.join(",\n            ")}
        FROM logs
        WHERE ${conditions.join(" AND ")}
        GROUP BY ${groupParts.join(", ")}
        ORDER BY bucket ASC
    `.trim();

    return {text,values};
}
