import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { addSource, eraseSource } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { analysisPurpose, turnRecallMethod } from "../src/turn-recall.ts";
import { chatOf, says, setObjectEnv, toolResults } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents, loggedEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The recall before a chat's question, from the Brain, with its analysis
// alongside (GRA-1732), through a chat's turns as a person asks them: the
// Workspace, its ChatSession, the gateway, connect and the Brain are real;
// the model provider is the fake behind connect, which answers the
// analysis apart from the turn's script (`analysisReplies`). From the
// ways it can fail: the analysis holds up the answer; a slow, failing or
// steered analysis changes what the first pass found or reaches what the
// person may not read; a turn that needs nothing pays for more than the
// analysis; the model gets what the audit log doesn't hold, or the log
// holds what didn't happen; what a recall handed over is sent again once
// the person may no longer read it, or the agent its grant.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A word no other test's sources hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** An upload's source, as its producer names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** Adds `text` to the Brain as a new source `readers` may read. */
const added = async (text: string, readers: SourceReaders) => {
  const source = newSource();
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/**
 * A new chat of `personId`'s, whose agent holds the `brain` grant, and
 * `revoke`, which revokes it.
 */
const recallingChatOf = async (
  personId: string,
  ...replies: ProviderReply[]
) => {
  const admin = await signedInApi(idp, "admin");
  const chat = await chatOf(personId, ...replies);
  const grant = await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const revoke = async () => {
    await admin.api.permissions.revoke(grant);
  };
  return { ...chat, revoke };
};

/** A chat of a new member's, whose agent holds the `brain` grant. */
const recallingChat = async (...replies: ProviderReply[]) => {
  const person = await signedInWithRole(idp, "user");
  return await recallingChatOf(person.userId, ...replies);
};

/** Every string in `value`, however deep. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((each: unknown) => stringsIn(each));
  }
  return [];
};

const recallHeader = /^\[Recall (?<run>[^\]\s]+)\]\n/u;

/**
 * What the recall before the question handed the model, as `body` (a
 * request to the provider) carried it: the part after its header, the
 * same in every chat for the same pack.
 */
const recallIn = (body: unknown): string | undefined => {
  const part = stringsIn(body).findLast((text) => recallHeader.test(text));
  return part?.replace(recallHeader, "");
};

/** The run of the recall `body` (a request to the provider) carried. */
const recallRunIn = (body: unknown): string | undefined => {
  const part = stringsIn(body).findLast((text) => recallHeader.test(text));
  return part === undefined ? undefined : recallHeader.exec(part)?.groups?.run;
};

/** The analysis's answer: `query`, or nothing to look up. */
const analysed = (
  query: string | null,
  more: Partial<ProviderReply> = {}
): ProviderReply => ({
  text: JSON.stringify({ query }),
  inputTokens: 40,
  outputTokens: 10,
  ...more,
});

/** The audit events of `agentId`'s, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** The audit events of the recall before a question in chat `chatId`. */
const recallsIn = (events: readonly AuditEvent[], chatId: string) =>
  events.filter(
    ({ action, detail }) =>
      action === "agent.call" &&
      detail.method === turnRecallMethod &&
      detail.chat === chatId
  );

/** How each recall event of run `run` in `events` says it ended, in order. */
const outcomesOf = (events: readonly AuditEvent[], run: string | undefined) =>
  events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.method === turnRecallMethod &&
        detail.run === run
    )
    .map(({ detail }) => ({ outcome: detail.outcome, reason: detail.reason }));

/** Whether a warning named `name` was logged in `calls`, the spy's calls. */
const warned = (calls: readonly unknown[], name: string): boolean =>
  JSON.stringify(calls).includes(name);

type Call = (...args: unknown[]) => Promise<unknown>;

/**
 * `namespace` (a Durable Object binding) with each object's `method`
 * answered by `instead`, given the object's own: a fault where the chat
 * meets one of core's objects, as `failingAuditLog` puts one.
 */
const answering = (
  namespace: object,
  method: string,
  instead: (own: Call, ...args: unknown[]) => Promise<unknown>
): object =>
  new Proxy(namespace, {
    get: (target, name): unknown => {
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      if (name === "jurisdiction") {
        return (...args: unknown[]): object =>
          answering(
            // SAFETY: a namespace's `jurisdiction` answers a namespace.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            Reflect.apply(value, target, args) as object,
            method,
            instead
          );
      }
      if (name !== "getByName" && name !== "get") {
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      }
      return (...args: unknown[]): object => {
        // SAFETY: a namespace's `getByName` and `get` answer an object's stub.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        const stub = Reflect.apply(value, target, args) as object;
        return new Proxy(stub, {
          get: (object, property): unknown => {
            const own: unknown = Reflect.get(object, property);
            if (property !== method || typeof own !== "function") {
              return own;
            }
            return async (...called: unknown[]) =>
              await instead(
                async (...again: unknown[]): Promise<unknown> =>
                  await Reflect.apply(own, object, again),
                ...called
              );
          },
        });
      };
    },
  });

/** Runs `work` with the shared env's `vars` set, then puts them back. */
const withEnv = async <T>(
  chat: { stub: Parameters<typeof setObjectEnv>[0] },
  vars: Record<string, unknown>,
  work: () => Promise<T>
): Promise<T> => {
  const restore = await setObjectEnv(chat.stub, vars);
  try {
    return await work();
  } finally {
    await restore();
  }
};

/** Whether `events`, an append's, hold a recall's `ok`. */
const holdsRecalled = (events: unknown): boolean =>
  Array.isArray(events) &&
  events.some(
    (event: AuditEvent) =>
      event.action === "agent.call" &&
      event.detail.method === turnRecallMethod &&
      event.detail.outcome === "ok"
  );

describe("the recall before a chat's question", setUpTime, () => {
  it("hands the model what the question finds without waiting for the analysis, a word nothing holds beside it too, asks none for a first message, and lets the analysis go", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(
      says("Nobody I know of."),
      says("Seven."),
      says("Still seven."),
      says("No idea.")
    );
    await added(fact, owner(chat.personId));
    // The analysis held, each turn: it never answers until let go of.
    chat.provider.analysisReplies.push(
      { hang: true },
      { hang: true },
      { hang: true }
    );
    const warnings = vi.spyOn(console, "warn");
    /** What asking `question` handed over, and whether it waited on the analysis. */
    const asked = async (question: string) => {
      const before = {
        requests: chat.provider.requests.length,
        analyses: chat.provider.analyses.length,
        warnings: warnings.mock.calls.length,
      };
      await chat.ask(question);
      return {
        recalled:
          recallIn(chat.provider.requests[before.requests]?.body)?.includes(
            fact
          ) ?? false,
        analysed: chat.provider.analyses.length > before.analyses,
        // Waited on and given up on: logged as late.
        waited: warned(
          warnings.mock.calls.slice(before.warnings),
          "chat.recall_analysis_late"
        ),
      };
    };
    try {
      // Finds nothing, but has nothing before it to resolve.
      const opening = await asked(`Who keeps the ${word()} keys?`);
      const found = await asked(`When does depot ${depot} open?`);
      const besideUnknown = await asked(
        `When does depot ${depot} open on ${word()} days?`
      );
      // The contrast: a follow-up that finds nothing waits, to its bound.
      const thin = await asked(`Who keeps the ${word()} keys?`);

      expect({ opening, found, besideUnknown, thin }).toStrictEqual({
        opening: { recalled: false, analysed: false, waited: false },
        found: { recalled: true, analysed: true, waited: false },
        besideUnknown: { recalled: true, analysed: true, waited: false },
        thin: { recalled: false, analysed: true, waited: true },
      });
    } finally {
      warnings.mockRestore();
    }
    // Asked alongside, and let go of once each recall ended.
    await vi.waitFor(
      () => {
        expect(
          chat.provider.analyses.every(({ signal }) => signal.aborted)
        ).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("records the recall in the audit log, with its run and how many versions it hands over and never what they say, before the model gets any of it", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat();
    await added(fact, owner(chat.personId));
    // The log as it stood when the model was first asked, straight from
    // it: what an outbox still holds isn't in it.
    let logged: Promise<AuditEvent[]> | undefined;
    const provider = await answeringProvider(() => {
      logged ??= loggedEvents();
      return says("Seven.");
    });

    await chat.ask(`When does depot ${depot} open?`);

    const recalls = recallsIn((await logged) ?? [], chat.chat.id);
    expect({
      recalls: recalls.map(({ detail }) => ({
        versions: detail.versions,
        run: detail.run,
        outcome: detail.outcome,
      })),
      saysWhat: JSON.stringify(recalls).includes(depot),
    }).toStrictEqual({
      recalls: [
        {
          versions: 1,
          run: recallRunIn(provider.requests[0]?.body),
          outcome: "ok",
        },
      ],
      saysWhat: false,
    });
  });

  it("finds what a follow-up with a pronoun means through the second pass", async () => {
    const client = word();
    const lead = word();
    const reference = word();
    const fact = `${lead} offered ${client} twelve percent off the renewal, offer ${reference}`;
    const chat = await recallingChat(
      says(`${lead} leads the ${client} renewal.`),
      says("Twelve percent.")
    );
    await added(fact, owner(chat.personId));
    await added(`${client} renewal is led by ${lead}`, owner(chat.personId));
    await chat.ask(`Who leads the ${client} renewal?`);
    const before = chat.provider.requests.length;
    // Case and edges aside, not the question's own words: a second pass.
    chat.provider.analysisReplies.push(analysed(` ${lead} ${client} OFFER `));

    const reply = await chat.ask("And how big was his discount?");

    const request = chat.provider.requests[before];
    const analysis = JSON.stringify(chat.provider.analyses.at(-1)?.body);
    expect({
      answer: reply.answer,
      // The question's own words find nothing: the evidence came from the
      // analysis's words.
      recalled: recallIn(request?.body)?.includes(reference),
      // The analysis read the chat: the answer naming whom "his" means.
      readTheChat: analysis.includes(`${lead} leads the ${client} renewal.`),
    }).toStrictEqual({
      answer: "Twelve percent.",
      recalled: true,
      readTheChat: true,
    });
  });

  it("makes one model call besides the answer for a follow-up that needs no recall, recorded under the analysis's purpose", async () => {
    const chat = await recallingChat(says("Hello."), says("You're welcome."));
    await chat.ask("Hi!");

    const reply = await chat.ask("Thanks!");

    expect({
      answer: reply.answer,
      answers: chat.provider.requests.length,
      // The first message asked none: nothing before it.
      analyses: chat.provider.analyses.length,
    }).toStrictEqual({ answer: "You're welcome.", answers: 2, analyses: 1 });
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => all.filter(({ action }) => action === "model.call").length >= 3
    );
    // Each with its spend, the analysis's under its own purpose.
    const calls = events.filter(({ action }) => action === "model.call");
    expect({
      calls: calls.length,
      purposes: new Set(calls.map(({ detail }) => detail.purpose)),
      spent: calls.every(({ cost }) => cost !== undefined),
    }).toStrictEqual({
      calls: 3,
      purposes: new Set([analysisPurpose, "chat.turn"]),
      spent: true,
    });
  });

  it("hands over exactly what the first pass found when the analysis fails, is slow, or says nothing", async () => {
    const decoy = word();
    // Thin: none of its words is in anything the person may read, so the
    // analysis is waited for, and a second pass would run on what it says.
    const question = "When does that one shut?";
    // One person's sources, asked of in a new chat of theirs each time.
    const { userId } = await signedInWithRole(idp, "user");
    await added(`Warehouse ${decoy} locks at nine`, owner(userId));
    /** What one chat's recall handed over, with its analysis answering `reply`. */
    const recalledWith = async (reply: ProviderReply) => {
      const chat = await recallingChatOf(
        userId,
        says("Hello."),
        says("At nine.")
      );
      // Something before the question, for the analysis to read.
      await chat.ask("Hi!");
      chat.provider.analysisReplies.push(reply);
      await chat.ask(question);
      return {
        recalled: recallIn(chat.provider.requests[1]?.body),
        analysis: chat.provider.analyses.at(-1),
      };
    };
    const alone = await recalledWith(analysed(null));
    const failing = await recalledWith({
      status: 500,
      errorType: "api_error",
    });
    const slow = await recalledWith({ hang: true });
    // Had the others answered in time with words, they would have found it.
    const steered = await recalledWith(analysed(`warehouse ${decoy}`));

    expect({
      first: alone.recalled?.includes(decoy),
      failing: failing.recalled,
      slow: slow.recalled,
      steered: steered.recalled?.includes(decoy),
    }).toStrictEqual({
      first: false,
      failing: alone.recalled,
      slow: alone.recalled,
      steered: true,
    });
    // The slow one was let go of.
    await vi.waitFor(
      () => {
        expect(slow.analysis?.signal.aborted).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("logs nothing of the question, the chat or what the analysis said when the analysis fails or answers what isn't a query", async () => {
    const secret = word();
    const chat = await recallingChat(
      says("Hello."),
      says("Noted."),
      says("Noted again.")
    );
    await chat.ask("Hi!");
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      chat.provider.analysisReplies.push({
        status: 500,
        errorType: "api_error",
      });
      await chat.ask(`What about ${secret} closes?`);
      chat.provider.analysisReplies.push(analysed(`${secret}\u0000`));
      await chat.ask(`And ${secret} again?`);
      const lines = JSON.stringify(logged.map((spy) => spy.mock.calls));
      expect({
        secret: lines.includes(secret),
        failed: lines.includes("chat.recall_analysis_failed"),
        unusable: lines.includes("chat.recall_analysis_unusable"),
      }).toStrictEqual({ secret: false, failed: true, unusable: true });
    } finally {
      for (const spy of logged) {
        spy.mockRestore();
      }
    }
  });
});

describe("a recall before a question that doesn't hand over", setUpTime, () => {
  it("answers without evidence, told why, when the Brain refuses the recall or it runs past its deadline, and logs how it ended for its run", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."), says("Nor now."));
    await added(fact, owner(chat.personId));
    /** What the model got, with the Brain's recall answering as `recall` does. */
    const askedWith = async (recall: Call) => {
      const before = chat.provider.requests.length;
      await withEnv(
        chat,
        {
          BRAIN_STORE: answering(
            env.BRAIN_STORE,
            "recall",
            async () => await recall()
          ),
        },
        async () => await chat.ask(`When does depot ${depot} open?`)
      );
      const body = chat.provider.requests[before]?.body;
      return { recalled: recallIn(body) ?? "", run: recallRunIn(body) };
    };

    const refused = await askedWith(
      async () => await Promise.reject(new Error("The Brain refused it"))
    );
    // Past the recall's deadline: it never answers.
    const late = await askedWith(
      async () => await Promise.withResolvers<never>().promise
    );

    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length >= 2
    );
    expect({
      refused: {
        fact: refused.recalled.includes(fact),
        told: refused.recalled.includes("The recall failed."),
        logged: outcomesOf(events, refused.run),
      },
      late: {
        fact: late.recalled.includes(fact),
        told: late.recalled.includes("The recall took too long."),
        logged: outcomesOf(events, late.run),
      },
    }).toStrictEqual({
      refused: {
        fact: false,
        told: true,
        logged: [{ outcome: "failed", reason: "internal.unexpected" }],
      },
      late: {
        fact: false,
        told: true,
        logged: [{ outcome: "failed", reason: "internal.unexpected" }],
      },
    });
  });

  it("hands over nothing when the audit log doesn't take the recall, and logs it as failed for its run", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."));
    await added(fact, owner(chat.personId));

    await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) => {
          if (holdsRecalled(events)) {
            throw new Error("Unavailable");
          }
          return await own(events);
        }),
      },
      async () => await chat.ask(`When does depot ${depot} open?`)
    );

    const body = chat.provider.requests[0]?.body;
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length > 0
    );
    expect({
      fact: recallIn(body)?.includes(fact),
      told: recallIn(body)?.includes("The recall failed."),
      logged: outcomesOf(events, recallRunIn(body)),
    }).toStrictEqual({
      fact: false,
      told: true,
      logged: [{ outcome: "failed", reason: "internal.unexpected" }],
    });
  });

  it("logs a recall revoked after it was recorded and before it was handed over as failed for its run, and the turn stops with nothing handed over", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."));
    await added(fact, owner(chat.personId));

    // The grant revoked once the recall's `ok` is on its way to the log,
    // by the test, while the log waits: flags, not promises, as what one
    // object resolves the test can't go on from (its I/O is the object's).
    const step = { reached: false, revoked: false };
    const ended = await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) => {
          if (holdsRecalled(events)) {
            step.reached = true;
            for (let waits = 0; !step.revoked && waits < 500; waits += 1) {
              // oxlint-disable-next-line no-await-in-loop -- until the test revoked
              await scheduler.wait(20);
            }
          }
          return await own(events);
        }),
      },
      async () => {
        // Settled here, either way: a rejection is never left unhandled.
        const asked = chat.ask(`When does depot ${depot} open?`).then(
          () => "answered",
          (error: unknown) => (error instanceof Error ? error.message : "")
        );
        await vi.waitFor(
          () => {
            expect(step.reached).toBeTruthy();
          },
          { timeout: 10_000, interval: 20 }
        );
        await chat.revoke();
        step.revoked = true;
        return await asked;
      }
    );

    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length >= 2
    );
    const runs = new Set(
      recallsIn(events, chat.chat.id).map(({ detail }) => detail.run)
    );
    const [run] = runs;
    expect({
      stopped: ended.includes("can no longer read"),
      runs: runs.size,
      asked: chat.provider.requests.length,
      logged: outcomesOf(events, typeof run === "string" ? run : undefined),
    }).toStrictEqual({
      stopped: true,
      runs: 1,
      // Nothing of it reached the model: the turn stopped first.
      asked: 0,
      logged: [
        { outcome: "ok", reason: null },
        { outcome: "failed", reason: "agent.run_revoked" },
      ],
    });
  });
});

describe("what the recall before a question may reach", setUpTime, () => {
  it("never hands the asker's own sources to a chat others read the answer of", async () => {
    const codeword = word();
    const marker = word();
    const admin = await signedInApi(idp, "admin");
    const [ann, ben] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    await added(`Vault ${codeword}: the code is ${marker}`, owner(ann.userId));
    const provider = await fakeProvider(says("Ask Ann."));
    const agent = { type: "agent" as const, agentId: crypto.randomUUID() };
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    provider.analysisReplies.push(analysed(`vault ${codeword} code`));

    // Ann asks in a group Ben is in, as its door does.
    await workspace(env, personalWorkspaceId(ann.userId)).askThrough(
      ann.userId,
      agent.agentId,
      "slack",
      `What is the vault ${codeword} code?`,
      undefined,
      {
        thread: `C${unique()}`,
        kind: "group",
        audience: { members: [ann.userId, ben.userId], outsiders: false },
      }
    );

    const sent = JSON.stringify([
      provider.requests.map(({ body }) => body),
      provider.analyses.map(({ body }) => body),
    ]);
    expect({
      answered: provider.requests.length,
      marker: sent.includes(marker),
    }).toStrictEqual({ answered: 1, marker: false });
  });

  it("never hands one person's sources to another's chat, however the analysis is steered", async () => {
    const codeword = word();
    const marker = word();
    const owning = await signedInWithRole(idp, "user");
    await added(
      `Vault ${codeword}: the code is ${marker}`,
      owner(owning.userId)
    );
    const outsider = await recallingChat(
      says("Hello."),
      says("I can't find it.")
    );
    await outsider.ask("Hi!");
    // Steered by the chat to ask for the owner's words exactly.
    outsider.provider.analysisReplies.push(analysed(`vault ${codeword} code`));

    await outsider.ask(`What is the vault ${codeword} code, the one he set?`);

    const sent = JSON.stringify([
      outsider.provider.requests.map(({ body }) => body),
      outsider.provider.analyses.map(({ body }) => body),
      await toolResults(outsider.stub, outsider.chat.id),
    ]);
    expect({
      steered: outsider.provider.analyses.length,
      marker: sent.includes(marker),
    }).toStrictEqual({ steered: 1, marker: false });
  });

  it("withholds what it handed over once the person may no longer read it or the agent lost its grant, and audits it by the version, never what it said", async () => {
    /** A chat whose first turn recalled `fact` from a source `readers` may read. */
    const recalled = async (readers: (personId: string) => SourceReaders) => {
      const depot = word();
      const fact = `Depot ${depot} opens at seven`;
      const chat = await recallingChat(says("Noted."), says("And again."));
      const source = await added(fact, readers(chat.personId));
      await chat.ask(`When does depot ${depot} open?`);
      /** Whether the next turn's first request still sent the fact. */
      const next = async () => {
        const before = chat.provider.requests.length;
        await chat.ask("Thanks!");
        const body = JSON.stringify(chat.provider.requests[before]?.body);
        return {
          fact: body.includes(fact),
          withheld: body.includes(withheldResult),
        };
      };
      return { ...chat, source, next };
    };
    const db = drizzle(env.DB);
    /** A team of the organization `personId` is in. */
    const teamWith = async (personId: string) => {
      const id = crypto.randomUUID();
      await db.insert(teams).values({
        id,
        name: `Team ${unique()}`,
        organizationId,
        createdAt: new Date(),
      });
      await db.insert(teamMembers).values({
        id: crypto.randomUUID(),
        teamId: id,
        userId: personId,
        createdAt: new Date(),
      });
      return id;
    };

    const kept = await recalled((personId) => owner(personId));
    const unchanged = await kept.next();
    const erased = await recalled((personId) => owner(personId));
    await eraseSource(env, { source: erased.source, reason: "deleted" });
    const afterErase = await erased.next();
    const revoked = await recalled((personId) => owner(personId));
    await revoked.revoke();
    const afterRevoke = await revoked.next();
    // A team's source, read while the person was in the team.
    const person = await signedInWithRole(idp, "user");
    const teamId = await teamWith(person.userId);
    const depot = word();
    const fact = `Depot ${depot} opens at nine`;
    const teamChat = await recallingChatOf(
      person.userId,
      says("Noted."),
      says("Ok.")
    );
    await added(fact, { kind: "team", teamId });
    await teamChat.ask(`When does depot ${depot} open?`);
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, person.userId)
        )
      );
    await teamChat.ask("Thanks!");
    const afterLeaving = JSON.stringify(teamChat.provider.requests[1]?.body);

    expect({
      unchanged,
      afterErase,
      afterRevoke,
      afterLeaving: {
        fact: afterLeaving.includes(fact),
        withheld: afterLeaving.includes(withheldResult),
      },
    }).toStrictEqual({
      unchanged: { fact: true, withheld: false },
      afterErase: { fact: false, withheld: true },
      afterRevoke: { fact: false, withheld: true },
      afterLeaving: { fact: false, withheld: true },
    });
    const events = await eventsOf(erased.agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );
    const withheld = events.filter(
      ({ action }) => action === "chat.history_withheld"
    );
    expect({
      sources: withheld.map(({ detail }) => detail.source),
      // Each withheld after the recall that read it was in the log.
      recordedBefore: withheld.every(
        (event) =>
          recallsIn(events.slice(0, events.indexOf(event)), erased.chat.id)
            .length > 0
      ),
    }).toStrictEqual({
      sources: [
        `brain-version:${JSON.stringify(["upload", erased.source.id, 1])}`,
      ],
      recordedBefore: true,
    });
  });
});
