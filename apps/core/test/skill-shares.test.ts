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

/** Core's env with its database refusing what `refuses` picks, as one out of reach would. */
const databaseRefusing = (refuses: {
  sql?: RegExp;
  batches?: boolean;
}): Env => {
  const database = env.DB;
  return {
    ...env,
    DB: new Proxy(database, {
      get: (target, property): unknown => {
        if (property === "batch" && refuses.batches === true) {
          return refused;
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
            return statement;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
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
      retiredAgain: "skills.not_found",
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

  it("steers only the turns its person asks in their own chat: never a woken turn, a thread others share, or anyone else's chat", async () => {
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

    expect({
      ownTurns,
      othersChat: {
        selected: await returnedIn(others.stub, others.chat.id),
        listed: listedIn(others.provider.requests),
      },
      sharedThread: {
        selected: await returnedIn(group, chatId),
        listed: listedIn(groupProvider.requests),
      },
    }).toStrictEqual({
      ownTurns: {
        selected: [`Returned:\nperson:${name}`, "Returned:\nnone"],
        listed: [true, true, false, false],
      },
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
      events: ["skill.share.approved"],
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
      ["skill.retired", false],
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
      events: ["skill.share.approved", "skill.share.approve_failed"],
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
      // Drizzle names the query that failed: the version's write.
      failed: failed.startsWith('Error: Failed query: update "skill_shares"'),
      finished: [finished.status, finished.version],
      company: page.company
        .filter((skill) => skill.name === name)
        .map(({ version }) => version),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      failed: true,
      finished: ["approved", 1],
      company: [1],
      events: ["skill.share.approved"],
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

  it("refuses to finish an approval a later approval of the same name overtook, keeping the newer text", async () => {
    const [author, other, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("open-the-shop");
    const older = await author.api.skills.save(skillText(name, "Older"));
    const olderShare = await author.api.skills.share(name, older.version);
    const deciding = await admin.api.whoami();
    // Approved, but its add never landed.
    await outcome(
      approveShare(
        sharedStoreFailing("addInstructions"),
        deciding,
        olderShare.id
      )
    );
    const newer = await other.api.skills.save(skillText(name, "Newer"));
    const newerShare = await other.api.skills.share(name, newer.version);
    await admin.api.skills.approve(newerShare.id);

    const stale = await outcome(admin.api.skills.approve(olderShare.id));
    const page = await overviewOf(member.api);

    expect({
      stale,
      company: page.company
        .filter((skill) => skill.name === name)
        .map(({ description }) => description),
      waiting: page.requests,
    }).toStrictEqual({
      stale: "skills.superseded",
      company: ["Newer"],
      waiting: null,
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
});
