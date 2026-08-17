import {
    describe,
    expect,
    it,
} from "vitest";

import {
    authConfigFromEnvironment,
} from "../../src/config/auth.js";

describe("authConfigFromEnvironment", () => {
    it("disables authentication by default", () => {
        expect(
            authConfigFromEnvironment({})
        ).toEqual({
            enabled: false,
            apiKey: undefined,
        });
    });

    it("enables authentication when AUTH_ENABLED=true", () => {
        expect(
            authConfigFromEnvironment({
                AUTH_ENABLED: "true",
                API_KEY: "secret",
            })
        ).toEqual({
            enabled: true,
            apiKey: "secret",
        });
    });

    it("allows an API key while authentication is disabled", () => {
        expect(
            authConfigFromEnvironment({
                AUTH_ENABLED: "false",
                API_KEY: "secret",
            })
        ).toEqual({
            enabled: false,
            apiKey: "secret",
        });
    });

    it("rejects invalid AUTH_ENABLED values", () => {
        expect(() =>
            authConfigFromEnvironment({
                AUTH_ENABLED: "yes",
            })
        ).toThrow(
            "AUTH_ENABLED must be either 'true' or 'false'"
        );
    });

    it("requires API_KEY when authentication is enabled", () => {
        expect(() =>
            authConfigFromEnvironment({
                AUTH_ENABLED: "true",
            })
        ).toThrow(
            "API_KEY is required when AUTH_ENABLED=true"
        );
    });

    it("rejects an empty API key when authentication is enabled", () => {
        expect(() =>
            authConfigFromEnvironment({
                AUTH_ENABLED: "true",
                API_KEY: "",
            })
        ).toThrow(
            "API_KEY is required when AUTH_ENABLED=true"
        );
    });
});