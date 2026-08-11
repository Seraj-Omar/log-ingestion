import { Pool } from "pg";
import { databaseConfig } from "../config/database.js";

export const pool = new Pool({
    host: databaseConfig.host,
    port: databaseConfig.port,
    database: databaseConfig.database,
    user: databaseConfig.user,
    password: databaseConfig.password,
    max: 5,
});

export async function checkDatabaseConnection():Promise<void>{
    await pool.query("select 1");
}