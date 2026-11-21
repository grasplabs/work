import { describe, expect, it } from "vite-plus/test";

import { localConfig } from "./wrangler-local-config.ts";

// Connect's local config under `vp run dev`: wrangler binds a second
// Worker only the `.dev.vars` keys its config names, so the local config
// must name every one connect's `.dev.vars` sets, and never their values.

const connect = {
  name: "grasp-os-connect",
  main: "src/index.ts",
  vars: { RUNTIME_PROFILE: "cloudflare" },
  secrets: { required: ["CAPABILITY_SIGNING_KEY", "TOKEN_ENCRYPTION_KEY"] },
};

const added = { DURABLE_OBJECT_JURISDICTION: "none" };

describe(localConfig, () => {
  it("requires every secret .dev.vars sets, by name alone", () => {
    const devVars = [
      "# Local only.",
      "CAPABILITY_SIGNING_KEY=local-signing-value",
      "TOKEN_ENCRYPTION_KEY=local-sealing-value",
      "COMPOSIO_API_KEY=local-composio-value",
      "OPENAI_API_KEY=",
    ].join("\n");
    const local = localConfig(connect, { added, devMain: undefined, devVars });
    expect(local).toStrictEqual({
      ...connect,
      vars: {
        RUNTIME_PROFILE: "cloudflare",
        DURABLE_OBJECT_JURISDICTION: "none",
      },
      secrets: {
        required: [
          "CAPABILITY_SIGNING_KEY",
          "TOKEN_ENCRYPTION_KEY",
          "COMPOSIO_API_KEY",
          "OPENAI_API_KEY",
        ],
      },
    });
    expect(JSON.stringify(local)).not.toContain("local-");
  });

  it("keeps the config's required secrets when .dev.vars sets only some, or is missing", () => {
    const partial = localConfig(connect, {
      added,
      devMain: undefined,
      devVars: "COMPOSIO_API_KEY=local-composio-value\n",
    });
    expect(Reflect.get(partial, "secrets")).toStrictEqual({
      required: [
        "CAPABILITY_SIGNING_KEY",
        "TOKEN_ENCRYPTION_KEY",
        "COMPOSIO_API_KEY",
      ],
    });
    const missing = localConfig(connect, {
      added,
      devMain: undefined,
      devVars: undefined,
    });
    expect(Reflect.get(missing, "secrets")).toStrictEqual(connect.secrets);
  });

  it("reads the first key of a .dev.vars saved with a BOM", () => {
    const local = localConfig(connect, {
      added,
      devMain: undefined,
      devVars: "\uFEFFCOMPOSIO_API_KEY=local-composio-value\n",
    });
    expect(Reflect.get(local, "secrets")).toStrictEqual({
      required: [
        "CAPABILITY_SIGNING_KEY",
        "TOKEN_ENCRYPTION_KEY",
        "COMPOSIO_API_KEY",
      ],
    });
  });

  it("leaves a key that is a var to the vars, as wrangler refuses one name as both", () => {
    const local = localConfig(connect, {
      added,
      devMain: undefined,
      devVars: "DURABLE_OBJECT_JURISDICTION=eu\nRUNTIME_PROFILE=workerd\n",
    });
    expect(Reflect.get(local, "secrets")).toStrictEqual(connect.secrets);
    expect(Reflect.get(local, "vars")).toStrictEqual({
      RUNTIME_PROFILE: "cloudflare",
      DURABLE_OBJECT_JURISDICTION: "none",
    });
  });

  it("runs the dev entry instead of the Worker's own when one is named", () => {
    const local = localConfig(connect, {
      added,
      devMain: "/repo/apps/connect/test/dev-entry.ts",
      devVars: undefined,
    });
    expect(Reflect.get(local, "main")).toBe(
      "/repo/apps/connect/test/dev-entry.ts"
    );
  });
});
