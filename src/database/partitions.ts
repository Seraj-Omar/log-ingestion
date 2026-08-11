import { pool } from "./pool.js";

function startOfUtcDay(date: Date): Date {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate()
        )
    );
}

function addDays(date: Date, days: number): Date {
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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${name}
        PARTITION OF logs
        FOR VALUES FROM ('${start.toISOString()}')
        TO ('${end.toISOString()}')
    `);
}

export async function ensureRollingPartitions(daysBack=30,daysAhead=1,referenceDate=new Date()):Promise<void>{
    const today=startOfUtcDay(referenceDate);

    for (let offset=-daysBack;offset<=daysAhead;offset++) {
        await ensureDailyPartition(addDays(today,offset));
    }
}
