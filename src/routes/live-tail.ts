import type { FastifyInstance } from "fastify";
import { liveTail } from "../live-tail/live-tail.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function liveTailRoutes(app: FastifyInstance): Promise<void> {
    app.get("/logs/tail", async (_request, reply) => {
        reply.hijack();

        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });

        reply.raw.write(": connected\n\n");

        let closed = false;
        let backpressured = false;
        let unsubscribe: () => void = () => {};
        let heartbeat: NodeJS.Timeout | undefined=undefined;

        const cleanup = (): void => {
            if (closed) {
                return;
            }

            closed = true;
            if (heartbeat !== undefined) {
                clearInterval(heartbeat);
            }
            unsubscribe();
        };

        reply.raw.on("drain", () => {backpressured = false;});

        unsubscribe = liveTail.subscribe((logs) => {
            if (closed ||reply.raw.destroyed ||reply.raw.writableEnded) {
                cleanup();
                return;
            }

            if (backpressured) {
                return;
            }

            const event =`event: logs\n` + `data: ${JSON.stringify({ logs })}\n\n`;
            const writable = reply.raw.write(event);

            if (!writable) {
                backpressured = true;
            }
        });

        heartbeat = setInterval(() => {
            if (closed ||reply.raw.destroyed ||reply.raw.writableEnded){
                cleanup();
                return;
            }

            if (backpressured) {
                return;
            }

            const writable =reply.raw.write(": heartbeat\n\n");
            
            if (!writable) {
                backpressured = true;
            }
        }, HEARTBEAT_INTERVAL_MS);

        reply.raw.on("close", cleanup);
        reply.raw.on("error", cleanup);
    });
}