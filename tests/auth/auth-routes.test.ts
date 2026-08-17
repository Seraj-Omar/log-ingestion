import {
    afterEach,
    describe,
    expect,
    it,
} from "vitest";

import {
    buildApp,
} from "../../src/app.js";

describe("API authentication routes", () => {
    afterEach(() => {
        delete process.env.AUTH_ENABLED;
        delete process.env.API_KEY;
    });

    it("keeps authentication disabled by default", async () => {
        const app = buildApp({
            authEnabled: false,
        });

        const response =
            await app.inject({
                method: "POST",
                url: "/logs",
                payload: {},
            });

        expect(
            response.statusCode
        ).not.toBe(401);

        await app.close();
    });

    it("rejects protected routes without an API key", async () => {
        const app = buildApp({
            authEnabled: true,
            apiKey: "secret",
        });

        const response =
            await app.inject({
                method: "POST",
                url: "/logs",
                payload: {},
            });

        expect(
            response.statusCode
        ).toBe(401);

        expect(
            response.json()
        ).toEqual({
            error: "Unauthorized",
        });

        await app.close();
    });

    it("rejects protected routes with the wrong API key", async () => {
        const app = buildApp({
            authEnabled: true,
            apiKey: "secret",
        });

        const response =
            await app.inject({
                method: "POST",
                url: "/logs",
                headers: {
                    "x-api-key": "wrong",
                },
                payload: {},
            });

        expect(
            response.statusCode
        ).toBe(401);

        await app.close();
    });

    it("allows a valid API key through authentication", async () => {
        const app = buildApp({
            authEnabled: true,
            apiKey: "secret",
        });

        const response =
            await app.inject({
                method: "POST",
                url: "/logs",
                headers: {
                    "x-api-key": "secret",
                },
                payload: {},
            });

        // Authentication passed.
        // The malformed request is then rejected
        // by the normal POST /logs validation.
        expect(
            response.statusCode
        ).toBe(400);

        await app.close();
    });

    it("keeps metrics public when authentication is enabled", async () => {
        const app = buildApp({
            authEnabled: true,
            apiKey: "secret",
        });

        const response =
            await app.inject({
                method: "GET",
                url: "/metrics",
            });

        expect(
            response.statusCode
        ).toBe(200);

        await app.close();
    });
});