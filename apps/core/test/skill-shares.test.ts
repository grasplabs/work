import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import type { Authority } from "@grasp-os/shared/permissions";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { SkillsOverview } from "@grasp-os/shared/skills";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { erasePerson } from "../src/brain-next.ts";
import {
  readSkillFor,
  selectSkillsFor,
  skillsFor,
  skillsReachOf,
} from "../src/brain-skills.ts";
import type { SkillAt } from "../src/brain-skills.ts";
import { skillShares } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { approveShare, retireSkill } from "../src/skill-shares.ts";
import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
import { eventsAfterWithHead, logHead } from "./audit-events.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { actingFor } from "./contexts.ts";
import { failingAuditLog } from "./failing-audit-log.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Writing skills and sharing one with the company (GRA-1754), from the
// threat model on the issue: someone else reads, lists or is given a
// person's own skill; a person's own skill reaches a chat others share;
// a skill becomes the company's without an admin's approval, or with text
// the admin never saw (an edit after asking, a share asked again); a
// decision reads as done when the Brain doesn't have it; a retired skill
// is still used; a deleted one comes back. That no other way in answers a
// person's own skill, the permission harness tries
// (brain-next-leaks.test.ts).

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A `SKILL.md` named `name`, for `description`, with `steps`. */
const skillText = (name: string, description: string, steps = "The steps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${steps}\n`;

/** A chat's agent acting for `userId`. */
const agentOf = (userId: string): Authority =>
  actingFor({ type: "agent", agentId: `agent-${unique()}` }, userId);

/** The scope and name of each skill `userId`'s chat may use, of `names`. */
const usable = async (
  userId: string,
  personal: boolean,
  names: readonly string[]
): Promise<string[][]> => {
  const listed = await skillsFor(env, agentOf(userId), { personal });
  return listed
    .filter(({ name }) => names.includes(name))
    .map(({ scope, name }) => [scope, name]);
};

/** The scope and name of each skill selected for `task` in `userId`'s chat. */
const selected = async (
  userId: string,
  personal: boolean,
  task: string
): Promise<string[][]> => {
  const skills = await selectSkillsFor(
    env,
    agentOf(userId),
    { personal },
    { task }
  );
  return skills.map(({ scope, name }) => [scope, name]);
};

/** The text of `skill` as `userId`'s chat reads it, or why it can't. */
const readIn = async (
  userId: string,
  personal: boolean,
  skill: SkillAt
): Promise<string> => {
  let text = "";
  const read = async () => {
    ({ text } = await readSkillFor(
      env,
      agentOf(userId),
      { personal },
      { skill }
    ));
  };
  const how = await outcome(read());
  return how === "ok" ? text : how;
};

/** What `api`'s skills page shows. */
const overviewOf = async (api: SessionApi): Promise<SkillsOverview> =>
  await api.skills.overview();

/** The text the share `id` keeps. */
const keptText = async (id: string): Promise<(string | null)[]> => {
  const rows = await drizzle(env.DB)
    .select({ text: skillShares.text })
    .from(skillShares)
    .where(eq(skillShares.id, id));
  return rows.map(({ text }) => text);
};

/** The Brain's namespace, as core reaches it. */
const namespace = () => inJurisdiction(env, env.BRAIN_STORE);

/** What the shared store and `personId`'s own have of `key`. */
const keptWhere = async (personId: string, key: string) => ({
  shared: await brainOf(namespace()).keyState(key),
  own: await personalBrainOf(namespace(), personId).keyState(key),
});

/** The chat's code: the skills `env.skills` selects for quoting a tender. */
const selectsForATender = codeStep(
  'export default async (self, env) => { const { skills } = await env.skills.select({ task: "quote a tender" }); return skills.map(({ scope, name }) => scope + ":" + name).join(",") || "none"; };'
);

/** Every string in `value`, however deep: what a request to the model carried. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((each: unknown) => stringsIn(each));
  }
  return [];
};

/** What each of the chat's code runs returned. */
const returnedIn = async (
  stub: Parameters<typeof codeResults>[0],
  chatId: string
): Promise<string[]> => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => text);
};

/** The skill events after log position `head`: their actions, oldest first. */
const skillEventsAfter = async (head: number): Promise<string[]> => {
  const { events } = await eventsAfterWithHead(head);
  return events
    .filter(({ action }) => action.startsWith("skill."))
    .map(({ action }) => action);
};

/** Core's env with the shared store's `method` out of reach. */
const sharedStoreFailing = (method: string): Env => {
  const binding = env.BRAIN_STORE;
  const getByName = (named: string) => {
    const stub = binding.getByName(named);
    if (named !== "brain") {
      return stub;
    }
    return new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === method) {
          return async () =>
            await Promise.reject(new Error("Out of reach, for the test"));
        }
        // Called through, never bound: an RPC stub takes `bind` for a
        // method of the store.
        return async (...args: unknown[]): Promise<unknown> => {
          const answered: unknown = await Reflect.apply(value, target, args);
          return answered;
        };
      },
    });
  };
  return {
    ...env,
    BRAIN_STORE: new Proxy(binding, {
      get: (target, property): unknown =>
        property === "getByName" ? getByName : Reflect.get(target, property),
    }),
  };
};

/** A call out of reach. */
const refused = async () =>
  await Promise.reject(new Error("Out of reach, for the test"));

/** Something run around a call of the shared store; `"lose"` after one throws its answer away. */
type Hook = () => Promise<unknown>;

/**
 * Core's env whose shared store runs `before[method][n]` ahead of that
 * method's n-th call (from 1), and `after[method][n]` once it answered:
 * what lands while a call is on its way. An after hook answering `"lose"`
 * loses the reply, as a dropped connection would, after the store wrote.
 */
const hooked = (hooks: {
  before?: Record<string, Record<number, Hook>>;
  after?: Record<string, Record<number, Hook>>;
}): Env => {
  const calls = new Map<string, number>();
  const binding = env.BRAIN_STORE;
  const getByName = (named: string) => {
    const stub = binding.getByName(named);
    if (named !== "brain") {
      return stub;
    }
    return new Proxy(stub, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          const call = (calls.get(property) ?? 0) + 1;
          calls.set(property, call);
          await hooks.before?.[property]?.[call]?.();
          const answered: unknown = await Reflect.apply(value, target, args);
          if ((await hooks.after?.[property]?.[call]?.()) === "lose") {
            throw new Error("Reply lost, for the test");
          }
          return answered;
        };
      },
    });
  };
  return {
    ...env,
    BRAIN_STORE: new Proxy(binding, {
      get: (target, property): unknown =>
        property === "getByName" ? getByName : Reflect.get(target, property),
    }),
  };
};

/** Core's env whose shared store runs `hooks[n]` ahead of its n-th add. */
const sharedStoreHooks = (hooks: Record<number, Hook>): Env =>
  hooked({ before: { addInstructions: hooks } });

/** Core's env with its database refusing what `refuses` picks, as one out of reach would. */
const databaseRefusing = (refuses: {
  sql?: RegExp;
  batches?: boolean;
  /** Refuses every batch from this one on (from 1). */
  batchesFrom?: number;
}): Env => {
  const database = env.DB;
  let batches = 0;
  /** The statements refused, alone or in a batch. */
  const refusedStatements = new WeakSet<object>();
  return {
    ...env,
    DB: new Proxy(database, {
      get: (target, property): unknown => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batches += 1;
            if (
              refuses.batches === true ||
              (refuses.batchesFrom !== undefined &&
                batches >= refuses.batchesFrom) ||
              statements.some((statement) => refusedStatements.has(statement))
            ) {
              return await refused();
            }
            return await target.batch(statements);
          };
        }
        if (property === "prepare" && refuses.sql !== undefined) {
          const { sql } = refuses;
          return (query: string) => {
            if (!sql.test(query)) {
              return target.prepare(query);
            }
            const statement = {
              bind: () => statement,
              run: refused,
              all: refused,
              first: refused,
              raw: refused,
            };
            refusedStatements.add(statement);
            return statement;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
};

/** The company's live skill `name` as members read it: its description and version. */
const liveOf = async (api: SessionApi, name: string) => {
  const page = await overviewOf(api);
  return page.company
    .filter((skill) => skill.name === name)
    .map(({ description, version }) => [description, version]);
};

/** Each of `shares` as its asker's page shows it: status and version. */
const rowsOf = async (
  shares: readonly { api: SessionApi; id: string }[]
): Promise<(string | number | null)[][]> => {
  const rows: (string | number | null)[][] = [];
  for (const { api, id } of shares) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const page = await overviewOf(api);
    rows.push(
      ...page.shares
        .filter((share) => share.id === id)
        .map(({ status, version }) => [status, version])
    );
  }
  return rows;
};

/** A fresh skill name. */
const nameOf = (what: string): string => `${what}-${unique()}`;

describe("writing and sharing skills", setUpTime, () => {
  it("keeps a person's own skill theirs: used in their own chat, never in a shared one, never by anyone else", async () => {
    const [author, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("quote-a-tender");
    const description = "Quote a tender for a new customer";
    const first = await author.api.skills.save(skillText(name, description));
    const edited = await author.api.skills.save(
      skillText(name, description, "Newer steps.")
    );
    const current = { scope: "person", name, version: edited.version } as const;
    const authorPage = await overviewOf(author.api);
    const otherPage = await overviewOf(other.api);

    expect({
      versions: [first.version, edited.version],
      ownPage: authorPage.own.filter((skill) => skill.name === name),
      ownChat: await usable(author.userId, true, [name]),
      sharedChat: await usable(author.userId, false, [name]),
      selectedInOwnChat: await selected(author.userId, true, "quote a tender"),
      selectedInSharedChat: await selected(
        author.userId,
        false,
        "quote a tender"
      ),
      read: await readIn(author.userId, true, current),
      readInSharedChat: await readIn(author.userId, false, current),
      otherPage: otherPage.own,
      otherChat: await usable(other.userId, true, [name]),
      otherSelects: await selected(other.userId, true, "quote a tender"),
      otherReads: await readIn(other.userId, true, current),
      otherReadsOnPage: await outcome(other.api.skills.read("own", name)),
      otherShares: await outcome(other.api.skills.share(name, 1)),
    }).toStrictEqual({
      versions: [1, 2],
      ownPage: [{ name, version: 2, description }],
      ownChat: [["person", name]],
      sharedChat: [],
      selectedInOwnChat: [["person", name]],
      selectedInSharedChat: [],
      read: skillText(name, description, "Newer steps."),
      readInSharedChat: "skills.not_found",
      otherPage: [],
      otherChat: [],
      otherSelects: [],
      otherReads: "skills.not_found",
      otherReadsOnPage: "skills.not_found",
      otherShares: "skills.not_found",
    });
  });

  it("makes a skill the company's only on an admin's approval, of exactly the text the admin was shown", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("close-the-month");
    const asked = skillText(name, "Close the month", "The steps as asked.");
    const saved = await author.api.skills.save(asked);
    const share = await author.api.skills.share(name, saved.version);
    // Edited after asking: the edit isn't what the admin approves.
    await author.api.skills.save(
      skillText(name, "Close the month", "Steps nobody reviewed.")
    );
    const waiting = await overviewOf(admin.api);
    const authorBefore = await overviewOf(author.api);
    const memberBefore = await overviewOf(member.api);
    const before = {
      memberUsesBefore: await usable(member.userId, true, [name]),
      notAdmin: await outcome(member.api.skills.approve(share.id)),
      authorDecides: await outcome(author.api.skills.approve(share.id)),
    };

    const approved = await admin.api.skills.approve(share.id);
    const memberAfter = await overviewOf(member.api);
    const read = await member.api.skills.read("company", name);
    const twice = await outcome(admin.api.skills.approve(share.id));
    const declinedAfter = await outcome(admin.api.skills.decline(share.id));
    const authorAfter = await overviewOf(author.api);

    expect({
      request: waiting.requests
        ?.filter(({ id }) => id === share.id)
        .map((request) => ({
          name: request.name,
          status: request.status,
          text: request.text,
          replaces: request.replaces,
          by: request.requestedBy.userId,
        })),
      authorSeesRequests: authorBefore.requests,
      memberSeesRequests: memberBefore.requests,
      ...before,
      approved: [approved.status, approved.version],
      memberUses: await usable(member.userId, false, [name]),
      company: memberAfter.company.find((skill) => skill.name === name),
      read: read.text,
      selected: await selected(member.userId, false, "close the month"),
      twice,
      declinedAfter,
      authorsShares: authorAfter.shares.map(({ id, status }) => [id, status]),
      // The text is the company's now, in the Brain: the share keeps none.
      kept: await keptText(share.id),
    }).toStrictEqual({
      request: [
        {
          name,
          status: "pending",
          text: asked,
          replaces: null,
          by: author.userId,
        },
      ],
      authorSeesRequests: null,
      memberSeesRequests: null,
      memberUsesBefore: [],
      notAdmin: "role.forbidden",
      authorDecides: "role.forbidden",
      approved: ["approved", 1],
      memberUses: [["company", name]],
      company: { name, version: 1, description: "Close the month" },
      read: asked,
      selected: [["company", name]],
      twice: "ok",
      declinedAfter: "skills.not_found",
      authorsShares: [[share.id, "approved"]],
      kept: [null],
    });
  });

  it("refuses an approval of a share asked again, and drops a declined share's text", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("book-travel");
    const first = await author.api.skills.save(skillText(name, "Book travel"));
    const shown = await author.api.skills.share(name, first.version);
    const second = await author.api.skills.save(
      skillText(name, "Book travel", "Other steps.")
    );
    const again = await author.api.skills.share(name, second.version);

    const approvingShown = await outcome(admin.api.skills.approve(shown.id));
    const declined = await admin.api.skills.decline(again.id);
    const page = await overviewOf(admin.api);

    expect({
      approvingShown,
      declined: declined.status,
      kept: await keptText(again.id),
      approvingDeclined: await outcome(admin.api.skills.approve(again.id)),
      memberUses: await usable(member.userId, true, [name]),
      waiting: page.requests?.filter((request) => request.name === name),
    }).toStrictEqual({
      approvingShown: "skills.not_found",
      declined: "declined",
      kept: [null],
      approvingDeclined: "skills.not_found",
      memberUses: [],
      waiting: [],
    });
  });

  it("finishes an approval whose add to the Brain failed when it is approved again", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("count-stock");
    const text = skillText(name, "Count the stock");
    const saved = await author.api.skills.save(text);
    const share = await author.api.skills.share(name, saved.version);
    // Broken between the decision and the Brain's add: the Brain refuses
    // what the share holds now.
    const db = drizzle(env.DB);
    await db
      .update(skillShares)
      .set({ text: "no skill at all" })
      .where(eq(skillShares.id, share.id));

    const failed = await outcome(admin.api.skills.approve(share.id));
    const authorPage = await overviewOf(author.api);
    const adminPage = await overviewOf(admin.api);
    const halfway = {
      failed,
      shares: authorPage.shares
        .filter(({ id }) => id === share.id)
        .map(({ status, version }) => [status, version]),
      memberUsesHalfway: await usable(member.userId, false, [name]),
      stillToFinish: adminPage.requests
        ?.filter(({ id }) => id === share.id)
        .map(({ status }) => status),
    };
    await db
      .update(skillShares)
      .set({ text })
      .where(eq(skillShares.id, share.id));
    const finished = await admin.api.skills.approve(share.id);

    expect({
      ...halfway,
      finished: [finished.status, finished.version],
      memberUses: await usable(member.userId, false, [name]),
    }).toStrictEqual({
      failed: "skills.invalid",
      shares: [["approved", null]],
      memberUsesHalfway: [],
      stillToFinish: ["approved"],
      finished: ["approved", 1],
      memberUses: [["company", name]],
    });
  });

  it("retires a company skill for everyone, keeps it as history, and brings it back on a new approval", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("file-expenses");
    const saved = await author.api.skills.save(
      skillText(name, "File expenses")
    );
    const first = await author.api.skills.share(name, saved.version);
    await admin.api.skills.approve(first.id);

    const memberRetires = await outcome(member.api.skills.retire(name));
    await admin.api.skills.retire(name);
    const retired = {
      memberRetires,
      memberUses: await usable(member.userId, true, [name]),
      readsV1: await readIn(member.userId, false, {
        scope: "company",
        name,
        version: 1,
      }),
      retiredAgain: await outcome(admin.api.skills.retire(name)),
    };
    const again = await author.api.skills.share(name, saved.version);
    const page = await overviewOf(admin.api);
    const back = await admin.api.skills.approve(again.id);

    expect({
      ...retired,
      replaces: page.requests?.find(({ id }) => id === again.id)?.replaces,
      back: back.version,
      memberUsesAgain: await usable(member.userId, true, [name]),
    }).toStrictEqual({
      memberRetires: "role.forbidden",
      memberUses: [],
      readsV1: "skills.not_found",
      // Retired already: the store answers the retirement it made.
      retiredAgain: "ok",
      replaces: null,
      // Version 2 was the retirement: history, read by no one.
      back: 3,
      memberUsesAgain: [["company", name]],
    });
  });

  it("erases a person's own skill for good, with the share of it that waits", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("onboard-a-hire");
    const saved = await author.api.skills.save(
      skillText(name, "Onboard a hire")
    );
    const share = await author.api.skills.share(name, saved.version);

    await author.api.skills.remove(name);
    await author.api.skills.remove(name);
    const page = await overviewOf(author.api);

    expect({
      own: page.own.filter((skill) => skill.name === name),
      reads: await readIn(author.userId, true, {
        scope: "person",
        name,
        version: saved.version,
      }),
      approving: await outcome(admin.api.skills.approve(share.id)),
      // Its key is closed for good: a save of the name is refused.
      savedAgain: await outcome(
        author.api.skills.save(skillText(name, "Onboard a hire"))
      ),
    }).toStrictEqual({
      own: [],
      reads: "skills.not_found",
      approving: "skills.not_found",
      savedAgain: "skills.name_erased",
    });
  });

  it("lists a share for the organization's admins alone in what waits", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("plan-a-route");
    const saved = await author.api.skills.save(skillText(name, "Plan a route"));
    const share = await author.api.skills.share(name, saved.version);
    const kindsFor = async (api: SessionApi) => {
      const { items } = await api.waiting.list();
      return items
        .filter((item) => item.id === `skillShare:${share.id}`)
        .map((item) => [item.kind, item.waitsOn.type]);
    };

    expect({
      admin: await kindsFor(admin.api),
      author: await kindsFor(author.api),
      member: await kindsFor(member.api),
    }).toStrictEqual({
      admin: [["skillShare", "admin"]],
      author: [],
      member: [],
    });
  });

  it("refuses text that isn't a skill", async () => {
    const author = await signedInApi(idp, "user");
    expect({
      noCard: await outcome(author.api.skills.save("Just some steps.")),
      badName: await outcome(
        author.api.skills.save(skillText("Not A Name", "Something"))
      ),
      badYaml: await outcome(author.api.skills.save("---\nname: [x\n---\n")),
    }).toStrictEqual({
      noCard: "skills.invalid",
      badName: "skills.invalid",
      badYaml: "skills.invalid",
    });
  });

  it("keeps a person's own skill in their own store alone, and the company's in the shared one only once approved", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("count-the-till");
    const saved = await author.api.skills.save(skillText(name, "Count it"));
    const own = await keptWhere(author.userId, `skill:person:${name}`);
    const share = await author.api.skills.share(name, saved.version);
    const asked = await keptWhere(author.userId, `skill:company:${name}`);
    await admin.api.skills.approve(share.id);

    expect({
      own,
      asked,
      approved: await keptWhere(author.userId, `skill:company:${name}`),
    }).toStrictEqual({
      own: { shared: "free", own: "held" },
      asked: { shared: "free", own: "free" },
      approved: { shared: "held", own: "free" },
    });
  });

  it("steers only the turns its person asks in their own web chat: never a woken turn, a chat app's direct chat, a thread others share, or anyone else's chat", async () => {
    const [author, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("quote-a-tender");
    await author.api.skills.save(skillText(name, "Quote a tender"));
    const listed = `- ${name} (person`;
    /** Whether each request to the model listed the skill. */
    const listedIn = (requests: { body: unknown }[]) =>
      requests.map(({ body }) =>
        stringsIn(body).some((text) => text.includes(listed))
      );

    const own = await chatOf(
      author.userId,
      selectsForATender,
      says("Done."),
      selectsForATender,
      says("Done.")
    );
    await own.ask("Quote a tender.");
    await own.stub.askUnattended(own.chat.id, {
      text: "Quote a tender.",
      model,
    });
    const ownTurns = {
      selected: await returnedIn(own.stub, own.chat.id),
      listed: listedIn(own.provider.requests),
    };

    const others = await chatOf(other.userId, selectsForATender, says("Done."));
    await others.ask("Quote a tender.");

    const group = workspace(env, personalWorkspaceId(author.userId));
    const groupProvider = await fakeProvider(selectsForATender, says("Done."));
    const { chatId } = await group.askThrough(
      author.userId,
      crypto.randomUUID(),
      "slack",
      "Quote a tender.",
      undefined,
      {
        thread: `C-${unique()}`,
        kind: "group",
        audience: { members: [author.userId, other.userId], outsiders: false },
      }
    );
    const sharedThread = {
      selected: await returnedIn(group, chatId),
      listed: listedIn(groupProvider.requests),
    };
    /**
     * A direct chat with the agent in `platform`: what the person's own
     * skills steer there. The chat app keeps the message where its admins
     * and exports reach it, so it doesn't answer them alone (GRA-1821).
     */
    const directIn = async (platform: string) => {
      const provider = await fakeProvider(selectsForATender, says("Done."));
      const direct = await group.askThrough(
        author.userId,
        crypto.randomUUID(),
        platform,
        "Quote a tender."
      );
      return {
        selected: await returnedIn(group, direct.chatId),
        listed: listedIn(provider.requests),
      };
    };
    const teamsDirect = await directIn("teams");
    const slackDirect = await directIn("slack");

    expect({
      ownTurns,
      teamsDirect,
      slackDirect,
      othersChat: {
        selected: await returnedIn(others.stub, others.chat.id),
        listed: listedIn(others.provider.requests),
      },
      sharedThread,
    }).toStrictEqual({
      ownTurns: {
        selected: [`Returned:\nperson:${name}`, "Returned:\nnone"],
        listed: [true, true, false, false],
      },
      teamsDirect: { selected: ["Returned:\nnone"], listed: [false, false] },
      slackDirect: { selected: ["Returned:\nnone"], listed: [false, false] },
      othersChat: {
        selected: ["Returned:\nnone"],
        listed: [false, false],
      },
      sharedThread: { selected: ["Returned:\nnone"], listed: [false, false] },
    });
  });

  it("goes with its person's erasure, and leaves what they shared with the company", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const shared = nameOf("close-the-books");
    const kept = nameOf("my-own-way");
    const first = await author.api.skills.save(skillText(shared, "Close it"));
    await author.api.skills.save(skillText(kept, "Mine"));
    const share = await author.api.skills.share(shared, first.version);
    await admin.api.skills.approve(share.id);
    const before = await usable(author.userId, true, [shared, kept]);

    const erasing = {
      personId: author.userId,
      reason: "person_erased",
    } as const;
    await Promise.allSettled([erasePerson(env, erasing)]);
    await ageOwnErasure(author.userId);
    await erasePerson(env, erasing);

    expect({
      before,
      theirs: await usable(author.userId, true, [shared, kept]),
      members: await usable(member.userId, true, [shared, kept]),
    }).toStrictEqual({
      // Their own of a name takes the company's place, for them alone.
      before: [
        ["person", shared],
        ["person", kept],
      ],
      theirs: [["company", shared]],
      members: [["company", shared]],
    });
  });

  it("tells an admin what approving replaces for everyone: one of the company's skills, or one of Grasp's own", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const companys = nameOf("pay-suppliers");
    const first = await author.api.skills.save(skillText(companys, "Pay"));
    const firstShare = await author.api.skills.share(companys, first.version);
    await admin.api.skills.approve(firstShare.id);
    const again = await author.api.skills.save(
      skillText(companys, "Pay", "Newer steps.")
    );
    const replacing = await author.api.skills.share(companys, again.version);
    // Grasp ships a skill of this name: a company skill of it takes its
    // place for everyone, so the admin is told.
    const grasps = "draw-a-workflow";
    const planted = await author.api.skills.save(skillText(grasps, "Mine"));
    const overGrasp = await author.api.skills.share(grasps, planted.version);
    const fresh = nameOf("count-pallets");
    const freshSaved = await author.api.skills.save(skillText(fresh, "Count"));
    const nothing = await author.api.skills.share(fresh, freshSaved.version);
    const page = await overviewOf(admin.api);
    const replaces = (id: string) =>
      page.requests?.find((request) => request.id === id)?.replaces;

    expect({
      company: replaces(replacing.id),
      grasp: replaces(overGrasp.id),
      fresh: replaces(nothing.id),
    }).toStrictEqual({ company: "company", grasp: "grasp", fresh: null });
  });

  it("approves a share two admins approve at once once: one version, one approved event", async () => {
    const [author, first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("race");
    const saved = await author.api.skills.save(skillText(name, "Race"));
    const share = await author.api.skills.share(name, saved.version);
    const head = await logHead();
    const [x, y] = await Promise.all([
      outcome(first.api.skills.approve(share.id)),
      outcome(second.api.skills.approve(share.id)),
    ]);
    const page = await overviewOf(first.api);

    expect({
      x,
      y,
      company: page.company
        .filter((skill) => skill.name === name)
        .map(({ version }) => version),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      x: "ok",
      y: "ok",
      company: [1],
      events: ["skill.share.approved", "skill.share.added"],
    });
  });

  it("audits each action of a share's life once, never with the skill's text", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("audit");
    const head = await logHead();
    const saved = await author.api.skills.save(skillText(name, "Audit"));
    const declined = await author.api.skills.share(name, saved.version);
    await admin.api.skills.decline(declined.id);
    const approved = await author.api.skills.share(name, saved.version);
    await admin.api.skills.approve(approved.id);
    await admin.api.skills.retire(name);
    const { events } = await eventsAfterWithHead(head);

    expect(
      events
        .filter(({ action }) => action.startsWith("skill."))
        .map((event) => [event.action, JSON.stringify(event).includes("steps")])
    ).toStrictEqual([
      ["skill.share.requested", false],
      ["skill.share.declined", false],
      ["skill.share.requested", false],
      ["skill.share.approved", false],
      ["skill.share.added", false],
      ["skill.retired", false],
      ["skill.retire_done", false],
    ]);
  });

  it("audits an approval before its add, says a failed add, and finishes it once without auditing it twice", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("count-cash");
    const saved = await author.api.skills.save(skillText(name, "Count"));
    const share = await author.api.skills.share(name, saved.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    const failed = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, share.id)
    );
    const halfway = {
      failed,
      events: await skillEventsAfter(head),
      memberUses: await usable(member.userId, false, [name]),
    };
    const finished = await admin.api.skills.approve(share.id);

    expect({
      ...halfway,
      finished: [finished.status, finished.version],
      events: await skillEventsAfter(head),
      memberUsesAfter: await usable(member.userId, false, [name]),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      memberUses: [],
      finished: ["approved", 1],
      events: [
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
      memberUsesAfter: [["company", name]],
    });
  });

  it("finishes an approval whose version wasn't recorded after its add, adding and auditing nothing twice", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("file-receipts");
    const saved = await author.api.skills.save(skillText(name, "File"));
    const share = await author.api.skills.share(name, saved.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    const failed = await outcome(
      approveShare(
        databaseRefusing({ sql: /update "skill_shares" set .*"version"/iu }),
        deciding,
        share.id
      )
    );
    const finished = await admin.api.skills.approve(share.id);
    const page = await overviewOf(admin.api);

    expect({
      failed,
      finished: [finished.status, finished.version],
      company: page.company
        .filter((skill) => skill.name === name)
        .map(({ version }) => version),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      finished: ["approved", 1],
      company: [1],
      events: ["skill.share.approved", "skill.share.added"],
    });
  });

  it("retires nothing it couldn't audit first", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("lock-up");
    const saved = await author.api.skills.save(skillText(name, "Lock"));
    const share = await author.api.skills.share(name, saved.version);
    await admin.api.skills.approve(share.id);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    const failed = await outcome(
      retireSkill(databaseRefusing({ batches: true }), deciding, name)
    );

    expect({
      failed,
      memberUses: await usable(member.userId, false, [name]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      memberUses: [["company", name]],
      events: [],
    });
  });

  it("leaves a decision with no outcome when its attempt stops between the decision and the add", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("weigh-parcels");
    const saved = await author.api.skills.save(skillText(name, "Weigh"));
    const share = await author.api.skills.share(name, saved.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();
    // Nothing after the decision gets through: not the add, not its
    // outcome, as a Worker stopped half-way.
    const stopped = {
      ...sharedStoreFailing("addInstructions"),
      AUDIT_LOG: failingAuditLog(),
    };

    await outcome(approveShare(stopped, deciding, share.id));

    await expect(skillEventsAfter(head)).resolves.toStrictEqual([
      "skill.share.approved",
    ]);
  });

  it("retires again after a retirement whose Brain write failed, auditing each attempt's outcome", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("shut-down");
    const saved = await author.api.skills.save(skillText(name, "Shut"));
    const share = await author.api.skills.share(name, saved.version);
    await admin.api.skills.approve(share.id);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    const failed = await outcome(
      retireSkill(sharedStoreFailing("addInstructions"), deciding, name)
    );
    const page = await overviewOf(admin.api);
    const memberUses = await usable(member.userId, false, [name]);
    const again = await outcome(admin.api.skills.retire(name));
    const { events } = await eventsAfterWithHead(head);

    expect({
      failed,
      listed: page.company.filter((skill) => skill.name === name).length,
      memberUses,
      again,
      after: await usable(member.userId, false, [name]),
      events: events
        .filter(({ action }) => action.startsWith("skill."))
        .map(({ action, detail }) => [action, detail]),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      listed: 1,
      memberUses: [["company", name]],
      again: "ok",
      after: [],
      events: [
        ["skill.retired", {}],
        ["skill.retire_failed", {}],
        ["skill.retired", {}],
        ["skill.retire_done", { version: 1 }],
      ],
    });
  });

  it("gives a person's own skills only to a scope that says it is their own attended turn", () => {
    expect({
      saysNothing: skillsReachOf({}),
      saysNo: skillsReachOf({ ownChat: false }),
      ownTurn: skillsReachOf({ ownChat: true }),
    }).toStrictEqual({
      saysNothing: { personal: false },
      saysNo: { personal: false },
      ownTurn: { personal: true },
    });
  });

  it("fails an older approval whose add a newer one overtook, and lands it over the newer once approved again", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("older-and-newer");
    const older = await a.api.skills.save(skillText(name, "Older"));
    const olderShare = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "Newer"));
    const newerShare = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // The newer one is approved, and added, while the older add is on its
    // way: the store refuses the older add over a version it didn't see.
    const first = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => await admin.api.skills.approve(newerShare.id),
        }),
        deciding,
        olderShare.id
      )
    );
    const retry = await outcome(admin.api.skills.approve(olderShare.id));

    expect({
      first,
      retry,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: olderShare.id },
        { api: b.api, id: newerShare.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "skills.changed",
      retry: "ok",
      // The last add to land is live.
      live: [["Older", 2]],
      rows: [
        ["approved", 2],
        ["approved", 1],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
    });
  });

  it("leaves only the add that landed live when three approvals of one name race, the others approved and not added", async () => {
    const [a, b, c, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("three-ways");
    const shareOfText = async (api: SessionApi, text: string) => {
      const saved = await api.skills.save(skillText(name, text));
      return await api.skills.share(name, saved.version);
    };
    const sa = await shareOfText(a.api, "A");
    const sb = await shareOfText(b.api, "B");
    const sc = await shareOfText(c.api, "C");
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // While A's add is on its way, B is approved; while B's is, C is
    // approved and added in full.
    const first = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () =>
            await outcome(
              approveShare(
                sharedStoreHooks({
                  1: async () => await admin.api.skills.approve(sc.id),
                }),
                deciding,
                sb.id
              )
            ),
        }),
        deciding,
        sa.id
      )
    );

    expect({
      first,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
        { api: c.api, id: sc.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "skills.changed",
      live: [["C", 1]],
      // A's and B's adds never landed: approved, not added yet.
      rows: [
        ["approved", null],
        ["approved", null],
        ["approved", 1],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.share.approve_failed",
        "skill.share.approve_failed",
      ],
    });
  });

  it("never undoes a retirement with an older add on its way, which fails and waits to be approved again", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("retired-meanwhile");
    const older = await a.api.skills.save(skillText(name, "Older"));
    const olderShare = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "Newer"));
    const newerShare = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // The newer one is approved and the skill retired while the older
    // add is on its way.
    const first = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => {
            await admin.api.skills.approve(newerShare.id);
            await admin.api.skills.retire(name);
          },
        }),
        deciding,
        olderShare.id
      )
    );

    expect({
      first,
      live: await liveOf(member.api, name),
      memberUses: await usable(member.userId, false, [name]),
      rows: await rowsOf([
        { api: a.api, id: olderShare.id },
        { api: b.api, id: newerShare.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "skills.changed",
      live: [],
      memberUses: [],
      rows: [
        ["approved", null],
        ["approved", 1],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.retired",
        "skill.retire_done",
        "skill.share.approve_failed",
      ],
    });
  });

  it("fails an approval whose company skill changed meanwhile with no later approval, and adds it once approved again", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("changed-meanwhile");
    const first = await a.api.skills.save(skillText(name, "First"));
    const firstShare = await a.api.skills.share(name, first.version);
    await admin.api.skills.approve(firstShare.id);
    const second = await b.api.skills.save(skillText(name, "Second"));
    const secondShare = await b.api.skills.share(name, second.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // Retired while the second add is on its way: no later approval, so
    // the attempt fails, and the admin approves it again.
    const failed = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => {
            await admin.api.skills.retire(name);
          },
        }),
        deciding,
        secondShare.id
      )
    );
    const halfway = {
      failed,
      live: await liveOf(member.api, name),
      rows: await rowsOf([{ api: b.api, id: secondShare.id }]),
    };
    const finished = await admin.api.skills.approve(secondShare.id);

    expect({
      ...halfway,
      finished: [finished.status, finished.version],
      liveAfter: await liveOf(member.api, name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "skills.changed",
      live: [],
      rows: [["approved", null]],
      finished: ["approved", 3],
      liveAfter: [["Second", 3]],
      events: [
        "skill.share.approved",
        "skill.retired",
        "skill.retire_done",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
    });
  });

  it("fails a retirement an approval landed under, leaving what landed live", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("retire-under");
    const first = await a.api.skills.save(skillText(name, "First"));
    const firstShare = await a.api.skills.share(name, first.version);
    await admin.api.skills.approve(firstShare.id);
    const second = await b.api.skills.save(skillText(name, "Second"));
    const secondShare = await b.api.skills.share(name, second.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    const failed = await outcome(
      retireSkill(
        sharedStoreHooks({
          1: async () => await admin.api.skills.approve(secondShare.id),
        }),
        deciding,
        name
      )
    );

    expect({
      failed,
      live: await liveOf(member.api, name),
      rows: await rowsOf([{ api: b.api, id: secondShare.id }]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "skills.changed",
      live: [["Second", 2]],
      rows: [["approved", 2]],
      events: [
        "skill.retired",
        "skill.share.approved",
        "skill.share.added",
        "skill.retire_failed",
      ],
    });
  });

  it("records a landed add whose reply was lost once it is approved again, whatever was approved meanwhile", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("lost-reply");
    const older = await a.api.skills.save(skillText(name, "A"));
    const sa = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "B"));
    const sb = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // A lands, but its reply is lost; B is approved and its add fails.
    const first = await outcome(
      approveShare(
        hooked({
          after: {
            addInstructions: { 1: async () => await Promise.resolve("lose") },
          },
        }),
        deciding,
        sa.id
      )
    );
    const bFailed = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, sb.id)
    );
    // Approved again, A's change is answered with the version it made.
    const retry = await outcome(admin.api.skills.approve(sa.id));

    expect({
      first,
      bFailed,
      retry,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "Error: Reply lost, for the test",
      bFailed: "Error: Out of reach, for the test",
      retry: "ok",
      live: [["A", 1]],
      rows: [
        ["approved", 1],
        ["approved", null],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
    });
  });

  it("makes the last add to land live, and says so in every row, when an older approval reads after a newer one landed", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("last-lands");
    const older = await a.api.skills.save(skillText(name, "A"));
    const sa = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "B"));
    const sb = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // B is approved and added in full before A reads the current version.
    const first = await outcome(
      approveShare(
        hooked({
          before: {
            readCurrent: {
              1: async () => await admin.api.skills.approve(sb.id),
            },
          },
        }),
        deciding,
        sa.id
      )
    );

    expect({
      first,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "ok",
      live: [["A", 2]],
      rows: [
        ["approved", 2],
        ["approved", 1],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.share.added",
      ],
    });
  });

  it("records the version an add landed at although a newer add landed over it before it was recorded", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("landed-then-replaced");
    const older = await a.api.skills.save(skillText(name, "A"));
    const sa = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "B"));
    const sb = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();
    let liveWhileOnItsWay: unknown;

    // A lands at version 1, members read it, and B lands over it before A
    // records its version.
    const first = await outcome(
      approveShare(
        hooked({
          after: {
            addInstructions: {
              1: async () => {
                liveWhileOnItsWay = await liveOf(member.api, name);
                await admin.api.skills.approve(sb.id);
              },
            },
          },
        }),
        deciding,
        sa.id
      )
    );

    expect({
      first,
      liveWhileOnItsWay,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "ok",
      liveWhileOnItsWay: [["A", 1]],
      live: [["B", 2]],
      rows: [
        ["approved", 1],
        ["approved", 2],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.share.added",
      ],
    });
  });

  it("adds a newer approval that failed while an older one landed once it is approved again, over the older", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("newer-again");
    const older = await a.api.skills.save(skillText(name, "A"));
    const sa = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "B"));
    const sb = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // While A's add is answering, B is decided, and its add fails.
    const first = await outcome(
      approveShare(
        hooked({
          after: {
            addInstructions: {
              1: async () =>
                await outcome(
                  approveShare(
                    sharedStoreFailing("addInstructions"),
                    deciding,
                    sb.id
                  )
                ),
            },
          },
        }),
        deciding,
        sa.id
      )
    );
    const afterA = await liveOf(member.api, name);
    const bAgain = await outcome(admin.api.skills.approve(sb.id));

    expect({
      first,
      afterA,
      bAgain,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "ok",
      afterA: [["A", 1]],
      bAgain: "ok",
      live: [["B", 2]],
      rows: [
        ["approved", 1],
        ["approved", 2],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.added",
        "skill.share.added",
      ],
    });
  });

  it("ends a retirement whose outcome wasn't recorded in its outcome when retired again, writing nothing more", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("retire-unrecorded");
    const saved = await author.api.skills.save(skillText(name, "Retire"));
    const share = await author.api.skills.share(name, saved.version);
    await admin.api.skills.approve(share.id);
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // Its Brain write lands, its outcome's batch doesn't.
    const failed = await outcome(
      retireSkill(databaseRefusing({ batchesFrom: 2 }), deciding, name)
    );
    const halfway = await liveOf(member.api, name);
    const again = await outcome(admin.api.skills.retire(name));
    const { events } = await eventsAfterWithHead(head);

    expect({
      failed,
      halfway,
      again,
      live: await liveOf(member.api, name),
      events: events
        .filter(({ action }) => action.startsWith("skill."))
        .map(({ action, detail }) => [action, detail]),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      halfway: [],
      again: "ok",
      live: [],
      events: [
        ["skill.retired", {}],
        ["skill.retired", {}],
        ["skill.retire_done", { version: 1 }],
      ],
    });
  });

  it("records the add a retry lands while the first attempt of the same share is refused as stale", async () => {
    const [a, b, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("retry-in-flight");
    const older = await a.api.skills.save(skillText(name, "A"));
    const sa = await a.api.skills.share(name, older.version);
    const newer = await b.api.skills.save(skillText(name, "B"));
    const sb = await b.api.skills.share(name, newer.version);
    const deciding = await admin.api.whoami();
    const head = await logHead();
    const gate = Promise.withResolvers<boolean>();
    const atGate = Promise.withResolvers<boolean>();
    let second: Promise<string> | undefined;

    // While A's first add is on its way: B lands, and a retry of A reads
    // the current version and waits at its own add.
    const first = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => {
            await admin.api.skills.approve(sb.id);
            second = outcome(
              approveShare(
                sharedStoreHooks({
                  1: async () => {
                    atGate.resolve(true);
                    await gate.promise;
                  },
                }),
                deciding,
                sa.id
              )
            );
            await atGate.promise;
          },
        }),
        deciding,
        sa.id
      )
    );
    gate.resolve(true);
    const retry = await second;

    expect({
      first,
      retry,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
      ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      first: "skills.changed",
      retry: "ok",
      live: [["A", 2]],
      rows: [
        ["approved", 2],
        ["approved", 1],
      ],
      events: [
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.added",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
    });
  });

  it("fails an add made stale by another add, whatever became of later approvals, and keeps it to approve again", async () => {
    const [a, b, c, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("later-failed");
    const shareOfText = async (api: SessionApi, text: string) => {
      const saved = await api.skills.save(skillText(name, text));
      return await api.skills.share(name, saved.version);
    };
    const sa = await shareOfText(a.api, "A");
    const sb = await shareOfText(b.api, "B");
    const sc = await shareOfText(c.api, "C");
    const deciding = await admin.api.whoami();
    const head = await logHead();

    // C is decided first and its add fails. While A's add is on its way,
    // B is approved and its add fails, and C is approved again and lands.
    const cFirst = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, sc.id)
    );
    const first = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => {
            await outcome(
              approveShare(
                sharedStoreFailing("addInstructions"),
                deciding,
                sb.id
              )
            );
            await admin.api.skills.approve(sc.id);
          },
        }),
        deciding,
        sa.id
      )
    );
    const halfway = {
      cFirst,
      first,
      live: await liveOf(member.api, name),
      rows: await rowsOf([
        { api: a.api, id: sa.id },
        { api: b.api, id: sb.id },
        { api: c.api, id: sc.id },
      ]),
    };
    // A is still there to approve: it lands over C.
    const again = await outcome(admin.api.skills.approve(sa.id));

    expect({
      ...halfway,
      again,
      liveAfter: await liveOf(member.api, name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      cFirst: "Error: Out of reach, for the test",
      first: "skills.changed",
      live: [["C", 1]],
      rows: [
        ["approved", null],
        ["approved", null],
        ["approved", 1],
      ],
      again: "ok",
      liveAfter: [["A", 2]],
      events: [
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.approved",
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.added",
        "skill.share.approve_failed",
        "skill.share.added",
      ],
    });
  });

  it("closes an approved share not added yet when its person asks again, so its old text is never added after the new one", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("asked-again");
    const deciding = await admin.api.whoami();
    const head = await logHead();
    const first = await asker.api.skills.save(skillText(name, "Old"));
    const old = await asker.api.skills.share(name, first.version);
    const oldFailed = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, old.id)
    );
    const second = await asker.api.skills.save(skillText(name, "New"));
    const newer = await asker.api.skills.share(name, second.version);
    const page = await overviewOf(admin.api);
    await admin.api.skills.approve(newer.id);
    const oldAgain = await outcome(admin.api.skills.approve(old.id));
    const asked = await overviewOf(asker.api);

    expect({
      oldFailed,
      cards: page.requests
        ?.filter(({ name: named }) => named === name)
        .map(({ id }) => (id === old.id ? "old" : "new")),
      oldAgain,
      live: await liveOf(member.api, name),
      rows: asked.shares
        .filter(({ name: named }) => named === name)
        .map(({ id, status, version, open }) => [
          id === old.id ? "old" : "new",
          status,
          version,
          open,
        ]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      oldFailed: "Error: Out of reach, for the test",
      // Only the new ask is there to decide.
      cards: ["new"],
      oldAgain: "skills.not_found",
      live: [["New", 1]],
      rows: [
        ["new", "approved", 1, false],
        ["old", "approved", null, false],
      ],
      events: [
        "skill.share.requested",
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.requested",
        "skill.share.approved",
        "skill.share.added",
      ],
    });
  });

  it("closes an approved share not added yet when its person deletes the skill for good, so the deleted text is never added", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("deleted-meanwhile");
    const deciding = await admin.api.whoami();
    const head = await logHead();
    const saved = await asker.api.skills.save(skillText(name, "Deleted"));
    const share = await asker.api.skills.share(name, saved.version);
    const failed = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, share.id)
    );
    await asker.api.skills.remove(name);
    const page = await overviewOf(admin.api);
    const again = await outcome(admin.api.skills.approve(share.id));

    expect({
      failed,
      cards: page.requests?.filter(({ id }) => id === share.id).length,
      again,
      live: await liveOf(member.api, name),
      kept: await keptText(share.id),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      cards: 0,
      again: "skills.not_found",
      live: [],
      kept: [null],
      events: [
        "skill.share.requested",
        "skill.share.approved",
        "skill.share.approve_failed",
      ],
    });
  });

  it("lets an admin decline a share approved but not added yet, which is then never added", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("decline-approved");
    const deciding = await admin.api.whoami();
    const saved = await asker.api.skills.save(skillText(name, "Stuck"));
    const share = await asker.api.skills.share(name, saved.version);
    const head = await logHead();
    const failed = await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, share.id)
    );
    const declined = await outcome(admin.api.skills.decline(share.id));
    const page = await overviewOf(admin.api);
    const again = await outcome(admin.api.skills.approve(share.id));

    expect({
      failed,
      declined,
      cards: page.requests?.filter(({ id }) => id === share.id).length,
      again,
      live: await liveOf(member.api, name),
      rows: await rowsOf([{ api: asker.api, id: share.id }]),
      kept: await keptText(share.id),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: "Error: Out of reach, for the test",
      declined: "ok",
      cards: 0,
      again: "skills.not_found",
      live: [],
      rows: [["declined", null]],
      kept: [null],
      events: [
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.declined",
      ],
    });
  });

  it("records an add already on its way when its share was declined, and the admin can retire it as usual", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("declined-in-flight");
    const deciding = await admin.api.whoami();
    const saved = await asker.api.skills.save(skillText(name, "Landed"));
    const share = await asker.api.skills.share(name, saved.version);
    const head = await logHead();
    // The first attempt fails, leaving the share approved and not added.
    // The second is declined while its add is on its way; the add lands.
    await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, share.id)
    );
    const landed = await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => await admin.api.skills.decline(share.id),
        }),
        deciding,
        share.id
      )
    );
    const halfway = {
      landed,
      live: await liveOf(member.api, name),
      rows: await rowsOf([{ api: asker.api, id: share.id }]),
    };
    const retired = await outcome(admin.api.skills.retire(name));

    expect({
      ...halfway,
      retired,
      liveAfter: await liveOf(member.api, name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      landed: "ok",
      live: [["Landed", 1]],
      // The store's answer is the truth: declined, and added at 1.
      rows: [["declined", 1]],
      retired: "ok",
      liveAfter: [],
      events: [
        "skill.share.approved",
        "skill.share.approve_failed",
        "skill.share.declined",
        "skill.share.added",
        "skill.retired",
        "skill.retire_done",
      ],
    });
  });

  it("answers approving again a share declined while its add landed with that add, as the store has it", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("declined-landed-again");
    const deciding = await admin.api.whoami();
    const saved = await asker.api.skills.save(skillText(name, "Landed"));
    const share = await asker.api.skills.share(name, saved.version);
    await outcome(
      approveShare(sharedStoreFailing("addInstructions"), deciding, share.id)
    );
    await outcome(
      approveShare(
        sharedStoreHooks({
          1: async () => await admin.api.skills.decline(share.id),
        }),
        deciding,
        share.id
      )
    );
    const head = await logHead();

    const again = await admin.api.skills.approve(share.id);

    expect({
      again: [again.status, again.version, again.open],
      live: await liveOf(member.api, name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      again: ["declined", 1, false],
      live: [["Landed", 1]],
      events: [],
    });
  });
});
