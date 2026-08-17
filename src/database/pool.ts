import { Client,Pool } from "pg";
import { databaseConfig } from "../config/database.js";

export const pool = new Pool({
    host: databaseConfig.host,
    port: databaseConfig.port,
    database: databaseConfig.database,
    user: databaseConfig.user,
    password: databaseConfig.password,
    max: 3,
});

export async function checkDatabaseConnection():Promise<void>{
    const client=new Client({
        host:databaseConfig.host,
        port:databaseConfig.port,
        database:databaseConfig.database,
        user:databaseConfig.user,
        password:databaseConfig.password,
        connectionTimeoutMillis:1000,
        query_timeout:1000
    });

    try{
        await client.connect();
        await client.query("select 1");
    }
    finally{
        await client.end().catch(()=>undefined);
    }
}