import { describe, expect, it } from "vitest";
import { Metrics } from "../../src/metrics/metrics.js";

describe("Metrics", () => {
    it("increments counters", () => {
        const metrics = new Metrics();

        metrics.incrementCounter(
            "logs_accepted_total",
            5
        );

        metrics.incrementCounter(
            "logs_accepted_total",
            3
        );

        const rendered = metrics.render();

        expect(rendered).toContain(
            "logs_accepted_total 8"
        );
    });

    it("updates gauges", () => {
        const metrics = new Metrics();

        metrics.setGauge(
            "ingestion_in_flight_logs",
            500
        );

        expect(metrics.render()).toContain(
            "ingestion_in_flight_logs 500"
        );

        metrics.setGauge(
            "ingestion_in_flight_logs",
            100
        );

        expect(metrics.render()).toContain(
            "ingestion_in_flight_logs 100"
        );
    });

    it("records cumulative histogram buckets", () => {
        const metrics = new Metrics();

        metrics.observeHistogram(
            "query_duration_seconds",
            0.02
        );

        const rendered = metrics.render();

        expect(rendered).toContain(
            'query_duration_seconds_bucket{le="0.01"} 0'
        );

        expect(rendered).toContain(
            'query_duration_seconds_bucket{le="0.025"} 1'
        );

        expect(rendered).toContain(
            'query_duration_seconds_bucket{le="0.05"} 1'
        );

        expect(rendered).toContain(
            'query_duration_seconds_bucket{le="+Inf"} 1'
        );

        expect(rendered).toContain(
            "query_duration_seconds_count 1"
        );

        expect(rendered).toContain(
            "query_duration_seconds_sum 0.02"
        );
    });

    it("records multiple histogram observations", () => {
        const metrics = new Metrics();

        metrics.observeHistogram(
            "aggregation_duration_seconds",
            0.005
        );

        metrics.observeHistogram(
            "aggregation_duration_seconds",
            0.03
        );

        const rendered = metrics.render();

        expect(rendered).toContain(
            "aggregation_duration_seconds_count 2"
        );

        expect(rendered).toContain(
            'aggregation_duration_seconds_bucket{le="0.005"} 1'
        );

        expect(rendered).toContain(
            'aggregation_duration_seconds_bucket{le="0.05"} 2'
        );
    });

    it("renders Prometheus metric types", () => {
        const metrics = new Metrics();

        const rendered = metrics.render();

        expect(rendered).toContain(
            "# TYPE ingestion_requests_total counter"
        );

        expect(rendered).toContain(
            "# TYPE ingestion_in_flight_logs gauge"
        );

        expect(rendered).toContain(
            "# TYPE query_duration_seconds histogram"
        );
    });

    it("includes process metrics", () => {
        const metrics = new Metrics();

        const rendered = metrics.render();

        expect(rendered).toContain(
            "# TYPE process_resident_memory_bytes gauge"
        );

        expect(rendered).toContain(
            "# TYPE process_heap_used_bytes gauge"
        );

        expect(rendered).toContain(
            "# TYPE process_uptime_seconds gauge"
        );
    });
});