import { describe, expect, it, vi } from "vitest";
import { LiveTail } from "../../src/live-tail/live-tail.js";

function validLog() {
    return {
        timestamp: new Date().toISOString(),
        level: "info" as const,
        service: "live-tail-test",
        message: "hello",
        attributes: {},
    };
}

describe("LiveTail", () => {
    it("publishes logs to subscribers", () => {
        const liveTail = new LiveTail();
        const subscriber = vi.fn();

        liveTail.subscribe(subscriber);

        const logs = [validLog()];

        liveTail.publish(logs);

        expect(subscriber).toHaveBeenCalledOnce();
        expect(subscriber).toHaveBeenCalledWith(logs);
    });

    it("supports multiple subscribers", () => {
        const liveTail = new LiveTail();

        const first = vi.fn();
        const second = vi.fn();

        liveTail.subscribe(first);
        liveTail.subscribe(second);

        const logs = [validLog()];

        liveTail.publish(logs);

        expect(first).toHaveBeenCalledWith(logs);
        expect(second).toHaveBeenCalledWith(logs);
        expect(liveTail.subscriberCount()).toBe(2);
    });

    it("unsubscribes a subscriber", () => {
        const liveTail = new LiveTail();
        const subscriber = vi.fn();

        const unsubscribe =
            liveTail.subscribe(subscriber);

        expect(liveTail.subscriberCount()).toBe(1);

        unsubscribe();

        expect(liveTail.subscriberCount()).toBe(0);

        liveTail.publish([validLog()]);

        expect(subscriber).not.toHaveBeenCalled();
    });

    it("does nothing when there are no subscribers", () => {
        const liveTail = new LiveTail();

        expect(() => {
            liveTail.publish([validLog()]);
        }).not.toThrow();
    });

    it("removes a subscriber that throws", () => {
        const liveTail = new LiveTail();

        liveTail.subscribe(() => {
            throw new Error("subscriber failed");
        });

        liveTail.publish([validLog()]);

        expect(liveTail.subscriberCount()).toBe(0);
    });
});