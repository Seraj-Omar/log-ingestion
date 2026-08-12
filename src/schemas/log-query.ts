import z from "zod";
import { logLevels } from "./log.js";

export interface LogQueryFilters{
    service?:string;
    level?:(typeof logLevels)[number];
    since?:string;
    until?:string;
    q?:string;
    limit:number;
    cursor?:string;
    attributes:Record<string,string>;
}

const baseQuerySchema = z.object({
    service: z.string().optional(),

    level:z.enum(logLevels, {error: "invalid level filter"}).optional(),

    since:z.string().datetime({offset: true,error: "invalid since timestamp"}).optional(),

    until:z.string().datetime({offset: true,error: "invalid until timestamp"}).optional(),

    q:z.string().optional(),

    limit:z.coerce.number({error: "invalid limit"}).int("invalid limit")
        .min(1, "limit must be at least 1")
        .max(1000, "limit must not exceed 1000").default(100),

    cursor:z.string().min(1, "invalid cursor").optional()
});

export function parseLogQuery(rawQuery:Record<string,unknown>):LogQueryFilters{
    const attributes:Record<string,string>={};
    const base:Record<string,unknown>={};

    for(const [key,value] of Object.entries(rawQuery)){
        if(key.startsWith("attr.")){
            const attributeKey=key.slice(5);//5 is attr. length

            if(attributeKey.length==0||typeof value!="string"){
                throw new Error(`invalid attribute filter: '${key}'`);
            }

            attributes[attributeKey]=value;
        }
        base[key]=value;
    }

    const result=baseQuerySchema.safeParse(base);

    if(!result.success){
        throw new Error(formatQueryError(result.error));
    }

    if(result.data.since&&result.data.until&&new Date(result.data.until).getTime()<=new Date(result.data.since).getTime()){
        throw new Error("'until' must be greater than 'since'");
    }

    return{...result.data, limit:result.data.limit, attributes};
}

function formatQueryError(error:z.ZodError):string{
    return error.issues[0]?.message??"invalid query parameters";
}