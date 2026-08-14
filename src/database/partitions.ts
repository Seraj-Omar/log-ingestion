import { pool } from "./pool.js";

const knownPartitions=new Set<string>();
const partitionOperations=new Map<string,Promise<void>>();
const PARTITION_NAME_PATTERN=/^logs_\d{4}_\d{2}_\d{2}$/;

async function runPartitionOperation(name:string,operation:()=>Promise<void>):Promise<void>{
    const previous=partitionOperations.get(name);
    const current=previous===undefined
        ?operation()
        :previous.catch(()=>undefined).then(operation);

    partitionOperations.set(name,current);

    try{
        await current;
    }
    finally{
        if(partitionOperations.get(name)===current){
            partitionOperations.delete(name);
        }
    }
}

export function startOfUtcDay(date: Date): Date {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate()
        )
    );
}

export function addDays(date: Date, days: number): Date {
    const result=new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function partitionName(date: Date): string {
    const year=date.getUTCFullYear();
    const month=String(date.getUTCMonth()+1).padStart(2, "0");
    const day=String(date.getUTCDate()).padStart(2, "0");

    return `logs_${year}_${month}_${day}`;
}

export async function ensureDailyPartition(date: Date): Promise<void> {
    const start=startOfUtcDay(date);
    const end=addDays(start,1);

    const name=partitionName(start);

    if(knownPartitions.has(name)&&!partitionOperations.has(name)){
        return;
    }

    await runPartitionOperation(name,async()=>{
        if(knownPartitions.has(name)){
            return;
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS ${name}
            PARTITION OF logs
            FOR VALUES FROM ('${start.toISOString()}')
            TO ('${end.toISOString()}')
            WITH (
                autovacuum_vacuum_insert_scale_factor = 0.005,
                autovacuum_vacuum_insert_threshold = 10000,
                autovacuum_analyze_scale_factor = 0.01,
                autovacuum_analyze_threshold = 10000
            )
        `);

        knownPartitions.add(name);
    });
}

export async function dropDailyPartition(name:string):Promise<void>{
    if(!PARTITION_NAME_PATTERN.test(name)){
        throw new Error("invalid daily partition name");
    }

    await runPartitionOperation(name,async()=>{
        await pool.query(`DROP TABLE IF EXISTS "${name}"`);
        knownPartitions.delete(name);
    });
}

export function forgetKnownPartition(name:string):void{
    knownPartitions.delete(name);
}

export async function ensurePartitionsForTimestamps(timestamps:readonly string[]):Promise<void>{
    const uniqueDays=new Map<string,Date>();

    for(const timestamp of timestamps){
        const date=new Date(timestamp);
        const start=startOfUtcDay(date);
        const name=partitionName(start);

        if(!uniqueDays.has(name)){
            uniqueDays.set(name,start);
        }
    }

    for(const date of uniqueDays.values()){
        await ensureDailyPartition(date);
    }
}
export async function ensureRollingPartitions(daysBack=30,daysAhead=1,referenceDate=new Date()):Promise<void>{
    const today=startOfUtcDay(referenceDate);

    for (let offset=-daysBack;offset<=daysAhead;offset++) {
        await ensureDailyPartition(addDays(today,offset));
    }
}
