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

import { askGraspFn } from "../src/admin/ask-functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { callServerFn } from "./pages.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// Ask Grasp (src/admin/ask.ts): the admin asks Grasp's own OpenAI key,
// at OpenAI's EU host, from the document the page sends. OpenAI is the
// outside system, faked here by its Responses API's stream.

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** Where Grasp's key may send a question: OpenAI's EU data residency host. */
const responsesUrl = "https://eu.api.openai.com/v1/responses";

/** What the fake OpenAI does with the next question. */
interface Reply {
  text?: string;
  truncated?: boolean;
  status?: number;
}

/** One request OpenAI took. */
interface Sent {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** The requests OpenAI took, and what it answers. */
const openai: { reply: Reply; sent: Sent[] } = { reply: {}, sent: [] };

/** One server-sent event of the Responses API's stream. */
const event = (data: object): string => `data: ${JSON.stringify(data)}\n\n`;

/** The stream OpenAI's Responses API sends for `text`. */
const streamOf = (text: string, truncated: boolean): string => {
  const message = { type: "message", id: "msg_1", role: "assistant" };
  return [
    event({
      type: "response.created",
      response: { id: "resp_1", status: "in_progress" },
    }),
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, content: [] },
    }),
    event({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    event({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...message,
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    event({
      type: truncated ? "response.incomplete" : "response.completed",
      response: {
        id: "resp_1",
        status: truncated ? "incomplete" : "completed",
        ...(truncated
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    }),
  ].join("");
};

const document = "# Grasp's admin\n\n## Noordkade\n- Interviews done: 12 of 20";

/** Asks as the chat does, as staff. */
const ask = async (said: { role: "user" | "assistant"; text: string }[]) =>
  await callServerFn(askGraspFn, { document, said }, { email: staff.email });

/** The audit events of staff's questions. */
const askedEvents = async () =>
  await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "admin.ask"),
        eq(auditEvents.actor, staff.email)
      )
    );

describe("Ask Grasp", () => {
  beforeEach(() => {
    openai.reply = {};
    openai.sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      openai.sent.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      const { text = "An answer.", truncated = false, status } = openai.reply;
      if (status !== undefined) {
        return Response.json({ error: { message: "No." } }, { status });
      }
      return new Response(streamOf(text, truncated), {
        headers: { "content-type": "text/event-stream" },
      });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  // After OpenAI's fake: Access's keys are served, the rest goes to it.
  mockAccess();
  useStoreSecrets({ deployer: "test-deployer-token-admin-ask-71c0d2" });

  it("asks OpenAI's EU host with Grasp's key, the document and the conversation as turns, on record as the staff member", async () => {
    await db.delete(auditEvents).where(eq(auditEvents.action, "admin.ask"));
    openai.reply = { text: "Noordkade: 12 of 20 interviews." };

    const answer = await ask([
      { role: "user", text: "Not answered" },
      { role: "user", text: "How many companies?" },
      { role: "assistant", text: "One." },
      { role: "user", text: "Which one is furthest?" },
    ]);
    const [sent] = openai.sent;
    const read = JSON.stringify(sent?.body);

    expect({
      answer,
      url: sent?.url,
      authorization: sent?.authorization,
      document: read.includes(JSON.stringify(document).slice(1, -1)),
      // The question that got no answer isn't sent beside the next.
      unanswered: read.includes("Not answered"),
      turns: ["How many companies?", "One.", "Which one is furthest?"].map(
        (said) => read.includes(said)
      ),
      events: await askedEvents(),
    }).toStrictEqual({
      answer: {
        text: "Noordkade: 12 of 20 interviews.",
        truncated: false,
        refused: null,
      },
      url: responsesUrl,
      authorization: "Bearer grasp-openai-key",
      document: true,
      unanswered: false,
      turns: [true, true, true],
      events: [{ detail: JSON.stringify({ turns: 3 }) }],
    });
  });

  it("says when the answer stopped at its limit", async () => {
    openai.reply = { text: "Noordkade, then", truncated: true };
    await expect(
      ask([{ role: "user", text: "Which company?" }])
    ).resolves.toStrictEqual({
      text: "Noordkade, then",
      truncated: true,
      refused: null,
    });
  });

  it("says Grasp's OpenAI key is missing, and asks nothing", async () => {
    await emptyStoreSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY");
    expect({
      answer: await ask([{ role: "user", text: "Which company?" }]),
      sent: openai.sent.length,
    }).toStrictEqual({
      answer: { text: null, truncated: false, refused: "no_key" },
      sent: 0,
    });
  });

  it("says Grasp didn't answer when OpenAI fails", async () => {
    openai.reply = { status: 500 };
    await expect(
      ask([{ role: "user", text: "Which company?" }])
    ).resolves.toStrictEqual({
      text: null,
      truncated: false,
      refused: "not_answered",
    });
  });

  it("starts over a conversation longer than the model takes, and asks nothing", async () => {
    const said = Array.from({ length: 41 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Turn ${index}`,
    }));
    expect({ answer: await ask(said), sent: openai.sent.length }).toStrictEqual(
      {
        answer: { text: null, truncated: false, refused: "too_long" },
        sent: 0,
      }
    );
  });

  it("answers only staff", async () => {
    await expect(
      callServerFn(
        askGraspFn,
        { document, said: [{ role: "user", text: "Which company?" }] },
        { email: null }
      )
    ).rejects.toThrow("The server function answered 403");
    expect(openai.sent).toStrictEqual([]);
  });
});
