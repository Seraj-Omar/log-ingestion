import http, {
    type ClientRequest,
    type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";
import fastify, { type FastifyInstance } from "fastify";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { liveTail } from "../../src/live-tail/live-tail.js";
import { liveTailRoutes } from "../../src/routes/live-tail.js";

function validLog() {
    return {
        timestamp: new Date().toISOString(),
        level: "info" as const,
        service: "live-tail-test",
        message: "streamed event",
        attributes: {},
    };
}

describe("GET /logs/tail", () => {
    let app: FastifyInstance;
    let port: number;

    beforeEach(async () => {
        app = fastify();

        app.register(liveTailRoutes);

        await app.listen({
            host: "127.0.0.1",
            port: 0,
        });

        const address = app.server.address();

        if (
            address === null ||
            typeof address === "string"
        ) {
            throw new Error(
                "test server did not bind to a TCP port",
            );
        }

        port = (address as AddressInfo).port;
    });

    afterEach(async () => {
        await app.close();
    });

    it("streams logs as server-sent events and cleans up on disconnect", async () => {
        const subscribersBefore =
            liveTail.subscriberCount();

        let body = "";
        let response: IncomingMessage | undefined;
        let request: ClientRequest | undefined;

        const connected = new Promise<void>(
            (resolve, reject) => {
                request = http.get(
                    {
                        hostname: "127.0.0.1",
                        port,
                        path: "/logs/tail",
                    },
                    (incoming) => {
                        response = incoming;

                        incoming.setEncoding("utf8");

                        incoming.on("data", (chunk: string) => {
                            body += chunk;

                            if (
                                body.includes(
                                    ": connected\n\n",
                                )
                            ) {
                                resolve();
                            }
                        });

                        incoming.on("error", reject);
                    },
                );

                request.on("error", reject);
            },
        );

        await connected;

        expect(response?.statusCode).toBe(200);

        expect(
            response?.headers["content-type"],
        ).toContain("text/event-stream");

        expect(
            response?.headers["cache-control"],
        ).toBe("no-cache");

        expect(
            liveTail.subscriberCount(),
        ).toBe(subscribersBefore + 1);

        const log = validLog();

        liveTail.publish([log]);

        await vi.waitFor(() => {
            expect(body).toContain("event: logs\n");

            expect(body).toContain(
                `data: ${JSON.stringify({
                    logs: [log],
                })}\n\n`,
            );
        });

        response?.destroy();
        request?.destroy();

        await vi.waitFor(() => {
            expect(
                liveTail.subscriberCount(),
            ).toBe(subscribersBefore);
        });
    });
});