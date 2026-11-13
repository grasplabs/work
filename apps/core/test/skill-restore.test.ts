import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import { readCurrentSkillAs, workBrain } from "../src/brain-next.ts";
import {
  approveShare,
  reconcileSkills,
  retireSkill,
} from "../src/skill-shares.ts";
import { eventsAfterWithHead, logHead } from "./audit-events.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import type { StoreCopy } from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// The company's skills after a restore of the shared store (GRA-1754): a
// restore puts back what its export held, which may be older than what
// core decided since. Core's record of decisions survives; once the
// restore is done, every skill's latest decision is reopened and the
// clock writes it again. In a file of its own: a restore goes only into a
// shared store that holds nothing, so each test empties it first, as its
// storage lost would.

const idp = mockIdp();

/** Exports and restores take ticks of the Brain: allow them. */
const restoreTime = { timeout: 120_000 };

/** A request of core's own page as the admin signed in on `cookie`: its answer's JSON. */
const adminRequest = async (
  cookie: string,
  path: string,
  body?: unknown
): Promise<{ id?: string; state?: string; status: number }> => {
  const response = await routed(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answered = z
    .looseObject({ id: z.string().optional(), state: z.string().optional() })
    .parse(await response.json());
  return { ...answered, status: response.status };
};

/** Ticks the Brain until `path` no longer answers `state`: at most 20 ticks. */
const tickedPast = async (
  cookie: string,
  path: string,
  state: string
): Promise<string | undefined> => {
  for (let ticks = 0; ticks < 20; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await adminRequest(cookie, path);
    if (status.state !== state) {
      return status.state;
    }
  }
  throw new Error(`Still ${state} after 20 ticks`);
};

/** The company's export, written: its ID. */
const exported = async (cookie: string): Promise<string> => {
  const { id = "" } = await adminRequest(cookie, brainExportsPath, {});
  await tickedPast(cookie, `${brainExportsPath}?id=${id}`, "writing");
  return id;
};

/** Core's env with the shared store's `method` out of reach for its first `times` calls. */
const sharedStoreFailing = (method: string, times = Infinity): Env => {
  let calls = 0;
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
        return async (...args: unknown[]): Promise<unknown> => {
          if (property === method && calls < times) {
            calls += 1;
            throw new Error("Out of reach, for the test");
          }
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

/** A `SKILL.md` named `name`, with `steps`. */
const skillText = (name: string, steps: string) =>
  `---\nname: ${name}\ndescription: How to ${name}.\n---\n\n${steps}\n`;

/** The company's skill `name` as a member reads it: its text, or null. */
const liveOf = async (
  memberId: string,
  name: string
): Promise<string | null> => {
  const read = await readCurrentSkillAs(env, memberId, {
    scope: "company",
    name,
  });
  return read?.text ?? null;
};

/** The skill events after log position `head`: their actions and details, oldest first. */
const skillEventsAfter = async (head: number) => {
  const { events } = await eventsAfterWithHead(head);
  return events
    .filter(({ action }) => action.startsWith("skill."))
    .map(({ action, detail }) => [action, detail ?? {}]);
};

describe("the company's skills after a restore", restoreTime, () => {
  /** The shared store before anything of this file was added to it: empty. */
  let emptyStore: StoreCopy = { tables: [], triggers: [] };

  beforeAll(async () => {
    emptyStore = await copyOfStore();
  });

  it("retires again a skill a restore from an older export brought back, once following the restore succeeds", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = `restored-${unique()}`;
    const saved = await asker.api.skills.save(skillText(name, "Old steps."));
    const share = await asker.api.skills.share(name, saved.version);
    await admin.api.skills.approve(share.id);
    const id = await exported(admin.session);
    await retireSkill(env, await admin.api.whoami(), name);
    const head = await logHead();

    // The shared store's storage lost, then restored from the export.
    await restoreStore(emptyStore);
    const started = await adminRequest(admin.session, brainRestorePath, {
      exportId: id,
    });
    const restored = await tickedPast(
      admin.session,
      `${brainRestorePath}?id=${id}`,
      "running"
    );
    const backAfterRestore = await liveOf(member.userId, name);
    // The clock's first run can't learn how the restore went.
    await reconcileSkills(sharedStoreFailing("restoreStatus", 1));
    const stillBack = await liveOf(member.userId, name);
    await reconcileSkills(env);
    await reconcileSkills(env);

    expect({
      started: started.status,
      restored,
      backAfterRestore: backAfterRestore !== null,
      stillBack: stillBack !== null,
      live: await liveOf(member.userId, name),
      events: await skillEventsAfter(head),
    }).toStrictEqual({
      started: 200,
      restored: "done",
      // The export held it live: a restore brings it back.
      backAfterRestore: true,
      stillBack: true,
      // Retired again, as core decided.
      live: null,
      events: [
        ["skill.decisions_reopened", { names: 1 }],
        // Over the version the export held: the store numbers past what
        // it holds.
        ["skill.retire_done", { version: 2 }],
      ],
    });
  });

  it("writes nothing into an emptied shared store while a decision is open, so its restore can start, and lands it after", async () => {
    const [asker, admin, member] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const name = `waiting-${unique()}`;
    const first = await asker.api.skills.save(skillText(name, "First."));
    const firstShare = await asker.api.skills.share(name, first.version);
    await admin.api.skills.approve(firstShare.id);
    const id = await exported(admin.session);
    const second = await asker.api.skills.save(skillText(name, "Second."));
    const secondShare = await asker.api.skills.share(name, second.version);
    // Decided, its write failed: open, for the clock.
    await approveShare(
      sharedStoreFailing("addInstructions"),
      await admin.api.whoami(),
      secondShare.id
    );

    await restoreStore(emptyStore);
    // The clock runs before anyone starts the restore.
    await reconcileSkills(env);
    const started = await adminRequest(admin.session, brainRestorePath, {
      exportId: id,
    });
    const restored =
      started.status === 200
        ? await tickedPast(
            admin.session,
            `${brainRestorePath}?id=${id}`,
            "running"
          )
        : null;
    await reconcileSkills(env);
    await reconcileSkills(env);

    expect({
      started: started.status,
      restored,
      live: await liveOf(member.userId, name),
    }).toStrictEqual({
      started: 200,
      restored: "done",
      live: skillText(name, "Second."),
    });
  });
});
