import { pool } from "../database/pool.js";
import type { ValidLog } from "../schemas/log.js";
import type { PoolClient,QueryResult } from "pg";

const COLUMN_COUNT=5;
const MAX_ROWS_PER_INSERT=10_000;

interface QueryExecutor {
    query:(text:string,values?:unknown[])=>Promise<QueryResult>;
}

async function insertLogChunk(
    executor:QueryExecutor,
    logs:readonly ValidLog[]
):Promise<void>{
    const values:unknown[]=[];

    const placeholders=logs.map((log,index)=>{
        const offset=index*COLUMN_COUNT;

        values.push(log.timestamp,log.level,log.service,log.message,JSON.stringify(log.attributes));
        return`($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5}::jsonb)`;
    });

    const sql=`
        INSERT INTO logs(timestamp,level,service,message,attributes)
        VALUES ${placeholders.join(",")}
    `;

    await executor.query(sql,values);
}

async function insertLogsTransactionally(
    client:PoolClient,
    logs:readonly ValidLog[]
):Promise<void>{
    await client.query("BEGIN");

    try{
        for(let offset=0;offset<logs.length;offset+=MAX_ROWS_PER_INSERT){
            await insertLogChunk(client,logs.slice(offset,offset+MAX_ROWS_PER_INSERT));
        }

        await client.query("COMMIT");
    }
    catch(error){
        await client.query("ROLLBACK").catch(()=>undefined);
        throw error;
    }
}

export async function insertLogs(logs:readonly ValidLog[]):Promise<void>{
    if(logs.length==0){
        return;
    }

    if(logs.length<=MAX_ROWS_PER_INSERT){
        await insertLogChunk(pool,logs);
        return;
    }

    const client=await pool.connect();

    try{
        await insertLogsTransactionally(client,logs);
    }
    finally{
        client.release();
    }
}
