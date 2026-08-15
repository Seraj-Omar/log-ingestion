import type { FastifyInstance } from "fastify";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from "vitest";

vi.mock(
    "../../src/services/ingest-logs.js",
    () => ({
        ingestLogs: vi.fn()
    })
);

import { buildApp } from "../../src/app.js";
import { ingestLogs } from "../../src/services/ingest-logs.js";

const ingestLogsMock = vi.mocked(ingestLogs);

function metricValue(
    body: string,
    name: string
): number {
    const line = body
        .split("\n")
        .find((candidate) =>
            candidate.startsWith(`${name} `)
        );

    if (line === undefined) {
        throw new Error(
            `metric '${name}' was not found`
        );
    }

    const value = Number(
        line.slice(name.length + 1)
    );

    if (!Number.isFinite(value)) {
        throw new Error(
            `metric '${name}' does not contain a numeric value`
        );
    }

    return value;
}

function validLog(
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        timestamp: new Date().toISOString(),
        level: "info",
        service: "metrics-test",
        message: "metrics event",
        attributes: {
            user_id: "42"
        },
        ...overrides
    };
}

describe("GET /metrics", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        ingestLogsMock.mockReset();
        ingestLogsMock.mockResolvedValue(undefined);

        app = buildApp({
            ingestionBatchDelayMs: 0
        });

        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    it("returns Prometheus metrics", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/metrics"
        });

        expect(response.statusCode).toBe(200);

        expect(
            response.headers["content-type"]
        ).toContain("text/plain");

        expect(response.body).toContain(
            "# TYPE ingestion_requests_total counter"
        );

        expect(response.body).toContain(
            "# TYPE ingestion_in_flight_logs gauge"
        );

        expect(response.body).toContain(
            "# TYPE ingestion_db_write_duration_seconds histogram"
        );

        expect(response.body).toContain(
            "# TYPE process_resident_memory_bytes gauge"
        );
    });

    it("exposes ingestion activity", async () => {
        const beforeResponse = await app.inject({
            method: "GET",
            url: "/metrics"
        });

        const beforeRequests = metricValue(
            beforeResponse.body,
            "ingestion_requests_total"
        );

        const beforeAccepted = metricValue(
            beforeResponse.body,
            "logs_accepted_total"
        );

        const beforeRejected = metricValue(
            beforeResponse.body,
            "logs_rejected_total"
        );

        const beforeWrites = metricValue(
            beforeResponse.body,
            "ingestion_db_writes_total"
        );

        const beforeWriteLogs = metricValue(
            beforeResponse.body,
            "ingestion_db_write_logs_total"
        );

        const response = await app.inject({
            method: "POST",
            url: "/logs",
            payload: {
                logs: [
                    validLog(),
                    validLog({
                        level: "critical"
                    })
                ]
            }
        });

        expect(response.statusCode).toBe(200);

        const afterResponse = await app.inject({
            method: "GET",
            url: "/metrics"
        });

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_requests_total"
            )
        ).toBe(beforeRequests + 1);

        expect(
            metricValue(
                afterResponse.body,
                "logs_accepted_total"
            )
        ).toBe(beforeAccepted + 1);

        expect(
            metricValue(
                afterResponse.body,
                "logs_rejected_total"
            )
        ).toBe(beforeRejected + 1);

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_db_writes_total"
            )
        ).toBe(beforeWrites + 1);

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_db_write_logs_total"
            )
        ).toBe(beforeWriteLogs + 1);

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_in_flight_requests"
            )
        ).toBe(0);

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_in_flight_logs"
            )
        ).toBe(0);

        expect(
            metricValue(
                afterResponse.body,
                "ingestion_in_flight_bytes"
            )
        ).toBe(0);
    });
});