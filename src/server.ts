import { buildApp } from "./app.js";

const host = process.env.HOST ?? '0.0.0.0';
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

export async function startServer():Promise<void>{
    const app=buildApp();
    try{
        await app.listen({port,host});
    }
    catch(error){
        await app.close();
        throw error;
    }
}

void startServer();