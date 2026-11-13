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
import type { SkillAt, SkillsReach } from "../src/brain-skills.ts";
import { skillDecisions, skillShares } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import {
  approveShare,
  reconcileSkills,
  shareOwnSkill,
} from "../src/skill-shares.ts";
import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
import { eventsAfterWithHead, logHead } from "./audit-events.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";
import {
  joinTeam,
  leaveTeam,
  newTeam,
  otherOrganizationsTeam,
} from "./teams.ts";

// Writing skills and sharing one with the company (GRA-1754), from the
// threat model on the issue: someone else reads, lists or is given a
// person's own skill; a person's own skill reaches a chat others share;
// a skill becomes the company's without an admin's decision, or with text
// the admin never saw (an edit after asking, a share asked again); the
// Brain or the log says something other than what was decided; a retired
// skill is still used; a deleted one comes back. Every step of these
// held, failed or its reply lost, against each other, is
// skill-interleavings.test.ts; that no other way in answers a person's
// own skill, the permission harness tries (brain-next-leaks.test.ts).

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A `SKILL.md` named `name`, for `description`, with `steps`. */
const skillText = (name: string, description: string, steps = "The steps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${steps}\n`;

/** How far a chat's skills go: their own too, or their teams' and the company's. */
const reachOf = (personal: boolean): SkillsReach =>
  personal ? "person" : "teams";

/** A chat's agent acting for `userId`. */
const agentOf = (userId: string): Authority =>
  actingFor({ type: "agent", agentId: `agent-${unique()}` }, userId);

/** The scope and name of each skill `userId`'s chat may use, of `names`. */
const usable = async (
  userId: string,
  personal: boolean,
  names: readonly string[]
): Promise<string[][]> => {
  const listed = await skillsFor(
    env,
    agentOf(userId),
    reachOf(personal),
    holdsNothing
  );
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
    reachOf(personal),
    holdsNothing,
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
      reachOf(personal),
      holdsNothing,
      { skill }
    ));
  };
  const how = await outcome(read());
  return how === "ok" ? text : how;
};

/** What `api`'s skills page shows. */
const overviewOf = async (api: SessionApi): Promise<SkillsOverview> =>
  await api.skills.overview();

/** The IDs of the shares `api`'s skills page shows waiting for an admin. */
const requestedIds = async (api: SessionApi): Promise<string[]> => {
  const { requests } = await overviewOf(api);
  return requests?.map(({ id }) => id) ?? [];
};

/** The IDs of the shares `api`'s person asked, as their page shows them. */
const askedIds = async (api: SessionApi): Promise<string[]> => {
  const { shares } = await overviewOf(api);
  return shares.map(({ id }) => id);
};

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

/** Something run around a call of the shared store; `"lose"` after one throws its answer away. */
type Hook = () => Promise<unknown>;

/**
 * Core's env whose shared store runs `before[method][n]` ahead of that
 * method's n-th call (from 1), and `after[method][n]` once it answered:
 * what lands while a call is on its way. An after hook answering `"lose"`
 * loses the reply, as a dropped connection would, after the store wrote.
 */
const hooked = (
  hooks: {
    before?: Record<string, Record<number, Hook>>;
    after?: Record<string, Record<number, Hook>>;
  },
  /** The store hooked: the shared one, or `person:<id>`, someone's own. */
  storeName = "brain"
): Env => {
  const calls = new Map<string, number>();
  const binding = env.BRAIN_STORE;
  const getByName = (named: string) => {
    const stub = binding.getByName(named);
    if (named !== storeName) {
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
      otherShares: await outcome(other.api.skills.share(name, 1, "company")),
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
    const share = await author.api.skills.share(name, saved.version, "company");
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
      // Decided: a second click has nothing waiting to decide.
      twice: "skills.not_found",
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
    const shown = await author.api.skills.share(name, first.version, "company");
    const second = await author.api.skills.save(
      skillText(name, "Book travel", "Other steps.")
    );
    const again = await author.api.skills.share(
      name,
      second.version,
      "company"
    );

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
    const first = await author.api.skills.share(name, saved.version, "company");
    await admin.api.skills.approve(first.id);

    const memberRetires = await outcome(
      member.api.skills.retire(name, "company")
    );
    await admin.api.skills.retire(name, "company");
    const retired = {
      memberRetires,
      memberUses: await usable(member.userId, true, [name]),
      readsV1: await readIn(member.userId, false, {
        scope: "company",
        name,
        version: 1,
      }),
      retiredAgain: await outcome(admin.api.skills.retire(name, "company")),
    };
    const again = await author.api.skills.share(name, saved.version, "company");
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
      // Retired already: there is nothing live to retire.
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
    const share = await author.api.skills.share(name, saved.version, "company");

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
    const share = await author.api.skills.share(name, saved.version, "company");
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
    const share = await author.api.skills.share(name, saved.version, "company");
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
     * A chat with the agent in `platform`, at `place`: what the person's
     * own skills steer there. Not even a direct chat is theirs alone: the
     * chat app keeps the message where its admins and exports reach it
     * (GRA-1821).
     */
    const askedIn = async (
      platform: string,
      place: Parameters<typeof group.askThrough>[5]
    ) => {
      const provider = await fakeProvider(selectsForATender, says("Done."));
      const asked = await group.askThrough(
        author.userId,
        crypto.randomUUID(),
        platform,
        "Quote a tender.",
        undefined,
        place
      );
      return {
        selected: await returnedIn(group, asked.chatId),
        listed: listedIn(provider.requests),
      };
    };
    const teamsDirect = await askedIn("teams", { kind: "direct" });
    const slackDirect = await askedIn("slack", { kind: "direct" });
    const teamsChannel = await askedIn("teams", {
      thread: `T-${unique()}`,
      kind: "channel",
      audience: { members: [author.userId, other.userId], outsiders: false },
    });

    expect({
      ownTurns,
      teamsDirect,
      slackDirect,
      teamsChannel,
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
      teamsChannel: { selected: ["Returned:\nnone"], listed: [false, false] },
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
    const share = await author.api.skills.share(
      shared,
      first.version,
      "company"
    );
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
    const firstShare = await author.api.skills.share(
      companys,
      first.version,
      "company"
    );
    await admin.api.skills.approve(firstShare.id);
    const again = await author.api.skills.save(
      skillText(companys, "Pay", "Newer steps.")
    );
    const replacing = await author.api.skills.share(
      companys,
      again.version,
      "company"
    );
    // Grasp ships a skill of this name: a company skill of it takes its
    // place for everyone, so the admin is told.
    const grasps = "draw-a-workflow";
    const planted = await author.api.skills.save(skillText(grasps, "Mine"));
    const overGrasp = await author.api.skills.share(
      grasps,
      planted.version,
      "company"
    );
    const fresh = nameOf("count-pallets");
    const freshSaved = await author.api.skills.save(skillText(fresh, "Count"));
    const nothing = await author.api.skills.share(
      fresh,
      freshSaved.version,
      "company"
    );
    const page = await overviewOf(admin.api);
    const replaces = (id: string) =>
      page.requests?.find((request) => request.id === id)?.replaces;

    expect({
      company: replaces(replacing.id),
      grasp: replaces(overGrasp.id),
      fresh: replaces(nothing.id),
    }).toStrictEqual({ company: "company", grasp: "grasp", fresh: null });
  });

  it("decides a share two admins approve at once once: one version, one approved event", async () => {
    const [author, first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("race");
    const saved = await author.api.skills.save(skillText(name, "Race"));
    const share = await author.api.skills.share(name, saved.version, "company");
    const head = await logHead();
    const [x, y] = await Promise.all([
      outcome(first.api.skills.approve(share.id)),
      outcome(second.api.skills.approve(share.id)),
    ]);
    const page = await overviewOf(first.api);

    expect({
      // One decides; the other finds nothing waiting.
      outcomes: [x, y].toSorted(),
      company: page.company
        .filter((skill) => skill.name === name)
        .map(({ version }) => version),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      outcomes: ["ok", "skills.not_found"],
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
    const declined = await author.api.skills.share(
      name,
      saved.version,
      "company"
    );
    await admin.api.skills.decline(declined.id);
    const approved = await author.api.skills.share(
      name,
      saved.version,
      "company"
    );
    await admin.api.skills.approve(approved.id);
    await admin.api.skills.retire(name, "company");
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

  it("gives a person's own skills only to a scope that says it is their own attended turn, and no team's where others share the chat", () => {
    expect({
      saysNothing: skillsReachOf({}, false),
      saysNo: skillsReachOf({ ownChat: false }, false),
      ownTurn: skillsReachOf({ ownChat: true }, false),
      shared: skillsReachOf({ ownChat: true }, true),
    }).toStrictEqual({
      saysNothing: "teams",
      saysNo: "teams",
      ownTurn: "person",
      shared: "company",
    });
  });

  it("writes no ask of a person removed and erased while it was on its way", async () => {
    const [asker, admin] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("erased-asking");
    const saved = await asker.api.skills.save(skillText(name, "Mine"));
    const person = await asker.api.whoami();
    const head = await logHead();
    // Their skill read, before the ask is written: removed and erased.
    const asked = await outcome(
      shareOwnSkill(
        hooked(
          {
            after: {
              readVersion: {
                1: async () => {
                  await admin.api.members.remove(asker.userId);
                  await admin.api.members.erase(
                    asker.userId,
                    String(asker.person.name)
                  );
                },
              },
            },
          },
          `person:${asker.userId}`
        ),
        person,
        name,
        saved.version,
        "company"
      )
    );
    const { requests } = await admin.api.skills.overview();

    expect({
      asked,
      rows: await drizzle(env.DB)
        .select({ id: skillShares.id })
        .from(skillShares)
        .where(eq(skillShares.requestedBy, asker.userId)),
      waiting: requests?.filter(({ name: named }) => named === name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      asked: "permission.person_inactive",
      rows: [],
      waiting: [],
      events: [],
    });
  });

  it("takes away the asks of a person removed, so none of them is decided", async () => {
    const [asker, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("removed-asking");
    const saved = await asker.api.skills.save(skillText(name, "Mine"));
    const share = await asker.api.skills.share(name, saved.version, "company");
    await admin.api.members.remove(asker.userId);
    const { requests } = await admin.api.skills.overview();

    expect({
      waiting: requests?.filter(({ id }) => id === share.id),
      approving: await outcome(admin.api.skills.approve(share.id)),
      kept: await keptText(share.id),
    }).toStrictEqual({
      waiting: [],
      approving: "skills.not_found",
      kept: [],
    });
  });

  it("finishes a decision whose Brain write failed on the clock, saying its outcome once", async () => {
    const [author, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = nameOf("count-stock");
    const saved = await author.api.skills.save(skillText(name, "Count it"));
    const share = await author.api.skills.share(name, saved.version, "company");
    const head = await logHead();
    const decided = await approveShare(
      sharedStoreFailing("addInstructions"),
      await admin.api.whoami(),
      share.id
    );
    const { requests } = await overviewOf(admin.api);
    const halfway = {
      decided: [decided.status, decided.version, decided.superseded],
      memberUses: await usable(member.userId, false, [name]),
      waiting: requests?.filter(({ id }) => id === share.id),
    };
    await reconcileSkills(env);
    await reconcileSkills(env);
    const { shares } = await overviewOf(author.api);
    const after = shares.find(({ id }) => id === share.id);

    expect({
      ...halfway,
      after: [after?.status, after?.version],
      memberUses: await usable(member.userId, false, [name]),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      // The decision stands: it is on its way, nothing left to click.
      decided: ["approved", null, false],
      memberUses: [["company", name]],
      waiting: [],
      after: ["approved", 1],
      events: ["skill.share.approved", "skill.share.added"],
    });
  });

  it("shares the version asked for when the skill is edited while the ask is on its way, and says a newer one is saved", async () => {
    const [asker, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("edited-while-asked");
    const saved = await asker.api.skills.save(skillText(name, "Asked"));
    const person = await asker.api.whoami();
    await shareOwnSkill(
      hooked(
        {
          after: {
            readVersion: {
              1: async () =>
                await asker.api.skills.save(skillText(name, "Edited")),
            },
          },
        },
        `person:${asker.userId}`
      ),
      person,
      name,
      saved.version,
      "company"
    );
    const { requests } = await admin.api.skills.overview();
    const { shares } = await overviewOf(asker.api);

    expect({
      card: requests
        ?.filter(({ name: named }) => named === name)
        .map(({ text }) => text.includes("Asked")),
      outdated: shares
        .filter(({ name: named }) => named === name)
        .map(({ outdated }) => outdated),
    }).toStrictEqual({ card: [true], outdated: [true] });
  });

  it("leaves one waiting share when its person asks twice at once", async () => {
    const [asker, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("asked-twice");
    const first = await asker.api.skills.save(skillText(name, "First"));
    const second = await asker.api.skills.save(skillText(name, "Second"));
    const head = await logHead();
    await Promise.allSettled([
      asker.api.skills.share(name, first.version, "company"),
      asker.api.skills.share(name, second.version, "company"),
    ]);
    const { requests } = await admin.api.skills.overview();
    const cards = requests?.filter(({ name: named }) => named === name);

    expect({
      cards: cards?.length,
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      cards: 1,
      events: ["skill.share.requested", "skill.share.requested"],
    });
  });

  it("tells its person a waiting share is of an older text once they saved a newer one, and asking again shares that", async () => {
    const asker = await signedInApi(idp, "user");
    const name = nameOf("saved-since");
    const first = await asker.api.skills.save(skillText(name, "Old"));
    const old = await asker.api.skills.share(name, first.version, "company");
    /** Each of the person's shares of `name`: old or new, status, outdated. */
    const rows = async () => {
      const { shares } = await overviewOf(asker.api);
      return shares
        .filter(({ name: named }) => named === name)
        .map(({ id, status, outdated }) => [
          id === old.id ? "old" : "new",
          status,
          outdated,
        ]);
    };
    const asked = await rows();
    const second = await asker.api.skills.save(skillText(name, "New"));
    const saved = await rows();
    await asker.api.skills.share(name, second.version, "company");

    expect({ asked, saved, again: await rows() }).toStrictEqual({
      asked: [["old", "pending", false]],
      saved: [["old", "pending", true]],
      // The old ask is gone with its text; the new one is current.
      again: [["new", "pending", false]],
    });
  });
});

// Sharing a skill with a team (GRA-1844), from the threat model on the
// issue: instructions planted in a team by someone outside it; a team's
// skill reaching anyone outside the team, or a conversation others share;
// a click on a card left over after its asker left the team; a missing
// audience read as the company's. Every step of these held, failed or its
// reply lost is skill-interleavings.test.ts's; that no other way in
// answers a team's skill to someone outside it, the permission harness
// tries (brain-next-leaks.test.ts).
describe("sharing a skill with a team", setUpTime, () => {
  it("lets only a member of a team ask to share with it: a team they aren't in, one that doesn't exist and another organization's are refused alike, and nothing waits", async () => {
    const [author, admin, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const theirs = await newTeam(author.userId);
    const notTheirs = await newTeam(other.userId);
    const elsewhere = await otherOrganizationsTeam(author.userId);
    const name = nameOf("pitch-a-client");
    const saved = await author.api.skills.save(skillText(name, "Pitch"));
    const askFor = async (team: string) =>
      await outcome(author.api.skills.share(name, saved.version, { team }));
    const refused = {
      notTheirs: await askFor(notTheirs),
      none: await askFor(crypto.randomUUID()),
      elsewhere: await askFor(elsewhere),
    };
    const asked = await author.api.skills.share(name, saved.version, {
      team: theirs,
    });
    const { requests } = await overviewOf(admin.api);

    expect({
      refused,
      asked: asked.audience,
      waiting: requests
        ?.filter((request) => request.name === name)
        .map(({ audience, text }) => ({ audience, text })),
    }).toStrictEqual({
      refused: {
        notTheirs: "skills.not_in_team",
        none: "skills.not_in_team",
        elsewhere: "skills.not_in_team",
      },
      asked: { kind: "team", team: { id: theirs, name: `Team ${theirs}` } },
      waiting: [
        {
          audience: {
            kind: "team",
            team: { id: theirs, name: `Team ${theirs}` },
          },
          text: skillText(name, "Pitch"),
        },
      ],
    });
  });

  it("gives a team's skill to its members alone, in place of the company's of its name, and to no one once they leave, from their next turn", async () => {
    const [author, admin, mate, outsider] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const team = await newTeam(author.userId, mate.userId);
    const name = nameOf("quote-a-tender");
    const first = await author.api.skills.save(skillText(name, "Company way"));
    const forCompany = await author.api.skills.share(
      name,
      first.version,
      "company"
    );
    await admin.api.skills.approve(forCompany.id);
    const second = await author.api.skills.save(skillText(name, "Team way"));
    const forTeam = await author.api.skills.share(name, second.version, {
      team,
    });
    const { requests } = await overviewOf(admin.api);
    const shown = requests?.find(({ id }) => id === forTeam.id);
    await admin.api.skills.approve(forTeam.id);
    const given = async (userId: string) => await usable(userId, false, [name]);
    const before = {
      mate: await given(mate.userId),
      outsider: await given(outsider.userId),
    };
    const teamSkill = { scope: "team", team, name, version: 1 } as const;
    const read = {
      mate: await readIn(mate.userId, false, teamSkill),
      outsider: await readIn(outsider.userId, false, teamSkill),
      inAThreadOthersShare: await outcome(
        readSkillFor(env, agentOf(mate.userId), "company", holdsNothing, {
          skill: teamSkill,
        })
      ),
    };
    await leaveTeam(team, mate.userId);

    expect({
      replaces: shown?.replaces,
      before,
      read,
      afterLeaving: await given(mate.userId),
    }).toStrictEqual({
      replaces: "company",
      before: {
        mate: [["team", name]],
        outsider: [["company", name]],
      },
      read: {
        mate: skillText(name, "Team way"),
        outsider: "skills.not_found",
        inAThreadOthersShare: "skills.not_found",
      },
      afterLeaving: [["company", name]],
    });
  });

  it("lists a team's skill in its members' own conversations alone: never in a thread others share, or anyone else's chat", async () => {
    const [author, admin, outsider] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const team = await newTeam(author.userId);
    const name = nameOf("quote-a-tender");
    const saved = await author.api.skills.save(skillText(name, "Quote it"));
    const share = await author.api.skills.share(name, saved.version, { team });
    await admin.api.skills.approve(share.id);
    // Their own copy goes, so what is listed is the team's.
    await author.api.skills.remove(name);
    const listed = `- ${name} (team, team ${team}`;
    /** The chat's code: the skills of this name `env.skills` selects for quoting a tender. */
    const selectsThis = codeStep(
      `export default async (self, env) => { const { skills } = await env.skills.select({ task: "quote a tender" }); return skills.filter(({ name }) => name === ${JSON.stringify(name)}).map(({ scope, name }) => scope + ":" + name).join(",") || "none"; };`
    );
    const listedIn = (requests: { body: unknown }[]) =>
      requests.map(({ body }) =>
        stringsIn(body).some((text) => text.includes(listed))
      );

    const own = await chatOf(author.userId, selectsThis, says("Done."));
    await own.ask("Quote a tender.");
    const group = workspace(env, personalWorkspaceId(author.userId));
    const groupProvider = await fakeProvider(selectsThis, says("Done."));
    const { chatId } = await group.askThrough(
      author.userId,
      crypto.randomUUID(),
      "slack",
      "Quote a tender.",
      undefined,
      {
        thread: `C-${unique()}`,
        kind: "group",
        audience: {
          members: [author.userId, outsider.userId],
          outsiders: false,
        },
      }
    );
    const others = await chatOf(outsider.userId, selectsThis, says("Done."));
    await others.ask("Quote a tender.");

    expect({
      own: {
        selected: await returnedIn(own.stub, own.chat.id),
        listed: listedIn(own.provider.requests),
      },
      sharedThread: {
        selected: await returnedIn(group, chatId),
        listed: listedIn(groupProvider.requests),
      },
      othersChat: {
        selected: await returnedIn(others.stub, others.chat.id),
        listed: listedIn(others.provider.requests),
      },
    }).toStrictEqual({
      own: { selected: [`Returned:\nteam:${name}`], listed: [true, true] },
      sharedThread: { selected: ["Returned:\nnone"], listed: [false, false] },
      othersChat: { selected: ["Returned:\nnone"], listed: [false, false] },
    });
  });

  it("decides a team share only while its asker is in the team: once they leave, no admin is shown it and approving it is refused", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const team = await newTeam(author.userId);
    const name = nameOf("close-the-month");
    const saved = await author.api.skills.save(skillText(name, "Close it"));
    const share = await author.api.skills.share(name, saved.version, { team });
    await leaveTeam(team, author.userId);
    const shownOf = async () => {
      const shown = await requestedIds(admin.api);
      return shown.includes(share.id);
    };
    const asked = await askedIds(author.api);
    const whileOut = {
      shown: await shownOf(),
      own: asked.includes(share.id),
      approved: await outcome(admin.api.skills.approve(share.id)),
      declined: await outcome(admin.api.skills.decline(share.id)),
      given: await usable(author.userId, false, [name]),
    };
    await joinTeam(team, author.userId);

    expect({ whileOut, back: await shownOf() }).toStrictEqual({
      whileOut: {
        shown: false,
        own: false,
        approved: "skills.not_found",
        declined: "skills.not_found",
        given: [],
      },
      // Their own ask, of a team they are in again: it waits again.
      back: true,
    });
  });

  it("retires a team's skill for its members alone, by an admin outside the team, audited by its team and name", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const team = await newTeam(author.userId);
    const name = nameOf("book-travel");
    const saved = await author.api.skills.save(skillText(name, "Book it"));
    const forCompany = await author.api.skills.share(
      name,
      saved.version,
      "company"
    );
    await admin.api.skills.approve(forCompany.id);
    const forTeam = await author.api.skills.share(name, saved.version, {
      team,
    });
    await admin.api.skills.approve(forTeam.id);
    const head = await logHead();
    await admin.api.skills.retire(name, { team });
    const { events } = await eventsAfterWithHead(head);

    expect({
      given: await usable(author.userId, false, [name]),
      events: events
        .filter(({ action }) => action.startsWith("skill."))
        .map(({ action, target }) => [action, target?.type, target?.id]),
    }).toStrictEqual({
      // Theirs again is the company's: the team's is retired.
      given: [["company", name]],
      events: [
        ["skill.retired", "team_skill", `${team}:${name}`],
        ["skill.retire_done", "team_skill", `${team}:${name}`],
      ],
    });
  });

  it("never reads a share or decision without an audience as the company's: it is never shown, decided, reconciled or given", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = nameOf("old-format");
    const text = skillText(name, "Old");
    const shareId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(skillShares).values({
      id: shareId,
      name,
      text,
      requestedBy: author.userId,
      requestedAt: new Date(),
      status: "pending",
    });
    await db.insert(skillDecisions).values({
      id: crypto.randomUUID(),
      name,
      seq: 1,
      shareId: crypto.randomUUID(),
      text,
      decidedBy: admin.userId,
      decidedAt: new Date(),
    });
    const approved = await outcome(admin.api.skills.approve(shareId));
    await reconcileSkills(env);
    const [shown, asked] = await Promise.all([
      requestedIds(admin.api),
      askedIds(author.api),
    ]);

    expect({
      shown: shown.includes(shareId),
      asked: asked.includes(shareId),
      approved,
      given: await usable(admin.userId, false, [name]),
    }).toStrictEqual({
      shown: false,
      asked: false,
      approved: "skills.not_found",
      given: [],
    });
  });
});
