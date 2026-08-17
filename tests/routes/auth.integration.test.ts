import type { FastifyInstance } from "fastify";
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { buildApp } from "../../src/app.js";
import {
    markNotReady,
    markReady,
} from "../../src/config/readiness.js";
import {
    ensureDailyPartition,
} from "../../src/database/partitions.js";
import { pool } from "../../src/database/pool.js";

const API_KEY = "integration-secret-key";
const testService = "integration-auth-test";

let publicApp: FastifyInstance;
let protectedApp: FastifyInstance;

function validLog(): Record<string, unknown> {
    return {
        timestamp: new Date().toISOString(),
        level: "info",
        service: testService,
        message: "authenticated persistence test",
        attributes: {
            test: true,
        },
    };
}

async function deleteTestRows(): Promise<void> {
    await pool.query(
        "DELETE FROM logs WHERE service = $1",
        [testService]
    );
}

describe("API-key authentication integration", () => {
    beforeAll(async () => {
        await ensureDailyPartition(new Date());
        await deleteTestRows();

        markReady();

        publicApp = buildApp({
            authEnabled: false,
        });

        protectedApp = buildApp({
            authEnabled: true,
            apiKey: API_KEY,
        });

        await publicApp.ready();
        await protectedApp.ready();
    });

    afterAll(async () => {
        await publicApp.close();
        await protectedApp.close();

        markNotReady();

        await deleteTestRows();
        await pool.end();
    });

    it("keeps required API routes accessible when authentication is disabled", async () => {
        const response = await publicApp.inject({
            method: "POST",
            url: "/logs",
            payload: {},
        });

        // Authentication is disabled, so the request
        // reaches the normal request validation layer.
        expect(response.statusCode).toBe(400);
    });

    it("rejects protected routes when the API key is missing", async () => {
        const response = await protectedApp.inject({
            method: "GET",
            url: "/logs",
        });

        expect(response.statusCode).toBe(401);

        expect(response.json()).toEqual({
            error: "Unauthorized",
        });
    });

    it("rejects protected routes when the API key is incorrect", async () => {
        const response = await protectedApp.inject({
            method: "GET",
            url: "/logs",
            headers: {
                "x-api-key": "wrong-key",
            },
        });

        expect(response.statusCode).toBe(401);

        expect(response.json()).toEqual({
            error: "Unauthorized",
        });
    });

    it("allows a valid API key and persists the log", async () => {
        const response = await protectedApp.inject({
            method: "POST",
            url: "/logs",
            headers: {
                "x-api-key": API_KEY,
            },
            payload: {
                logs: [
                    validLog(),
                ],
            },
        });

        expect(response.statusCode).toBe(200);

        expect(response.json()).toEqual({
            accepted: 1,
            rejected: [],
        });

        const stored = await pool.query<{
            service: string;
            message: string;
        }>(
            `
                SELECT service, message
                FROM logs
                WHERE service = $1
            `,
            [testService]
        );

        expect(stored.rows).toHaveLength(1);

        expect(stored.rows[0]).toEqual({
            service: testService,
            message: "authenticated persistence test",
        });
    });

    it("allows authenticated reads", async () => {
        const response = await protectedApp.inject({
            method: "GET",
            url: `/logs?service=${testService}`,
            headers: {
                "x-api-key": API_KEY,
            },
        });

        expect(response.statusCode).toBe(200);

        const body = response.json<{
            logs: Array<{
                service: string;
            }>;
        }>();

        expect(body.logs).toHaveLength(1);
        expect(body.logs[0]?.service).toBe(
            testService
        );
    });

    it("keeps health public when authentication is enabled", async () => {
        const response = await protectedApp.inject({
            method: "GET",
            url: "/health",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            status: "ok",
        });
    });

    it("keeps metrics public when authentication is enabled", async () => {
        const response = await protectedApp.inject({
            method: "GET",
            url: "/metrics",
        });

        expect(response.statusCode).toBe(200);

        expect(
            response.headers["content-type"]
        ).toContain("text/plain");
    });
});