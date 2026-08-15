type CounterName =
    | "ingestion_requests_total"
    | "logs_accepted_total"
    | "logs_rejected_total"
    | "ingestion_db_writes_total"
    | "ingestion_db_write_logs_total"
    | "query_requests_total"
    | "aggregation_requests_total";

type GaugeName =
    | "ingestion_in_flight_requests"
    | "ingestion_in_flight_logs"
    | "ingestion_in_flight_bytes";

type HistogramName =
    | "ingestion_db_write_duration_seconds"
    | "query_duration_seconds"
    | "aggregation_duration_seconds";

const HISTOGRAM_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Histogram {
    count:number;
    sum:number;
    buckets:number[];
}

export class Metrics {
    private readonly counters:Record<CounterName,number> = {
        ingestion_requests_total: 0,
        logs_accepted_total: 0,
        logs_rejected_total: 0,
        ingestion_db_writes_total: 0,
        ingestion_db_write_logs_total: 0,
        query_requests_total: 0,
        aggregation_requests_total: 0,
    };

    private readonly gauges: Record<GaugeName, number> = {
        ingestion_in_flight_requests: 0,
        ingestion_in_flight_logs: 0,
        ingestion_in_flight_bytes: 0,
    };

    private readonly histograms:Record<HistogramName,Histogram>={
        ingestion_db_write_duration_seconds: this.createHistogram(),
        query_duration_seconds: this.createHistogram(),
        aggregation_duration_seconds: this.createHistogram(),
    };

    incrementCounter(name:CounterName, amount=1):void{
        this.counters[name]+=amount;
    }

    setGauge(name:GaugeName, value:number):void{
        this.gauges[name] = value;
    }

    observeHistogram(name:HistogramName, valueSeconds:number):void{
        const histogram=this.histograms[name];

        histogram.count++;
        histogram.sum+=valueSeconds;

        for(const [index,bucket] of HISTOGRAM_BUCKETS.entries()){
            if(valueSeconds<=bucket){
                histogram.buckets[index]=(histogram.buckets[index]??0)+1;
            }
        }
    }

    render():string{
        const lines:string[]=[];

        for (const [name, value] of Object.entries(this.counters)) {
            lines.push(`# TYPE ${name} counter`);
            lines.push(`${name} ${value}`);
        }

        for (const [name, value] of Object.entries(this.gauges)) {
            lines.push(`# TYPE ${name} gauge`);
            lines.push(`${name} ${value}`);
        }

        for (const [name, histogram] of Object.entries(this.histograms)) {
            lines.push(`# TYPE ${name} histogram`);

            for (let i=0; i<HISTOGRAM_BUCKETS.length; i++) {
                lines.push(`${name}_bucket{le="${HISTOGRAM_BUCKETS[i]}"} ${histogram.buckets[i]}`,);
            }

            lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
            lines.push(`${name}_sum ${histogram.sum}`);
            lines.push(`${name}_count ${histogram.count}`);
        }

        const memory = process.memoryUsage();

        lines.push("# TYPE process_resident_memory_bytes gauge");
        lines.push(`process_resident_memory_bytes ${memory.rss}`);

        lines.push("# TYPE process_heap_used_bytes gauge");
        lines.push(`process_heap_used_bytes ${memory.heapUsed}`);

        lines.push("# TYPE process_uptime_seconds gauge");
        lines.push(`process_uptime_seconds ${process.uptime()}`);

        return `${lines.join("\n")}\n`;
    }

    private createHistogram():Histogram {
        return {count:0,sum:0,buckets:HISTOGRAM_BUCKETS.map(()=>0),};
    }
}

export const metrics = new Metrics();