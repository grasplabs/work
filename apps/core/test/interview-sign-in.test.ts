import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { adoptDirectoryMember } from "../src/auth/auth.ts";
import { memberFromDirectory } from "../src/auth/directory-members.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { adminCommands } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { openLinkAs, signedInAs } from "./interview-link.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  entraPerson,
  outcome,
  signIn,
  unique,
  whoami,
} from "./sign-in.ts";

// Signing in to open one's own interview while the gate is closed
// (GRA-1790; onboarding/gate.ts, auth/auth.ts, auth/identity.ts). From the
// threat model, the ways it can fail, tried here:
//
// - Someone in the company coming in early on the strength of anyone's
//   link: only an address an interview link went to comes in, and anyone
//   else is still refused before a user is made.
// - The interview's session reaching anything but the interview: every
//   route that asks who it is finds nobody (`/rpc`), Better Auth's own
//   organization routes refuse it, and it makes no membership. Also for
//   someone who already is a member, whose membership must not count.
// - The session outliving the gate: opening it ends every interview's
//   session; signing in again then makes them a member as anyone.
// - The company's audit log learning who opened their interview, and when.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * An onboarding running since yesterday, its gate closed, with one person
 * whose link went out to their own address: who, the address, and the
 * link's secret.
 */
const invited = async () => {
  const store = onboardingStore(env);
  const person = `oli-${unique()}`;
  const address = `person-${unique()}@acme.test`;
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: [
      {
        id: person,
        name: "Oli Olsen",
        team: "ops",
        email: address,
        title: "",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  await adminCommands().close();
  const secret = ((await store.linkOf(person)) ?? "").split("#")[1] ?? "";
  return { person, address, secret };
};

/** How many memberships the user signed in as `address` has. */
const membershipsOf = async (address: string): Promise<number> => {
  const row = await env.DB.prepare(
    `SELECT count(*) AS count FROM members m JOIN users u ON u.id = m.user_id
     WHERE lower(u.email) = lower(?)`
  )
    .bind(address)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

/**
 * `namespace`, whose objects fail their first call of `method` and answer
 * every other as they would.
 */
const failingOnce = <T extends object>(namespace: T, method: string): T => {
  const failed = { once: false };
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        return async (...given: unknown[]): Promise<unknown> => {
          if (name === method && !failed.once) {
            failed.once = true;
            throw new Error("The onboarding is out of reach.");
          }
          return await Reflect.apply(member, target, given);
        };
      },
    });
  const namespaceOf = <U extends object>(of: U): U =>
    new Proxy(of, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        return (...given: unknown[]): unknown => {
          const made: unknown = Reflect.apply(member, target, given);
          if (typeof made !== "object" || made === null) {
            return made;
          }
          if (name === "jurisdiction") {
            return namespaceOf(made);
          }
          return name === "get" || name === "getByName" ? stubOf(made) : made;
        };
      },
    });
  return namespaceOf(namespace);
};

/**
 * The user Better Auth made for the Entra sign-in of `oid`, beside the
 * member the directory made for it: whoever an interview-only session is.
 */
const signedInUserOf = async (oid: string): Promise<string> =>
  (await env.DB.prepare(
    "SELECT user_id FROM accounts WHERE oid = ? AND provider_id != 'entra-directory'"
  )
    .bind(oid)
    .first<string>("user_id")) ?? "";

/** `db`, whose first batch fails, every other call answered as it would. */
const batchFailingOnce = (db: D1Database): D1Database => {
  const failed = { once: false };
  return new Proxy(db, {
    get: (target, name): unknown => {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") {
        return member;
      }
      return (...given: unknown[]): unknown => {
        if (name === "batch" && !failed.once) {
          failed.once = true;
          return Promise.reject(new Error("The database is out of reach."));
        }
        return Reflect.apply(member, target, given);
      };
    },
  });
};

describe("signing in for an interview while the gate is closed", () => {
  // Every test leaves the deployment open, as it found it.
  afterEach(async () => {
    await adminCommands().open();
  });

  it("lets in the address a link went to, for that interview alone: no membership, nobody to every other route", async () => {
    const { address, secret } = await invited();
    const cookie = await signedInAs(address);
    const { response } = await openLinkAs(secret, cookie);
    const members = await callAuth("/organization/list-members", cookie);
    expect({
      interview: response.status,
      rpc: await outcome(whoami(cookie)),
      organization: members.ok,
      memberships: await membershipsOf(address),
    }).toStrictEqual({
      interview: 200,
      rpc: "auth.unauthenticated",
      organization: false,
      memberships: 0,
    });
  });

  it("still refuses anyone no link went to, before a user is made for them", async () => {
    const { secret } = await invited();
    const stranger = entraPerson(acmeTenant);
    const refused = await signIn(idp, "microsoft", stranger);
    const users = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(stranger.email)
      .all();
    expect({
      session: refused.session,
      error: new URL(refused.location ?? "", "https://x.test").searchParams.get(
        "error"
      ),
      users: users.results.length,
      // Holding the link changes nothing for them.
      secret: secret.length,
    }).toStrictEqual({
      session: undefined,
      error: "not_open_yet",
      users: 0,
      secret: 43,
    });
  });

  it("gives a member of the company no more than their interview while the gate is closed", async () => {
    const { address, secret } = await invited();
    // A member from before the gate closed: closing it ended their session.
    await adminCommands().open();
    const before = await signedInAs(address);
    const wasMember = await membershipsOf(address);
    await adminCommands().close();
    const cookie = await signedInAs(address);
    const { response } = await openLinkAs(secret, cookie);
    const members = await callAuth("/organization/list-members", cookie);
    expect({
      wasMember,
      before: await outcome(whoami(before)),
      interview: response.status,
      rpc: await outcome(whoami(cookie)),
      organization: members.ok,
    }).toStrictEqual({
      wasMember: 1,
      before: "auth.unauthenticated",
      interview: 200,
      rpc: "auth.unauthenticated",
      organization: false,
    });
  });

  it("ends as the gate opens; signed in again, they are a member, and their interview still opens for them", async () => {
    const { address, secret } = await invited();
    const cookie = await signedInAs(address);
    await openLinkAs(secret, cookie);
    await adminCommands().open();
    const ended = await openLinkAs(secret, cookie);
    const again = await signedInAs(address);
    const { response } = await openLinkAs(secret, again);
    const { userId } = await whoami(again);
    expect({
      ended: ended.response.status,
      interview: response.status,
      member: userId !== "",
      memberships: await membershipsOf(address),
    }).toStrictEqual({
      ended: 401,
      interview: 200,
      member: true,
      memberships: 1,
    });
  });

  it("adopts no member the directory made when they sign in for their interview, and records nothing of it; once the gate opens they are that member, and their interview is theirs", async () => {
    const { address, secret } = await invited();
    const oid = `entra-oid-${address}`;
    const member = await memberFromDirectory(env, oid, {
      id: oid,
      name: "Oli Olsen",
      email: address,
      department: "",
      title: "",
      manager: null,
    });
    let opened = 0;
    const events = await auditedDuring(async () => {
      const cookie = await signedInAs(address);
      const { response } = await openLinkAs(secret, cookie);
      opened = response.status;
    });
    await adminCommands().open();
    const again = await signedInAs(address);
    const { userId } = await whoami(again);
    const { response: reopened } = await openLinkAs(secret, again);
    expect({
      opened,
      events: events.map(({ action }) => action),
      member: userId === member,
      reopened: reopened.status,
    }).toStrictEqual({
      opened: 200,
      events: [],
      member: true,
      reopened: 200,
    });
  });

  it("keeps their interview theirs when moving it to the member the directory made fails at their first sign-in once the gate opens: signed in again, they are that member, and it opens", async () => {
    const { address, secret } = await invited();
    const oid = `entra-oid-${address}`;
    const member = await memberFromDirectory(env, oid, {
      id: oid,
      name: "Oli Olsen",
      email: address,
      department: "",
      title: "",
      manager: null,
    });
    await openLinkAs(secret, await signedInAs(address));
    await adminCommands().open();
    // The onboarding's object fails the move, once, as they sign in.
    const failing = {
      ...env,
      ONBOARDING: failingOnce(env.ONBOARDING, "accountMoved"),
    };
    const first = await signedInAs(address, failing).catch(() => null);
    const again = await signedInAs(address);
    const { userId } = await whoami(again);
    const { response: reopened } = await openLinkAs(secret, again);
    expect({
      first,
      member: userId === member,
      reopened: reopened.status,
    }).toStrictEqual({ first: null, member: true, reopened: 200 });
  });

  it("moves their interview back to the user their sign-in made when adopting the member the directory made fails after it moved, and adopts at their next sign-in", async () => {
    const { person, address, secret } = await invited();
    const oid = `entra-oid-${address}`;
    const member = await memberFromDirectory(env, oid, {
      id: oid,
      name: "Oli Olsen",
      email: address,
      department: "",
      title: "",
      manager: null,
    });
    const cookie = await signedInAs(address);
    await openLinkAs(secret, cookie);
    const fresh = await signedInUserOf(oid);
    await adminCommands().open();
    const store = onboardingStore(env);
    // The database fails the adoption's batch, after the interview moved.
    const failing = { ...env, DB: batchFailingOnce(env.DB) };
    const adopting = await adoptDirectoryMember(
      failing,
      fresh,
      async (from, to) => {
        await store.accountMoved(from, to);
      }
    ).catch(() => null);
    const held = await store.personOfAccount(fresh);
    const again = await signedInAs(address);
    const { userId } = await whoami(again);
    const { response: reopened } = await openLinkAs(secret, again);
    expect({
      adopting,
      held: held === person,
      member: userId === member,
      reopened: reopened.status,
    }).toStrictEqual({
      adopting: null,
      held: true,
      member: true,
      reopened: 200,
    });
  });

  it("moves their interview back to the user their sign-in made when the member the directory made isn't adopted after all", async () => {
    const { person, address, secret } = await invited();
    const oid = `entra-oid-${address}`;
    const member = await memberFromDirectory(env, oid, {
      id: oid,
      name: "Oli Olsen",
      email: address,
      department: "",
      title: "",
      manager: null,
    });
    const cookie = await signedInAs(address);
    await openLinkAs(secret, cookie);
    const fresh = await signedInUserOf(oid);
    await adminCommands().open();
    // Another sign-in of theirs made them a member meanwhile, so the batch
    // adopts nothing.
    const organization = await env.DB.prepare(
      "SELECT organization_id FROM members WHERE user_id = ?"
    )
      .bind(member)
      .first<string>("organization_id");
    await env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'user', ?)"
    )
      .bind(crypto.randomUUID(), organization, fresh, Date.now())
      .run();
    const store = onboardingStore(env);
    const adopted = await adoptDirectoryMember(env, fresh, async (from, to) => {
      await store.accountMoved(from, to);
    });
    expect({
      adopted: adopted === fresh,
      held: (await store.personOfAccount(fresh)) === person,
      member: await store.personOfAccount(member ?? ""),
    }).toStrictEqual({ adopted: true, held: true, member: null });
  });

  it("records nothing of who signed in for an interview, or opened one, in the company's audit log", async () => {
    const { person, address, secret } = await invited();
    let account = "";
    const events = await auditedDuring(async () => {
      const cookie = await signedInAs(address);
      await openLinkAs(secret, cookie);
      const users = await env.DB.prepare(
        "SELECT id FROM users WHERE lower(email) = lower(?)"
      )
        .bind(address)
        .first<{ id: string }>();
      account = users?.id ?? "";
    });
    const text = JSON.stringify(events);
    expect({
      account: account !== "",
      named: [account, person, address].filter((each) => text.includes(each)),
    }).toStrictEqual({ account: true, named: [] });
  });
});
