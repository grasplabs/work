import { adminAskPurpose } from "@grasp-os/shared/admin-ask";
import {
  adminKickoffMaxBytes,
  adminKickoffPath,
  adminKickoffPurpose,
  adminKickoffViewSchema,
} from "@grasp-os/shared/admin-kickoff";
import type { AdminKickoffAsk } from "@grasp-os/shared/admin-kickoff";
import { adminSnapshotPurpose } from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toBase64, toHex } from "@grasp-os/shared/encoding";
import { transcriptFileMaxBytes } from "@grasp-os/shared/kickoff";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signInConfig } from "./sign-in-config.ts";
import { auditedDuring, routed, signedInApi, withSignIn } from "./sign-in.ts";

// The kickoff brought in from Grasp's admin (src/admin-kickoff.ts,
// GRA-1099). The ways it can fail, tried first:
//
// - Anyone but the admin, or the admin signing for another company or for
//   another purpose (the snapshot's key, the chat's), bringing a
//   transcript in: refused before the model reads anything.
// - A request caught on its way sent again later, or one malformed:
//   refused.
// - A file too large, not base64, or of a kind that isn't a transcript.
// - Grasp acting while the company keeps it out: no staff window, or the
//   company's admin ended staff access, before or while it is read.
// - What was said leaving the company's Grasp in the answer.
//
// Then that it seeds Stephen's context as the staff page did, on record by
// the staff member the admin names. The model provider behind connect is
// the outside system (test/model-provider.ts).

const idp = mockIdp();

const staffEmail = "grace.hopper@grasp.test";

/** Grasp's first conversation with a Dutch company, as its transcript has it. */
const dutch = `Anna (COO): Wij zijn een hypotheekadviseur in Utrecht, met vijf teams.
Jakob (Grasp): Waar gaat de meeste tijd naartoe?
Anna (COO): Het overtypen van klantgegevens tussen het CRM en de bankportalen kost ons team elke week uren.
Anna (COO): Aan de salarisadministratie mag niemand komen, daar loopt een onderzoek.
Anna (COO): Ons team hypotheekadvies telt 12 adviseurs.`;

/** What the model answers about `dutch`. */
const reading = {
  fields: [
    {
      field: "pain",
      text: "Klantgegevens overtypen tussen het CRM en de bankportalen.",
      quote:
        "Het overtypen van klantgegevens tussen het CRM en de bankportalen kost ons team elke week uren.",
      ask: "",
    },
    {
      field: "limits",
      text: "De salarisadministratie blijft buiten beeld.",
      quote: "Aan de salarisadministratie mag niemand komen",
      ask: "",
    },
    {
      field: "languages",
      text: "",
      quote: "",
      ask: "In welke talen werken de teams?",
    },
  ],
  teams: [
    {
      name: "hypotheekadvies",
      does: "Hypotheekadvies voor klanten",
      people: 12,
    },
  ],
};

const answer: ProviderReply = {
  text: JSON.stringify(reading),
  inputTokens: 900,
  outputTokens: 300,
};

/** `body`'s signature as the admin makes it, with the key `secret` gives for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminKickoffPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

const bodyOf = (
  ask: AdminKickoffAsk | Record<string, unknown>,
  sentAt = new Date().toISOString()
): string => JSON.stringify({ sentAt, staff: { email: staffEmail }, ask });

const pasted = (text: string): AdminKickoffAsk => ({
  kind: "save",
  locale: "nl",
  transcript: { text },
});

const file = (name: string, bytes: Uint8Array): AdminKickoffAsk => ({
  kind: "save",
  locale: "nl",
  transcript: { file: { name, base64: toBase64(bytes) } },
});

/** Sends `body` to core through the router, signed with `signature` (none for null). */
const send = async (
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
    adminKickoffPath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Sends `ask` as the admin does: signed with this company's key, now. */
const asAdmin = async (
  ask: AdminKickoffAsk,
  coreEnv: Env = env
): Promise<Response> => {
  const body = bodyOf(ask);
  return await send(body, { signature: await signatureOf(body), coreEnv });
};

/**
 * What `run` returns while the provider answers with `replies`, once
 * `meanwhile` is done for each request, and what was sent to it.
 */
const answering = async <T>(
  replies: ProviderReply[],
  run: () => Promise<T>,
  meanwhile?: () => Promise<void>
) => {
  const provider = await answeringProvider(async () => {
    await meanwhile?.();
    return replies.shift();
  });
  return { requests: provider.requests, result: await run() };
};

/** The error code of a refusal's body, if it has one. */
const codeOf = async (response: Response): Promise<string | null> => {
  const body: unknown = await response.json().catch(() => null);
  const parsed = z.object({ code: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.code : null;
};

/** When the kickoff came in, to tell whether anything was kept. */
const keptAt = async (): Promise<string | null> => {
  const kickoff = await onboardingStore(env).kickoff();
  return kickoff.transcript?.at ?? null;
};

describe("the kickoff from Grasp's admin", { timeout: 60_000 }, () => {
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();
  });

  it("can't be read while the company has connected no AI provider, and keeps nothing", async () => {
    // First in the file: no test before it connected a provider.
    const before = await keptAt();

    const response = await asAdmin(pasted(dutch));

    expect({
      status: response.status,
      code: await codeOf(response),
      kept: (await keptAt()) === before,
    }).toStrictEqual({ status: 503, code: "model.no_provider", kept: true });
  });

  it("is refused to anyone but the admin signing for this company and this purpose, a stale or malformed request, and reads nothing", async () => {
    const fresh = bodyOf(pasted(dutch));
    const stale = bodyOf(
      pasted(dutch),
      new Date(Date.now() - 10 * 60 * 1000).toISOString()
    );
    const unknownKind = bodyOf({ kind: "delete" });
    const before = await keptAt();
    const { requests, result } = await answering([answer], async () => {
      const statuses: number[] = [];
      const events = await auditedDuring(async () => {
        const responses = await Promise.all([
          send(fresh),
          send(fresh, { signature: "0".repeat(64) }),
          // The admin's keys for the snapshot and the chat open nothing here.
          send(fresh, {
            signature: await signatureOf(
              fresh,
              env.BETTER_AUTH_SECRET,
              adminSnapshotPurpose
            ),
          }),
          send(fresh, {
            signature: await signatureOf(
              fresh,
              env.BETTER_AUTH_SECRET,
              adminAskPurpose
            ),
          }),
          // Signed for another company: its own auth secret.
          send(fresh, {
            signature: await signatureOf(fresh, "another-client-auth-secret"),
          }),
          send(stale, { signature: await signatureOf(stale) }),
          send(unknownKind, { signature: await signatureOf(unknownKind) }),
          send(fresh, { signature: await signatureOf(fresh), method: "GET" }),
        ]);
        statuses.push(...responses.map(({ status }) => status));
        await Promise.all(responses.map(async (each) => await each.text()));
      });
      return { statuses, events: events.length };
    });
    expect({
      ...result,
      read: requests.length,
      kept: (await keptAt()) === before,
    }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 403, 403, 404],
      events: 0,
      read: 0,
      kept: true,
    });
  });

  it("refuses a body or a file too large, a file that isn't base64, and one that isn't a transcript, before the model reads it", async () => {
    const tooLargeBody = JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
      ask: { kind: "save", locale: "nl", transcript: { text: "" } },
      padding: "x".repeat(adminKickoffMaxBytes),
    });
    const tooLargeFile = bodyOf({
      kind: "save",
      locale: "nl",
      transcript: {
        file: {
          name: "kickoff.txt",
          base64: "A".repeat(4 * Math.ceil((transcriptFileMaxBytes + 3) / 3)),
        },
      },
    });
    const notBase64 = bodyOf({
      kind: "save",
      locale: "nl",
      transcript: { file: { name: "kickoff.txt", base64: "not base64!" } },
    });
    const { requests, result } = await answering([answer], async () => {
      const responses = await Promise.all([
        send(tooLargeBody, { signature: await signatureOf(tooLargeBody) }),
        send(tooLargeFile, { signature: await signatureOf(tooLargeFile) }),
        send(notBase64, { signature: await signatureOf(notBase64) }),
        asAdmin(file("kickoff.exe", new TextEncoder().encode(dutch))),
        // Not UTF-8: no transcript.
        asAdmin(file("kickoff.txt", Uint8Array.from([0xff, 0xfe, 0xfd]))),
        asAdmin(pasted("Too short.")),
      ]);
      return await Promise.all(
        responses.map(async (response) => ({
          status: response.status,
          code: await codeOf(response),
        }))
      );
    });
    expect({ result, read: requests.length }).toStrictEqual({
      result: [
        { status: 403, code: "request.forbidden" },
        { status: 403, code: "request.forbidden" },
        { status: 403, code: "request.forbidden" },
        { status: 400, code: "kickoff.unreadable" },
        { status: 400, code: "kickoff.unreadable" },
        { status: 400, code: "kickoff.too_short" },
      ],
      read: 0,
    });
  });

  it("is refused while the company keeps Grasp out: no staff window, one that has closed, or staff access ended", async () => {
    const day = 24 * 60 * 60 * 1000;
    const noWindow = withSignIn({ staff: undefined });
    const closed = withSignIn({
      staff: {
        ...signInConfig.staff,
        opened: new Date(Date.now() - 3 * day).toISOString(),
        until: new Date(Date.now() - day).toISOString(),
      },
    });
    const before = await keptAt();
    const { requests, result } = await answering([answer], async () => {
      const outside = await Promise.all([
        asAdmin(pasted(dutch), noWindow),
        asAdmin(pasted(dutch), closed),
      ]);
      const { api: admin } = await signedInApi(idp, "admin");
      await admin.onboardingGate.endStaffAccess();
      const ended = await Promise.all([
        asAdmin(pasted(dutch)),
        asAdmin({ kind: "read" }),
        asAdmin({ kind: "answer", field: "languages", text: "Nederlands" }),
      ]);
      return await Promise.all(
        [...outside, ...ended].map(async (response) => ({
          status: response.status,
          code: await codeOf(response),
        }))
      );
    });
    expect({
      result,
      read: requests.length,
      kept: (await keptAt()) === before,
    }).toStrictEqual({
      result: Array.from({ length: 5 }, () => ({
        status: 403,
        code: "onboarding.staff_only",
      })),
      read: 0,
      kept: true,
    });
  });

  it("keeps nothing when the company ends Grasp's access while it is read", async () => {
    const before = await keptAt();
    const { api: admin } = await signedInApi(idp, "admin");
    const { requests, result } = await answering(
      [answer],
      async () => await asAdmin(pasted(dutch)),
      async () => {
        await admin.onboardingGate.endStaffAccess();
      }
    );
    expect({
      status: result.status,
      code: await codeOf(result),
      read: requests.length,
      kept: (await keptAt()) === before,
    }).toStrictEqual({
      status: 403,
      code: "onboarding.staff_only",
      read: 1,
      kept: true,
    });
  });

  it("seeds Stephen's context as the staff page did, on record by the staff member, and tells the admin what it brought but never what was said", async () => {
    const { result } = await answering([answer], async () => {
      const seen: { status: number; body: unknown } = {
        status: 0,
        body: null,
      };
      const events = await auditedDuring(async () => {
        const response = await asAdmin(
          file("kickoff.txt", new TextEncoder().encode(dutch))
        );
        seen.status = response.status;
        seen.body = await response.json();
      });
      return { ...seen, events };
    });
    const brief = await onboardingStore(env).kickoffBrief();
    const view = adminKickoffViewSchema.parse(result.body);
    const states = Object.fromEntries(
      view.fields.map(({ field, state }) => [field, state])
    );
    const saved = result.events.filter(
      ({ action }) => action === "onboarding.kickoff.saved"
    );
    expect({
      status: result.status,
      fileName: view.transcript?.fileName,
      read: view.read,
      pain: states.pain,
      languages: view.fields.find(({ field }) => field === "languages"),
      teams: view.teams,
      // The admin gets no words of the conversation, nor of the reading.
      said: ["klantgegevens", "salarisadministratie", "Utrecht"].some((word) =>
        JSON.stringify(result.body).toLowerCase().includes(word.toLowerCase())
      ),
      brief: {
        pain: brief.includes("Klantgegevens overtypen"),
        leaveAlone: brief.includes(
          "De salarisadministratie blijft buiten beeld."
        ),
      },
      by: saved.map(({ actor }) => actor),
    }).toStrictEqual({
      status: 200,
      fileName: "kickoff.txt",
      read: true,
      pain: "said",
      languages: {
        field: "languages",
        state: "open",
        ask: "In welke talen werken de teams?",
        answer: null,
      },
      teams: 1,
      said: false,
      brief: { pain: true, leaveAlone: true },
      by: [{ type: "staff", userId: staffEmail, via: "console" }],
    });
  });

  it("keeps the sponsor's answer to what it left open, and reads the kickoff on record", async () => {
    await answering([answer], async () => await asAdmin(pasted(dutch)));
    const events = await auditedDuring(async () => {
      const answered = await asAdmin({
        kind: "answer",
        field: "languages",
        text: "Nederlands en Engels",
      });
      await answered.text();
    });
    const read = await auditedDuring(async () => {
      const response = await asAdmin({ kind: "read" });
      const view = adminKickoffViewSchema.parse(await response.json());
      expect(
        view.fields.find(({ field }) => field === "languages")
      ).toStrictEqual({
        field: "languages",
        state: "answered",
        ask: "In welke talen werken de teams?",
        answer: "Nederlands en Engels",
      });
    });
    const brief = await onboardingStore(env).kickoffBrief();
    expect({
      answered: events.map(({ action, actor }) => ({ action, actor })),
      read: read.map(({ action, actor }) => ({ action, actor })),
      brief: brief.includes("Nederlands en Engels"),
    }).toStrictEqual({
      answered: [
        {
          action: "onboarding.kickoff.answered",
          actor: { type: "staff", userId: staffEmail, via: "console" },
        },
      ],
      read: [
        {
          action: "admin.kickoff.read",
          actor: { type: "staff", userId: staffEmail, via: "console" },
        },
      ],
      brief: true,
    });
  });
});
