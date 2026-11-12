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
} from "../src/brain-skills.ts";
import type { SkillAt } from "../src/brain-skills.ts";
import { skillShares } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
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
          replaces: false,
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
      replaces: false,
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
      before: [
        ["company", shared],
        ["person", kept],
      ],
      theirs: [["company", shared]],
      members: [["company", shared]],
    });
  });
});
