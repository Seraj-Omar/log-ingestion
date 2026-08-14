import type { LogQueryFilters } from "../schemas/log-query.js";
import type { LogCursor } from "../utils/cursor.js";
import { escapeLikePattern } from "../utils/like-pattern.js";

export interface BuiltLogQuery {
    text:string;
    values:unknown[];
}

export function buildLogQuery(filters:LogQueryFilters,cursor?:LogCursor):BuiltLogQuery {
    const conditions:string[]=[];
    const values:unknown[]=[];

    const addValue=(value:unknown):string=>{
        values.push(value);
        return `$${values.length}`;
    };

    if(filters.service!==undefined){
        const p=addValue(filters.service);
        conditions.push(`service = ${p}`);
    }

    if(filters.level!==undefined){
        const p=addValue(filters.level);
        conditions.push(`level = ${p}`);
    }

    if(filters.since!==undefined){
        const p=addValue(filters.since);
        conditions.push(`timestamp >= ${p}`);
    }

    if(filters.until!==undefined){
        const p=addValue(filters.until);
        conditions.push(`timestamp < ${p}`);
    }

    for(const [key,value] of Object.entries(filters.attributes)){
        const keyParam=addValue(key);
        const valueParam=addValue(value);

        conditions.push(`attributes ->> ${keyParam} = ${valueParam}`);
    }

    if(filters.q!==undefined){
        const p=addValue(`%${escapeLikePattern(filters.q)}%`);
        conditions.push(`message ILIKE ${p} ESCAPE '\\'`);
    }

    if(cursor!==undefined){
        const timestampParam=addValue(cursor.timestamp);
        const idParam=addValue(cursor.id);

        conditions.push(`(timestamp, id) < (${timestampParam}, ${idParam})`);
    }

    const limitParam=addValue(filters.limit+1);

    const where=conditions.length>0
        ?`WHERE ${conditions.join(" AND ")}`
        :"";

    const baseSelect=`
        SELECT
            id,
            timestamp,
            level,
            service,
            message,
            attributes
        FROM logs
        ${where}
    `;

    const shouldFilterBeforeOrdering=
        filters.service===undefined&&
        filters.q!==undefined;

    const from=shouldFilterBeforeOrdering
        ?`SELECT * FROM (${baseSelect} OFFSET 0) AS filtered_logs`
        :baseSelect;

    const text=`
        ${from}
        ORDER BY timestamp DESC, id DESC
        LIMIT ${limitParam}
    `.trim();

    return {text,values};
}
