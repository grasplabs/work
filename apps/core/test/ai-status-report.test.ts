import { organizationProviderIds } from "@grasp-os/shared/ai-providers";
import {
  aiStatusReportPath,
  aiStatusReportPurpose,
  aiStatusReportSchema,
} from "@grasp-os/shared/ai-status-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { quotaPolicyReportPurpose } from "@grasp-os/shared/quota-policy-report";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  answeringProvider,
  connectModels,
  keyChanger,
} from "./model-provider.ts";
import { routed, signedInApi } from "./sign-in.ts";

// The organization's AI, for the admin: which providers it connected and
// how their calls last fared, from real calls through the gateway, and
// never a key. The ways it can fail, tried first: anyone but the admin
// reading it (unsigned, signed with another key or for another purpose,
// sent long ago, no request at all), and an answer that carries a key or
// its mask.

const idp = mockIdp();

/** `body`'s signature as the admin makes it, for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = aiStatusReportPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Asks core for its AI's status through the router, signed with `signature`. */
const ask = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(aiStatusReportPath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

/** What core answers the admin's signed request, as its raw text. */
const reportText = async (): Promise<string> => {
  const body = bodyAt();
  const response = await ask(body, await signatureOf(body));
  expect(response.status).toBe(200);
  return await response.text();
};

/** The organization's providers as the report has them. */
const organizationOf = async () => {
  const { providers } = aiStatusReportSchema.parse(
    JSON.parse(await reportText())
  );
  return providers.filter(({ kind }) => kind === "organization");
};

describe("the organization's AI, for the admin", () => {
  it("answers none before a provider is connected, then each connected one, its default's first, with how its real calls last fared, and never a key", async () => {
    for (const provider of organizationProviderIds) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await env.CONNECT.removeAiProviderKey(provider, keyChanger);
    }
    const none = await organizationOf();

    const key = `test-status-key-${crypto.randomUUID()}`;
    await connectModels(key, [
      "mistral/mistral-large-latest",
      "anthropic/claude-sonnet-4-5",
    ]);
    const unused = await organizationOf();

    // One call that works, then one the provider fails: as the gateway
    // noted them, by the organization's key.
    let fail = false;
    await answeringProvider(
      () =>
        fail ? undefined : { text: "OK", inputTokens: 10, outputTokens: 1 },
      { models: ["mistral/mistral-large-latest"] }
    );
    const { api } = await signedInApi(idp, "admin");
    const before = Date.now();
    await api.aiProviders.test("mistral");
    const working = await organizationOf();
    fail = true;
    await api.aiProviders.test("mistral");
    const failing = await organizationOf();
    const text = await reportText();

    const [worked] = working;
    const [failed] = failing;
    const unread = {
      kind: "organization",
      lastOkAt: null,
      lastFailedAt: null,
      lastFailure: null,
    };

    expect({
      none,
      unused,
      worked: {
        since: (worked?.lastOkAt ?? 0) >= before,
        failed: worked?.lastFailedAt,
      },
      failed: {
        provider: failed?.provider,
        after:
          (failed?.lastFailedAt ?? 0) >=
          (worked?.lastOkAt ?? Number.POSITIVE_INFINITY),
        how: typeof failed?.lastFailure,
      },
      // Neither the key nor any part of its mask.
      keyShown: text.includes(key.slice(-4)) || text.includes("…"),
    }).toStrictEqual({
      none: [],
      unused: [
        { provider: "mistral", ...unread },
        { provider: "anthropic", ...unread },
      ],
      worked: { since: true, failed: null },
      failed: { provider: "mistral", after: true, how: "string" },
      keyShown: false,
    });
  });

  it("refuses anyone but the admin: unsigned, signed otherwise or for another purpose, sent long ago, or no request at all", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const statuses = await Promise.all([
      ask(fresh, null),
      ask(fresh, await signatureOf(fresh, "another-secret")),
      // The quota policy report's key reads nothing here.
      ask(
        fresh,
        await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          quotaPolicyReportPurpose
        )
      ),
      ask(old, await signatureOf(old)),
      ask("{}", await signatureOf("{}")),
      ask(fresh, await signatureOf(fresh), "GET"),
    ]);

    expect(statuses.map(({ status }) => status)).toStrictEqual([
      403, 403, 403, 403, 403, 404,
    ]);
  });
});
