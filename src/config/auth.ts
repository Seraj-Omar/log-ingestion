export interface AuthConfig{
    enabled:boolean;
    apiKey?:string;
}

export function authConfigFromEnvironment(environment:NodeJS.ProcessEnv=process.env):AuthConfig{
    const rawEnabled=environment.AUTH_ENABLED;

    if(rawEnabled!==undefined&&rawEnabled!=="true"&&rawEnabled!="false"){
        throw new Error("AUTH_ENABLED must be either 'true' or 'false'");
    }

    const enabled=rawEnabled==="true";
    const apiKey=environment.API_KEY;

    if(enabled&&(!apiKey||apiKey.length===0)){
        throw new Error("API_KEY is required when AUTH_ENABLED=true");
    }

    return{enabled,apiKey};
}