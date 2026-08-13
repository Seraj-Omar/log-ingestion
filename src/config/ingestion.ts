const DEFAULT_MAX_IN_FLIGHT_INGESTIONS = 5;

export function maxInFlightIngestionsFromEnvironment(value:string|undefined=process.env.MAX_IN_FLIGHT_INGESTIONS):number{
    if (value===undefined) {
        return DEFAULT_MAX_IN_FLIGHT_INGESTIONS;
    }

    const maximum=Number(value);

    if (!Number.isInteger(maximum)||maximum <= 0){
        throw new Error("MAX_IN_FLIGHT_INGESTIONS must be a positive integer");
    }
    return maximum;
}
