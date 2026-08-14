const DEFAULT_MAX_IN_FLIGHT_INGESTIONS = 2_048;
const DEFAULT_MAX_IN_FLIGHT_INGESTION_LOGS = 50_000;
const DEFAULT_MAX_IN_FLIGHT_INGESTION_BYTES = 64 * 1024 * 1024;
const DEFAULT_INGESTION_BATCH_SIZE = 500;
const DEFAULT_INGESTION_BATCH_DELAY_MS = 10;

export interface IngestionConfig {
    maxInFlightIngestions:number;
    maxInFlightLogs:number;
    maxInFlightBytes:number;
    batchSize:number;
    batchDelayMs:number;
}

function positiveIntegerFromEnvironment(
    name:string,
    value:string|undefined,
    defaultValue:number
):number{
    if(value===undefined){
        return defaultValue;
    }

    const parsed=Number(value);

    if(!Number.isInteger(parsed)||parsed<=0){
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
}

function nonNegativeIntegerFromEnvironment(
    name:string,
    value:string|undefined,
    defaultValue:number
):number{
    if(value===undefined){
        return defaultValue;
    }

    const parsed=Number(value);

    if(!Number.isInteger(parsed)||parsed<0){
        throw new Error(`${name} must be a non-negative integer`);
    }

    return parsed;
}

export function maxInFlightIngestionsFromEnvironment(
    value:string|undefined=process.env.MAX_IN_FLIGHT_INGESTIONS
):number{
    return positiveIntegerFromEnvironment(
        "MAX_IN_FLIGHT_INGESTIONS",
        value,
        DEFAULT_MAX_IN_FLIGHT_INGESTIONS
    );
}

export function ingestionConfigFromEnvironment(
    environment:NodeJS.ProcessEnv=process.env
):IngestionConfig{
    return {
        maxInFlightIngestions:maxInFlightIngestionsFromEnvironment(
            environment.MAX_IN_FLIGHT_INGESTIONS
        ),
        maxInFlightLogs:positiveIntegerFromEnvironment(
            "MAX_IN_FLIGHT_INGESTION_LOGS",
            environment.MAX_IN_FLIGHT_INGESTION_LOGS,
            DEFAULT_MAX_IN_FLIGHT_INGESTION_LOGS
        ),
        maxInFlightBytes:positiveIntegerFromEnvironment(
            "MAX_IN_FLIGHT_INGESTION_BYTES",
            environment.MAX_IN_FLIGHT_INGESTION_BYTES,
            DEFAULT_MAX_IN_FLIGHT_INGESTION_BYTES
        ),
        batchSize:positiveIntegerFromEnvironment(
            "INGESTION_BATCH_SIZE",
            environment.INGESTION_BATCH_SIZE,
            DEFAULT_INGESTION_BATCH_SIZE
        ),
        batchDelayMs:nonNegativeIntegerFromEnvironment(
            "INGESTION_BATCH_DELAY_MS",
            environment.INGESTION_BATCH_DELAY_MS,
            DEFAULT_INGESTION_BATCH_DELAY_MS
        )
    };
}
