import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import {
  modelTransportReportPath,
  modelTransportReportPurpose,
  modelTransportReportSchema,
} from "@grasp-os/shared/model-transport-report";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { modelTransportReportResponse } from "../src/model-transport-report.ts";
import { answeringGateway } from "./ai-gateway.ts";
import { routed } from "./sign-in.ts";

// The deployment's model transport, for the admin: what Setup shows and
// the hosting policy's AI check reads. The ways it can fail, tried first:
// anyone but the admin reading it, a key's value in the answer, and a
// route said to run where it doesn't.

/** `body`'s signature as the admin makes it. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET
): Promise<string> => {
  const key = await hkdfHmacKey(secret, modelTransportReportPurpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** A signed request for the report, as the admin sends it. */
const signedRequest = async (body: string): Promise<Request> =>
  new Request(`https://core.test${modelTransportReportPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: await signatureOf(body),
    },
    body,
  });

describe("the deployment's model transport, for the admin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses anyone but the admin", async () => {
    const body = JSON.stringify({ sentAt: new Date().toISOString() });
    const statuses = await Promise.all([
      routed(modelTransportReportPath, { method: "POST", body }),
      routed(modelTransportReportPath, {
        method: "POST",
        headers: {
          [platformUpdateSignatureHeader]: await signatureOf(
            body,
            "another-secret"
          ),
        },
        body,
      }),
    ]);

    expect(statuses.map(({ status }) => status)).toStrictEqual([403, 403]);
  });

  it("answers with today's transport, AI Gateway, and where each allowed model runs", async () => {
    const body = JSON.stringify({ sentAt: new Date().toISOString() });
    const response = await routed(modelTransportReportPath, {
      method: "POST",
      headers: { [platformUpdateSignatureHeader]: await signatureOf(body) },
      body,
    });
    const report = modelTransportReportSchema.parse(await response.json());

    expect(report).toMatchObject({
      valid: true,
      residency: "global",
      primary: "cloudflare-ai-gateway",
      failover: [],
      probe: null,
    });
    expect(
      report.routes.every(
        ({ transport }) => transport === "cloudflare-ai-gateway"
      )
    ).toBeTruthy();
  });

  it("probes an EU organization's route through the gateway, and names the keys it lacks, never a key", async () => {
    const fake = answeringGateway(() => ({
      text: "OK",
      inputTokens: 20,
      outputTokens: 1,
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.binding.fetch);
    const euEnv = {
      ...env,
      MODEL_GATEWAY: {
        models: ["bedrock-eu/claude-sonnet-5-5", "anthropic/claude-sonnet-4-5"],
      },
      MODEL_TRANSPORT: {
        primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
        failover: [{ kind: "openrouter", key: "openrouter" }],
        residency: "eu",
      },
      MODEL_PROVIDER_KEYS: JSON.stringify({ "bedrock-eu": "test-bedrock-key" }),
    };
    const body = JSON.stringify({
      sentAt: new Date().toISOString(),
      probe: true,
      staff: "staff@grasp.test",
    });

    const response = await modelTransportReportResponse(
      await signedRequest(body),
      euEnv,
      "request-1"
    );
    const text = await response.text();
    const report = modelTransportReportSchema.parse(JSON.parse(text));

    expect(report).toMatchObject({
      residency: "eu",
      primary: "direct",
      failover: ["openrouter"],
      missingKeys: ["openrouter"],
      routes: [
        {
          model: "bedrock-eu/claude-sonnet-5-5",
          transport: "direct",
          host: "bedrock-mantle.eu-central-1.api.aws",
          route: "direct/bedrock-eu",
          region: "eu-central-1",
          allowed: true,
        },
        // Reachable by no transport in force: no key for OpenRouter, and
        // none of the others reaches it.
        { model: "anthropic/claude-sonnet-4-5", allowed: false },
      ],
      probe: {
        model: "bedrock-eu/claude-sonnet-5-5",
        ok: true,
        error: null,
        transport: "direct",
        region: "eu-central-1",
      },
    });
    expect(fake.requests.map(({ url }) => new URL(url).hostname)).toStrictEqual(
      ["bedrock-mantle.eu-central-1.api.aws"]
    );
    expect(text).not.toContain("test-bedrock-key");
  });
});
