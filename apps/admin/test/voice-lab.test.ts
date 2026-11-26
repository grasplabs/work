import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  closeVoiceSessionFn,
  openVoiceSessionFn,
} from "../src/admin/voice-lab-functions.ts";
import type { VoiceLabInput } from "../src/admin/voice-lab.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { callServerFn } from "./pages.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// The Voice Lab's session (src/admin/voice-lab.ts): the admin opens a
// voice agent session at Mistral with Grasp's own key, and hands the page
// only what it joins the session with. Mistral is the outside system,
// faked here by its sessions endpoint.

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

const sessionsUrl = "https://api.mistral.ai/v1/audio/sessions";

/** One request Mistral took. */
interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** The requests Mistral took, and how it answers opening a session. */
const mistral: { status: number; answer: unknown; sent: Sent[] } = {
  status: 200,
  answer: {},
  sent: [],
};

/** A session as Mistral answers one. */
const opened = {
  id: "sess_1a2b",
  participant_token: "room-token-not-a-key",
  server_url: "wss://voice.mistral.test",
  created_at: "2026-11-25T10:00:00.000Z",
  expires_at: "2026-11-25T11:00:00.000Z",
};

/** What Mistral kept of a call: he spoke three times, and was talked over once. */
const kept = {
  id: "sess_1a2b",
  status: "ended",
  num_participants: 0,
  created_at: "2026-11-25T10:00:00.000Z",
  transcripts: [
    {
      role: "assistant",
      content: "What do you do here?",
      is_interruption: false,
    },
    { role: "user", content: "I plan the routes." },
    { role: "assistant", content: "And how do you", is_interruption: true },
    { role: "user", content: "Wait, one more thing." },
    { role: "assistant", content: "Go on.", is_interruption: false },
  ],
};

const open = async (input: VoiceLabInput) =>
  await callServerFn(openVoiceSessionFn, input, { email: staff.email });

/** The audit events of staff's sessions. */
const sessionEvents = async () =>
  await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "admin.voice_lab"),
        eq(auditEvents.actor, staff.email)
      )
    );

describe("the Voice Lab's session", () => {
  beforeEach(() => {
    mistral.status = 200;
    mistral.answer = opened;
    mistral.sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      mistral.sent.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: text === "" ? null : JSON.parse(text),
      });
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return request.method === "GET"
        ? Response.json(kept)
        : Response.json(mistral.answer, { status: mistral.status });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  // After Mistral's fake: Access's keys are served, the rest goes to it.
  mockAccess();
  useStoreSecrets({ deployer: "test-deployer-token-voice-lab-5e1a90" });

  it("opens a session at Mistral with Grasp's key, as Stephen in the language asked, and hands the page only what it joins with", async () => {
    await setStoreSecret(
      env.MISTRAL_API_KEY,
      "MISTRAL_API_KEY",
      "grasp-mistral-key"
    );
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "admin.voice_lab"));

    const session = await open({ locale: "de" });
    const [sent] = mistral.sent;
    const asked = JSON.stringify(sent?.body);

    expect({
      session,
      method: sent?.method,
      url: sent?.url,
      authorization: sent?.authorization,
      // He is Stephen, speaks German, and his first line is said for him.
      stephen: asked.includes("You are Stephen,"),
      german: asked.includes("Every word you say is German"),
      welcome: asked.includes("Was machen Sie hier, in ein oder zwei Sätzen?"),
      voice: asked.includes('"voice_id":"voice_485"'),
      interrupts: asked.includes('"allow_interruptions":true'),
      // Talking over him is listened for at a set threshold, never left empty.
      listens: asked.includes('"start_threshold":0.3'),
      // Nothing of what only core's own turns need.
      notes: asked.includes("What you write down"),
      keyInAnswer: JSON.stringify(session).includes("grasp-mistral-key"),
      events: await sessionEvents(),
    }).toStrictEqual({
      session: {
        id: "sess_1a2b",
        participantToken: "room-token-not-a-key",
        serverUrl: "wss://voice.mistral.test",
        expiresAt: "2026-11-25T11:00:00.000Z",
        refused: null,
      },
      method: "POST",
      url: sessionsUrl,
      authorization: "Bearer grasp-mistral-key",
      stephen: true,
      german: true,
      welcome: true,
      voice: true,
      interrupts: true,
      listens: true,
      notes: false,
      keyInAnswer: false,
      events: [{ detail: JSON.stringify({ locale: "de" }) }],
    });
  });

  it("says Grasp's Mistral key is missing, and asks nothing", async () => {
    expect({
      session: await open({ locale: "en" }),
      sent: mistral.sent.length,
    }).toStrictEqual({
      session: { id: null, refused: "no_key" },
      sent: 0,
    });
  });

  it.each([
    ["refuses it", 403, { message: "Voice agents are not enabled." }],
    [
      "answers with a room that isn't a secure socket",
      200,
      { ...opened, server_url: "https://voice.mistral.test" },
    ],
  ])("opens nothing when Mistral %s", async (_, status, answer) => {
    await setStoreSecret(
      env.MISTRAL_API_KEY,
      "MISTRAL_API_KEY",
      "grasp-mistral-key"
    );
    mistral.status = status;
    mistral.answer = answer;
    await expect(open({ locale: "en" })).resolves.toStrictEqual({
      id: null,
      refused: "not_opened",
    });
  });

  it("closes a session at Mistral by its ID, answers what it kept as counts alone, and takes no ID that reads as a path", async () => {
    await setStoreSecret(
      env.MISTRAL_API_KEY,
      "MISTRAL_API_KEY",
      "grasp-mistral-key"
    );
    const record = await callServerFn(
      closeVoiceSessionFn,
      { sessionId: "sess_1a2b" },
      { email: staff.email }
    );
    let refused = false;
    try {
      await callServerFn(
        closeVoiceSessionFn,
        { sessionId: "../agents/agent_1" },
        { email: staff.email }
      );
    } catch {
      refused = true;
    }
    expect(refused).toBeTruthy();
    expect(record).toStrictEqual({ spoke: 3, cutOff: 1 });
    expect(
      mistral.sent.map(({ method, url, authorization }) => ({
        method,
        url,
        authorization,
      }))
    ).toStrictEqual([
      {
        method: "GET",
        url: `${sessionsUrl}/sess_1a2b`,
        authorization: "Bearer grasp-mistral-key",
      },
      {
        method: "DELETE",
        url: `${sessionsUrl}/sess_1a2b`,
        authorization: "Bearer grasp-mistral-key",
      },
    ]);
  });
});
