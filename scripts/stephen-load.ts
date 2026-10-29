/**
 * GRA-732's staging half: many people's turns at once, as people ask in
 * their own chats, through the same `/rpc` the web chat uses (`create`,
 * `send`, `watch`), so each turn runs in that person's own Workspace,
 * through the fair model queue and the admins' limits, as on any client.
 * Each question carries a mark of its own that the model is asked to say
 * back, so an answer that reaches the wrong person, or none, shows. It
 * records, per turn, the time to the first words and to the whole answer,
 * its cost, and how it ended (answered, refused for a budget or a limit,
 * failed or lost), and fails when an answer reached the wrong person, one
 * was lost, or the p90 went past the bar.
 *
 *   node scripts/stephen-load.ts --local --people 500 --at-once 50
 *     against `vp run dev`: signs in `load-<n>@acme.test` through the local
 *     fake IdP first (a rehearsal; scripts/seed/local.ts)
 *   node scripts/stephen-load.ts --origin https://<staging> --sessions sessions.jsonl --at-once 50
 *     against a deployment, as the people in `sessions.jsonl` (one
 *     `{ "email", "cookie" }` per line, each a session of a test person
 *     signed in there); keep that file outside the repository
 *
 * Options: `--model <ref>` (the first `chats.models()` lists by default),
 * `--timeout-s <s>` a turn may take before it counts as lost (120),
 * `--p90-ms <ms>`, the bar for the whole answer's p90 (12000, the
 * prototype's app questions), `--out <file>` for every turn as JSON.
 * Against a real model it spends: each turn is one short question.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";

/** How one turn ended. */
export type TurnEnd =
  | "answered"
  | "wrong-person"
  | "refused"
  | "failed"
  | "lost";

/** One person's turn, as the run saw it. */
export interface Turn {
  email: string;
  mark: string;
  end: TurnEnd;
  /** From the question to the first words; null without any. */
  firstMs: number | null;
  /** From the question to the whole answer; null without one. */
  answerMs: number | null;
  /** US dollars, as the gateway charged the answer. */
  cost: number;
  /** Why it was refused or failed, in core's words. */
  reason?: string;
}

/** A mark no other turn's text holds: `LOAD-<n>-<random>`. */
export const markOf = (index: number, random: string): string =>
  `LOAD-${index}-${random}`;

const marks = /LOAD-\d+-[a-z0-9]+/gu;

/**
 * How an answer ended for the turn with `mark`: answered when it holds its
 * own mark, wrong-person when it holds another's, failed otherwise.
 */
export const judged = (mark: string, answer: string): TurnEnd => {
  const seen = [...answer.matchAll(marks)].map(([found]) => found);
  if (seen.some((each) => each !== mark)) {
    return "wrong-person";
  }
  return seen.includes(mark) ? "answered" : "failed";
};

/** The nearest-rank percentile `p` of `values`; null when empty. */
export const percentile = (
  values: readonly number[],
  p: number
): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] ?? null;
};

/** The run's numbers. */
export interface LoadSummary {
  turns: number;
  ends: Record<TurnEnd, number>;
  first: { p50Ms: number | null; p90Ms: number | null };
  answer: { p50Ms: number | null; p90Ms: number | null };
  costUsd: number;
  /** Why turns were refused or failed, and how many each. */
  reasons: Record<string, number>;
  /** Whether no answer reached the wrong person, none was lost, and the p90 held. */
  passed: boolean;
}

/** The numbers of `turns`, against the bar `p90Ms` for the whole answer. */
export const summaryOf = (
  turns: readonly Turn[],
  p90Ms: number
): LoadSummary => {
  const ends: Record<TurnEnd, number> = {
    answered: 0,
    "wrong-person": 0,
    refused: 0,
    failed: 0,
    lost: 0,
  };
  const reasons: Record<string, number> = {};
  for (const { end, reason } of turns) {
    ends[end] += 1;
    if (reason !== undefined) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  const firsts = turns.flatMap(({ firstMs }) =>
    firstMs === null ? [] : [firstMs]
  );
  const answers = turns.flatMap(({ answerMs }) =>
    answerMs === null ? [] : [answerMs]
  );
  const answerP90 = percentile(answers, 90);
  return {
    turns: turns.length,
    ends,
    first: { p50Ms: percentile(firsts, 50), p90Ms: percentile(firsts, 90) },
    answer: { p50Ms: percentile(answers, 50), p90Ms: answerP90 },
    costUsd: turns.reduce((sum, { cost }) => sum + cost, 0),
    reasons,
    passed:
      ends["wrong-person"] === 0 &&
      ends.lost === 0 &&
      answerP90 !== null &&
      answerP90 <= p90Ms,
  };
};

// ——— The run ———

type Api = ReturnType<
  ReturnType<typeof newWebSocketRpcSession<CoreApi>>["authenticate"]
>;

const sessionCookie = "__Host-grasp.session_token";

/** Someone the run asks as: their session at `origin`. */
interface Asker {
  email: string;
  cookie: string;
}

/** Their API over `/rpc` at `origin`, and how to close it. */
const connect = (origin: string, { cookie }: Asker) => {
  const url = new URL("/rpc", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Node's WebSocket (undici) takes headers, which a browser's doesn't.
  const socket = new WebSocket(url, {
    headers: {
      origin,
      cookie: `${sessionCookie}=${encodeURIComponent(cookie)}`,
    },
  });
  const core = newWebSocketRpcSession<CoreApi>(socket);
  return {
    api: core.authenticate(),
    close: () => {
      core[Symbol.dispose]();
    },
  };
};

/** Runs `work` for each item, `limit` at a time, keeping their order. */
const inWaves = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    // oxlint-disable-next-line no-await-in-loop -- one wave at a time: `limit` people at once
    const wave = await Promise.all(
      items
        .slice(start, start + limit)
        .map(async (item, offset) => await work(item, start + offset))
    );
    results.push(...wave);
  }
  return results;
};

/** The assistant's last answer among `messages`, if it has one. */
const lastAnswer = (messages: readonly ChatMessage[]) =>
  messages.findLast(
    (message): message is Extract<ChatMessage, { role: "assistant" }> =>
      message.role === "assistant" && message.code.length === 0
  );

/** One person's turn: a new chat, the question, and its answer. */
const turnOf = async (
  api: Api,
  {
    email,
    mark,
    model,
    timeoutMs,
  }: { email: string; mark: string; model: string; timeoutMs: number }
): Promise<Turn> => {
  const chat = await api.chats.create(`Load ${mark}`);
  const done = Promise.withResolvers<Turn>();
  let firstMs: number | null = null;
  let started = 0;
  const watching = await api.chats.watch(
    chat.id,
    null,
    (update: ChatUpdate) => {
      const words =
        update.partial !== null ||
        update.messages.some(({ role }) => role === "assistant");
      if (firstMs === null && words && started > 0) {
        firstMs = performance.now() - started;
      }
      const answer = lastAnswer(update.messages);
      if (answer !== undefined) {
        done.resolve({
          email,
          mark,
          end: answer.end === "done" ? judged(mark, answer.text) : "failed",
          firstMs,
          answerMs: performance.now() - started,
          cost: answer.usage?.cost ?? 0,
          ...(answer.failure === undefined ? {} : { reason: answer.failure }),
        });
      } else if (update.stopped !== null && !update.running) {
        done.resolve({
          email,
          mark,
          end: "failed",
          firstMs,
          answerMs: null,
          cost: 0,
          reason: update.stopped,
        });
      }
    }
  );
  const timer = setTimeout(() => {
    done.resolve({
      email,
      mark,
      end: "lost",
      firstMs,
      answerMs: null,
      cost: 0,
    });
  }, timeoutMs);
  started = performance.now();
  try {
    await api.chats.send(chat.id, {
      text: `This is a load test. Reply with exactly this mark and nothing else: ${mark}`,
      model,
    });
  } catch (error) {
    // A budget, a limit or the queue refused it: core says which.
    done.resolve({
      email,
      mark,
      end: "refused",
      firstMs: null,
      answerMs: null,
      cost: 0,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const turn = await done.promise;
  clearTimeout(timer);
  await watching.release();
  return turn;
};

/** The people to ask as: signed in locally, or from a sessions file. */
const askers = async (values: {
  local?: boolean;
  people?: string;
  sessions?: string;
}): Promise<{ origin: string; people: Asker[] }> => {
  if (values.local === true) {
    // Imported only here: it refuses any stack but `vp run dev`.
    const { origin, signInAs } = await import("./seed/local.ts");
    const count = Number(values.people ?? "50");
    const emails = Array.from(
      { length: count },
      (_, index) => `load-${index + 1}@acme.test`
    );
    const people = await inWaves(emails, 4, async (email) => ({
      email,
      cookie: await signInAs(email),
    }));
    return { origin, people };
  }
  if (values.sessions === undefined) {
    throw new Error("Give --local, or --origin with --sessions");
  }
  const people = readFileSync(values.sessions, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Asker => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("email" in parsed) ||
        !("cookie" in parsed) ||
        typeof parsed.email !== "string" ||
        typeof parsed.cookie !== "string"
      ) {
        throw new Error('Each line of --sessions is { "email", "cookie" }');
      }
      return { email: parsed.email, cookie: parsed.cookie };
    });
  return { origin: "", people };
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      local: { type: "boolean" },
      origin: { type: "string" },
      sessions: { type: "string" },
      people: { type: "string" },
      "at-once": { type: "string", default: "50" },
      model: { type: "string" },
      "timeout-s": { type: "string", default: "120" },
      "p90-ms": { type: "string", default: "12000" },
      out: { type: "string" },
    },
  });
  const found = await askers(values);
  const origin = values.local === true ? found.origin : (values.origin ?? "");
  if (origin === "") {
    throw new Error("Give --origin with --sessions");
  }
  const atOnce = Number(values["at-once"]);
  const timeoutMs = Number(values["timeout-s"]) * 1000;
  const random = crypto.randomUUID().slice(0, 8);
  const connections = found.people.map((person) => ({
    person,
    ...connect(origin, person),
  }));
  try {
    const [first] = connections;
    if (first === undefined) {
      throw new Error("No one to ask as");
    }
    const [offered] = await first.api.chats.models();
    const model = values.model ?? offered;
    if (model === undefined) {
      throw new Error("The deployment offers no model");
    }
    console.info(
      `${connections.length} people, ${atOnce} at once, on ${model} at ${origin}`
    );
    const turns = await inWaves(
      connections,
      atOnce,
      async ({ person, api }, index) =>
        await turnOf(api, {
          email: person.email,
          mark: markOf(index + 1, random),
          model,
          timeoutMs,
        })
    );
    const summary = summaryOf(turns, Number(values["p90-ms"]));
    console.info(JSON.stringify(summary, null, 2));
    if (values.out !== undefined) {
      writeFileSync(values.out, JSON.stringify({ summary, turns }, null, 1));
    }
    if (!summary.passed) {
      process.exitCode = 1;
    }
  } finally {
    for (const { close } of connections) {
      close();
    }
  }
};

if (import.meta.main) {
  await main();
}
