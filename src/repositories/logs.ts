import { pool } from "../database/pool.js";
import type { ValidLog } from "../schemas/log.js";

const COLUMN_COUNT=5;

export async function insertLogs(logs:ValidLog[]):Promise<void>{
    if(logs.length==0){
        return;
    }

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

    await pool.query(sql,values);
}