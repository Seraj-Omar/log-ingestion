import { buildApp } from "./app.js";
import { markReady } from "./config/readiness.js";
import { pool } from "./database/pool.js";
import { prepareDatabase } from "./database/startup.js";

const host = process.env.HOST ?? '0.0.0.0';
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

export async function startServer():Promise<void>{
    const app=buildApp();
    let shuttingDown=false;

    const shutdown=async():Promise<void>=>{
        if(shuttingDown){
            return;
        }

        shuttingDown=true;

        let cleanupFailed=false;

        await app.close().catch((error:unknown)=>{
            cleanupFailed=true;
            app.log.error(error);
        });
        await pool.end().catch((error:unknown)=>{
            cleanupFailed=true;
            app.log.error(error);
        });

        if(cleanupFailed){
            process.exitCode=1;
        }
    };

    const handleSignal=():void=>{
        void shutdown();
    };

    try{
        await prepareDatabase();
        markReady();
        await app.listen({port,host});
        process.on("SIGINT",handleSignal);
        process.on("SIGTERM",handleSignal);
    }
    catch(error){
        await app.close().catch((closeError:unknown)=>{
            app.log.error(closeError);
        });
        await pool.end().catch((poolError:unknown)=>{
            app.log.error(poolError);
        });
        throw error;
    }
}

startServer();
