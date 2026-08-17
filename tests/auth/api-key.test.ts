import {
    describe,
    expect,
    it,
    vi,
} from "vitest";

import {
    createApiKeyAuthHook,
} from "../../src/auth/api-key.js";

describe("API key authentication", () => {
    function createReply() {
        const send = vi.fn();
        const code = vi.fn(() => ({
            send,
        }));

        return {
            reply: {
                code,
            },
            code,
            send,
        };
    }

    it("accepts the correct API key", async () => {
        const hook =
            createApiKeyAuthHook(
                "super-secret-key"
            );

        const {
            reply,
            code,
        } = createReply();

        await hook(
            {
                headers: {
                    "x-api-key":
                        "super-secret-key",
                },
            } as never,
            reply as never
        );

        expect(code).not.toHaveBeenCalled();
    });

    it("rejects a missing API key", async () => {
        const hook =
            createApiKeyAuthHook(
                "super-secret-key"
            );

        const {
            reply,
            code,
            send,
        } = createReply();

        await hook(
            {
                headers: {},
            } as never,
            reply as never
        );

        expect(code).toHaveBeenCalledWith(
            401
        );

        expect(send).toHaveBeenCalledWith({
            error: "Unauthorized",
        });
    });

    it("rejects an incorrect API key", async () => {
        const hook =
            createApiKeyAuthHook(
                "super-secret-key"
            );

        const {
            reply,
            code,
            send,
        } = createReply();

        await hook(
            {
                headers: {
                    "x-api-key": "wrong-key",
                },
            } as never,
            reply as never
        );

        expect(code).toHaveBeenCalledWith(
            401
        );

        expect(send).toHaveBeenCalledWith({
            error: "Unauthorized",
        });
    });

    it("rejects a key with a different length", async () => {
        const hook =
            createApiKeyAuthHook(
                "super-secret-key"
            );

        const {
            reply,
            code,
        } = createReply();

        await hook(
            {
                headers: {
                    "x-api-key": "x",
                },
            } as never,
            reply as never
        );

        expect(code).toHaveBeenCalledWith(
            401
        );
    });
});