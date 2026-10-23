import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import {
  adminAskPath,
  adminAskPurpose,
  adminAskAnswerSchema,
} from "@grasp-os/shared/admin-ask";
import { adminSnapshotPurpose } from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { auditedDuring, routed } from "./sign-in.ts";

// Ask Grasp on Grasp's own core (src/admin-ask.ts): only the admin's
// signed question reaches the model gateway, every question is in the
// audit log by the staff member the admin names before the model is
// asked, and the admin's document only goes to a model the deployment's
// rules let take sensitive data. AI Gateway is the outside system: a fake
// behind the AI binding.

const staffEmail = "ada.lovelace@grasp.test";

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Words only the admin's document holds, to find where they went. */
const document = `# Grasp's admin

## Noordkade
- Interviews done: 12 of 20
- Health: needs a look`;

/** `body`'s signature as the admin makes it, with the key `secret` gives for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminAskPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

const question = "Which company needs a look today?";

const bodyOf = ({
  sentAt = new Date().toISOString(),
  turns = [{ role: "user", text: question }],
}: { sentAt?: string; turns?: { role: string; text: string }[] } = {}) =>
  JSON.stringify({ sentAt, staff: { email: staffEmail }, document, turns });

/** Asks core through the router, signed with `signature` (none for null). */
const ask = async (
  body: string,
  {
    signature = null,
    method = "POST",
    coreEnv = env,
  }: { signature?: string | null; method?: string; coreEnv?: Env } = {}
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(
    adminAskPath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** What `run` returns while the gateway answers with `replies`, and what was sent to it. */
const answering = async <T>(replies: GatewayReply[], run: () => Promise<T>) => {
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    spy.mockRestore();
  }
};

const answer = {
  text: "Noordkade: its health needs a look, with 12 of 20 interviews done.",
  inputTokens: 900,
  outputTokens: 40,
};

describe("Ask Grasp on Grasp's own core", () => {
  it("refuses anyone but the console, a stale or malformed question, and sends the model nothing", async () => {
    const fresh = bodyOf();
    const old = bodyOf({
      sentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    // A conversation must take turns and end with a question.
    const answerLast = bodyOf({
      turns: [
        { role: "user", text: question },
        { role: "assistant", text: "Noordkade." },
      ],
    });
    const twoQuestions = bodyOf({
      turns: [
        { role: "user", text: question },
        { role: "user", text: "And then?" },
      ],
    });
    const { requests, result } = await answering([answer], async () => {
      const statuses: number[] = [];
      const events = await auditedDuring(async () => {
        const responses = await Promise.all([
          ask(fresh),
          ask(fresh, { signature: "0".repeat(64) }),
          // The admin's key for the admin snapshot asks nothing here.
          ask(fresh, {
            signature: await signatureOf(
              fresh,
              env.BETTER_AUTH_SECRET,
              adminSnapshotPurpose
            ),
          }),
          ask(fresh, {
            signature: await signatureOf(fresh, "another-client-auth-secret"),
          }),
          ask(old, { signature: await signatureOf(old) }),
          ask(answerLast, { signature: await signatureOf(answerLast) }),
          ask(twoQuestions, { signature: await signatureOf(twoQuestions) }),
          ask(fresh, { signature: await signatureOf(fresh), method: "GET" }),
        ]);
        statuses.push(...responses.map(({ status }) => status));
        await Promise.all(responses.map(async (each) => await each.text()));
      });
      return {
        statuses,
        asked: events.filter(({ action }) => action === "admin.ask").length,
      };
    });
    expect({ ...result, sent: requests.length }).toStrictEqual({
      statuses: [401, 401, 401, 401, 403, 403, 403, 404],
      asked: 0,
      sent: 0,
    });
  });

  it("answers the console's question from the document through the model gateway, on record by the staff member", async () => {
    const body = bodyOf({
      turns: [
        { role: "user", text: "How many companies are there?" },
        { role: "assistant", text: "One: Noordkade." },
        { role: "user", text: question },
      ],
    });
    const signature = await signatureOf(body);
    const { requests, result } = await answering([answer], async () => {
      const seen: { status: number; answered: unknown } = {
        status: 0,
        answered: undefined,
      };
      const events = await auditedDuring(async () => {
        const response = await ask(body, { signature });
        seen.status = response.status;
        seen.answered = await response.json();
      });
      return { ...seen, events };
    });
    const sent = JSON.stringify(requests.map(({ body: each }) => each));
    const asked = result.events.filter(({ action }) => action === "admin.ask");
    expect({
      status: result.status,
      answer: adminAskAnswerSchema.parse(result.answered),
      model: requests.map(({ url }) => url.includes("workers-ai")),
      document: sent.includes("Interviews done: 12 of 20"),
      conversation: [
        "How many companies are there?",
        "One: Noordkade.",
        question,
      ].map((text) => sent.includes(text)),
      asked: asked.map(({ actor, detail }) => ({ actor, detail })),
      // The audit log keeps that a question was asked, never its words or the document.
      words: JSON.stringify(asked).includes("Noordkade"),
    }).toStrictEqual({
      status: 200,
      answer: { text: answer.text, truncated: false },
      model: [true],
      document: true,
      conversation: [true, true, true],
      asked: [
        {
          actor: { type: "staff", userId: staffEmail, via: "console" },
          detail: { turns: 3 },
        },
      ],
      words: false,
    });
  });

  it("sends the document only to a model the deployment's rules let take sensitive data, and asks none when there is none", async () => {
    const euModel = "openai/gpt-5.4";
    const withRules = (rules: object): Env => ({
      ...env,
      MODEL_GATEWAY: {
        gateway: "grasp-os-test",
        models: [workersAi, euModel],
        ...rules,
      },
    });
    const ruled = bodyOf();
    const none = bodyOf();
    const [ruledSignature, noneSignature] = await Promise.all([
      signatureOf(ruled),
      signatureOf(none),
    ]);
    const { requests, result } = await answering([answer], async () => {
      const allowed = await ask(ruled, {
        signature: ruledSignature,
        coreEnv: withRules({
          sensitive: { models: [euModel], connections: [] },
        }),
      });
      await allowed.text();
      const refused = await ask(none, {
        signature: noneSignature,
        // Only Workers AI may take sensitive data, and only the EU model stays in the EU.
        coreEnv: withRules({
          sensitive: { models: [workersAi], connections: [] },
          eu: { models: [euModel], deployment: true },
        }),
      });
      const refusal = z
        .object({ code: z.string() })
        .parse(await refused.json());
      return {
        allowed: allowed.status,
        refused: refused.status,
        code: refusal.code,
      };
    });
    expect({
      ...result,
      sent: requests.map(({ url }) => url.includes("openai")),
    }).toStrictEqual({
      allowed: 200,
      refused: 503,
      code: "admin_ask.no_model",
      sent: [true],
    });
  });
});
