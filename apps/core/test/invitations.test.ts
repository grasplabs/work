import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { adoptDirectoryMember } from "../src/auth/auth.ts";
import { memberFromDirectory } from "../src/auth/directory-members.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// Invitations: an admin names the role someone gets when they first sign
// in through the organization's IdP. These tests start from the ways it
// can fail: someone joining with more than they were invited with, or
// after the invitation was withdrawn, lapsed, or its admin lost the role;
// someone other than an admin inviting; an invitation for someone who
// could never sign in, is a member, or was removed; and a change that
// leaves no record, or a record with the address in it.

const idp = mockIdp();

/** Someone who hasn't signed in yet, at `acme.test`. */
const newcomer = () => entraPerson(acmeTenant);

/** `claims` signing in for the first time, and the role they get. */
const joins = async (claims: Record<string, unknown>) => {
  const session = await signedIn(idp, "microsoft", claims);
  const { role } = await whoami(session);
  return role;
};

describe("inviting someone", () => {
  it("gives them the role on their first sign-in, and takes the invitation off the list", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const invitation = await admin.api.members.invite(
      ` ${String(person.email).toUpperCase()} `,
      "builder"
    );
    expect(invitation).toMatchObject({
      email: person.email,
      role: "builder",
      invitedBy: admin.person.name,
    });
    await expect(admin.api.members.invitations()).resolves.toContainEqual(
      invitation
    );

    await expect(joins(person)).resolves.toBe("builder");

    const open = await admin.api.members.invitations();
    expect(open.map(({ id }) => id)).not.toContain(invitation.id);
  });

  it("gives nothing once withdrawn: they join as users", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const { id } = await admin.api.members.invite(
      String(person.email),
      "admin"
    );
    await admin.api.members.withdrawInvitation(id);

    await expect(admin.api.members.invitations()).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    );
    await expect(joins(person)).resolves.toBe("user");
    await expect(
      outcome(admin.api.members.withdrawInvitation(id))
    ).resolves.toBe("member.invitation_not_found");
  });

  it("gives nothing once it lapsed", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const { id } = await admin.api.members.invite(
      String(person.email),
      "admin"
    );
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    await expect(admin.api.members.invitations()).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    );
    await expect(joins(person)).resolves.toBe("user");
  });

  it("gives nothing once the admin who made it is no admin", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const person = newcomer();
    await admin.api.members.invite(String(person.email), "admin");
    await other.api.members.setRole(admin.userId, "user");

    await expect(joins(person)).resolves.toBe("user");
  });

  it("gives nothing when withdrawn just before they join", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const { id } = await admin.api.members.invite(
      String(person.email),
      "admin"
    );
    // Withdrawn after core read the invitation, just before the join lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare("UPDATE invitations SET status = 'canceled' WHERE id = ?")
          .bind(id)
          .run()
    );

    const session = await signedIn(idp, "microsoft", person, {
      coreEnv: { ...env, DB: racing },
    });

    const { role } = await whoami(session);
    expect(role).toBe("user");
    const row = await env.DB.prepare(
      "SELECT status FROM invitations WHERE id = ?"
    )
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("canceled");
  });

  it("is off the list once its admin is no admin, and doesn't keep anyone from inviting them again", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const email = String(newcomer().email);
    const { id } = await admin.api.members.invite(email, "admin");
    await other.api.members.setRole(admin.userId, "user");

    await expect(other.api.members.invitations()).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    );
    await expect(
      other.api.members.invite(email, "builder")
    ).resolves.toMatchObject({ email, role: "builder" });
  });

  it("is taken up by a configured admin too, who joins as admin", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const email = String(person.email);
    const { id } = await admin.api.members.invite(email, "user");
    let session = "";
    const events = await auditedDuring(async () => {
      session = await signedIn(idp, "microsoft", person, {
        coreEnv: withSignIn({ admins: [email] }),
      });
    });

    const { role, userId } = await whoami(session);
    expect(role).toBe("admin");
    await expect(admin.api.members.invitations()).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    );
    expect(
      events.filter(({ action }) => action === "member.invitation.accepted")
    ).toStrictEqual([
      expect.objectContaining({
        target: { type: "invitation", id },
        detail: { userId, role: "admin" },
      }),
    ]);
  });

  it("is taken up once: signing in again keeps the role an admin gave since", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    await admin.api.members.invite(String(person.email), "builder");
    const session = await signedIn(idp, "microsoft", person);
    const { userId } = await whoami(session);
    await admin.api.members.setRole(userId, "user");

    await expect(joins(person)).resolves.toBe("user");
  });

  it("is refused for anyone but an admin, Grasp staff included", async () => {
    const builder = await signedInApi(idp, "builder");
    await expect(
      outcome(builder.api.members.invite(String(newcomer().email), "admin"))
    ).resolves.toBe("role.forbidden");
    await expect(outcome(builder.api.members.invitations())).resolves.toBe(
      "role.forbidden"
    );

    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    using api = core.authenticate();
    await expect(
      outcome(api.members.invite(String(newcomer().email), "user"))
    ).resolves.toBe("role.forbidden");
  });

  it("is refused for an address that could never sign in", async () => {
    const admin = await signedInApi(idp, "admin");
    const refused = await Promise.all(
      ["someone@elsewhere.test", "not an address", "a@sub.acme.test", ""].map(
        async (email) => await outcome(admin.api.members.invite(email, "user"))
      )
    );
    expect(new Set(refused)).toStrictEqual(new Set(["member.invite_email"]));
    const role = "owner";
    await expect(
      outcome(
        admin.api.members.invite(
          String(newcomer().email),
          // SAFETY: not a role at all: what a client could send anyway.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          role as Role
        )
      )
    ).resolves.toBe("member.role_invalid");
  });

  it("is refused for a member, someone removed, and someone invited already", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const removed = await signedInApi(idp, "user");
    await admin.api.members.remove(removed.userId);
    const person = newcomer();
    await admin.api.members.invite(String(person.email), "user");

    await expect(
      outcome(admin.api.members.invite(String(member.person.email), "admin"))
    ).resolves.toBe("member.invite_member");
    await expect(
      outcome(admin.api.members.invite(String(removed.person.email), "admin"))
    ).resolves.toBe("member.invite_removed");
    await expect(
      outcome(admin.api.members.invite(String(person.email), "admin"))
    ).resolves.toBe("member.invite_pending");
  });

  it("makes one invitation when two admins invite the same person at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const email = String(newcomer().email);

    const outcomes = await Promise.all([
      outcome(admin.api.members.invite(email, "user")),
      outcome(other.api.members.invite(email, "builder")),
    ]);

    expect(outcomes.toSorted()).toStrictEqual(["member.invite_pending", "ok"]);
    const open = await admin.api.members.invitations();
    expect(
      open.filter((invitation) => invitation.email === email)
    ).toHaveLength(1);
  });

  it("is audited with who did what, identifiers only", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const email = String(person.email);
    let invitationId = "";
    const invited = await auditedDuring(async () => {
      ({ id: invitationId } = await admin.api.members.invite(email, "builder"));
    });
    let session = "";
    const joined = await auditedDuring(async () => {
      session = await signedIn(idp, "microsoft", person);
    });
    const { userId } = await whoami(session);
    const second = await signedInApi(idp, "admin");
    const { id: withdrawnId } = await second.api.members.invite(
      String(newcomer().email),
      "user"
    );
    const withdrawn = await auditedDuring(async () => {
      await second.api.members.withdrawInvitation(withdrawnId);
    });

    expect(invited).toStrictEqual([
      expect.objectContaining({
        action: "member.invited",
        actor: { type: "person", userId: admin.userId },
        target: { type: "invitation", id: invitationId },
        detail: { role: "builder" },
      }),
    ]);
    const accepted = joined.filter(
      ({ action }) => action === "member.invitation.accepted"
    );
    expect(accepted).toStrictEqual([
      expect.objectContaining({
        target: { type: "invitation", id: invitationId },
        detail: { userId, role: "builder" },
      }),
    ]);
    expect(withdrawn).toStrictEqual([
      expect.objectContaining({
        action: "member.invitation.withdrawn",
        actor: { type: "person", userId: second.userId },
        target: { type: "invitation", id: withdrawnId },
        detail: { role: "user" },
      }),
    ]);
    const recorded = JSON.stringify([...invited, ...joined, ...withdrawn]);
    expect(recorded).not.toContain(email);
  });

  it("isn't audited when refused", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const events = await auditedDuring(async () => {
      await outcome(
        builder.api.members.invite(String(newcomer().email), "user")
      );
      await outcome(admin.api.members.invite("someone@elsewhere.test", "user"));
      await outcome(admin.api.members.withdrawInvitation("no-such-invitation"));
    });
    expect(events).toStrictEqual([]);
  });
});

/** `person` made a member by the directory, before they sign in: their member's user id. */
const madeByDirectory = async (person: Record<string, unknown>) => {
  const oid = String(person.oid);
  const userId = await memberFromDirectory(env, oid, {
    id: oid,
    name: String(person.name),
    email: String(person.email),
    department: "",
    title: "",
    manager: null,
  });
  if (userId === null) {
    throw new Error("The directory made no member");
  }
  return userId;
};

/** Whether invitation `id` is still open. */
const isPending = async (id: string) =>
  (await env.DB.prepare("SELECT status FROM invitations WHERE id = ?")
    .bind(id)
    .first<string>("status")) === "pending";

/** `userId`'s role. */
const roleOf = async (userId: string) =>
  await env.DB.prepare("SELECT role FROM members WHERE user_id = ?")
    .bind(userId)
    .first<string>("role");

describe("inviting someone the directory made a member before they signed in", () => {
  it("gives them the role at their first sign-in, as that member, and takes the invitation up once", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const member = await madeByDirectory(person);
    const { id } = await admin.api.members.invite(
      String(person.email),
      "builder"
    );
    let session = "";
    const events = await auditedDuring(async () => {
      session = await signedIn(idp, "microsoft", person);
    });

    await expect(whoami(session)).resolves.toMatchObject({
      userId: member,
      role: "builder",
    });
    await expect(admin.api.members.invitations()).resolves.not.toContainEqual(
      expect.objectContaining({ id })
    );
    expect(
      events.filter(({ action }) => action === "member.invitation.accepted")
    ).toStrictEqual([
      expect.objectContaining({
        target: { type: "invitation", id },
        detail: { userId: member, role: "builder" },
      }),
    ]);
  });

  it("makes a configured admin admin, while another admin is one, and records the change as the system's", async () => {
    await signedInApi(idp, "admin");
    const person = newcomer();
    const member = await madeByDirectory(person);
    const membership = await env.DB.prepare(
      "SELECT id FROM members WHERE user_id = ?"
    )
      .bind(member)
      .first<string>("id");
    let session = "";
    const events = await auditedDuring(async () => {
      session = await signedIn(idp, "microsoft", person, {
        coreEnv: withSignIn({ admins: [String(person.email)] }),
      });
    });

    await expect(whoami(session)).resolves.toMatchObject({
      userId: member,
      role: "admin",
    });
    expect(
      events
        .filter(({ action }) => action === "member.role.updated")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
    ).toStrictEqual([
      {
        actor: { type: "system" },
        target: { type: "member", id: membership },
        detail: { userId: member, role: "admin", reason: "joined" },
      },
    ]);
  });

  it("takes up a configured admin's invitation as admin, and records it once, by the take-up", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const member = await madeByDirectory(person);
    const { id } = await admin.api.members.invite(
      String(person.email),
      "builder"
    );
    let session = "";
    const events = await auditedDuring(async () => {
      session = await signedIn(idp, "microsoft", person, {
        coreEnv: withSignIn({ admins: [String(person.email)] }),
      });
    });

    await expect(whoami(session)).resolves.toMatchObject({
      userId: member,
      role: "admin",
    });
    await expect(isPending(id)).resolves.toBeFalsy();
    expect(
      events
        .filter(({ action }) =>
          ["member.invitation.accepted", "member.role.updated"].includes(action)
        )
        .map(({ action, target, detail }) => ({ action, target, detail }))
    ).toStrictEqual([
      {
        action: "member.invitation.accepted",
        target: { type: "invitation", id },
        detail: { userId: member, role: "admin" },
      },
    ]);
  });

  it("gives a suspended member no role and takes up nothing at a sign-in that is refused", async () => {
    const admin = await signedInApi(idp, "admin");
    /** Someone the directory made and suspended, invited as `role`, signing in: their role, and whether the invitation is open. */
    const suspendedSignsIn = async (role: Role) => {
      const person = newcomer();
      const member = await madeByDirectory(person);
      await env.DB.prepare(
        "UPDATE members SET suspended_at = ?, suspended_by = 'directory' WHERE user_id = ?"
      )
        .bind(Date.now(), member)
        .run();
      const { id } = await admin.api.members.invite(String(person.email), role);
      const session = await signedIn(idp, "microsoft", person).catch(
        () => null
      );
      return {
        session,
        role: await roleOf(member),
        pending: await isPending(id),
      };
    };

    // Invited as builder (a role the fold would give) and as user (the
    // role they have, so only their suspension stops the take-up).
    await expect(suspendedSignsIn("builder")).resolves.toStrictEqual({
      session: null,
      role: "user",
      pending: true,
    });
    await expect(suspendedSignsIn("user")).resolves.toStrictEqual({
      session: null,
      role: "user",
      pending: true,
    });
  });

  it("keeps a role an admin gave them before they signed in, and leaves the invitation open", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const member = await madeByDirectory(person);
    await admin.api.members.setRole(member, "builder");
    const { id } = await admin.api.members.invite(
      String(person.email),
      "admin"
    );
    const session = await signedIn(idp, "microsoft", person);

    await expect(whoami(session)).resolves.toMatchObject({
      userId: member,
      role: "builder",
    });
    await expect(isPending(id)).resolves.toBeTruthy();
  });

  it("gives nothing when withdrawn just before their first sign-in lands", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = newcomer();
    const member = await madeByDirectory(person);
    const { id } = await admin.api.members.invite(
      String(person.email),
      "admin"
    );
    // Withdrawn after core read the invitation, just before the fold lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare("UPDATE invitations SET status = 'canceled' WHERE id = ?")
          .bind(id)
          .run()
    );
    const session = await signedIn(idp, "microsoft", person, {
      coreEnv: { ...env, DB: racing },
    });

    await expect(whoami(session)).resolves.toMatchObject({
      userId: member,
      role: "user",
    });
  });

  it("gives nothing, and takes up nothing, when the fold doesn't land", async () => {
    const admin = await signedInApi(idp, "admin");
    /** A person invited as `role` whose first sign-in folds nothing: their member's role, and whether the invitation is open. */
    const unfolded = async (role: Role) => {
      const person = newcomer();
      const member = await madeByDirectory(person);
      const { id } = await admin.api.members.invite(String(person.email), role);
      // Their sign-in's own user, a member already by another sign-in of
      // theirs: the batch folds nothing.
      const fresh = crypto.randomUUID();
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
        ).bind(fresh, String(person.name), String(person.email), now, now),
        env.DB.prepare(
          "INSERT INTO accounts (id, account_id, provider_id, user_id, oid, created_at, updated_at) VALUES (?, ?, 'microsoft', ?, ?, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          String(person.sub),
          fresh,
          String(person.oid),
          now,
          now
        ),
        env.DB.prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) SELECT ?, organization_id, ?, 'user', ? FROM members WHERE user_id = ?"
        ).bind(crypto.randomUUID(), fresh, now, member),
      ]);
      const adopted = await adoptDirectoryMember(env, fresh, async () => {
        // Nothing of theirs to move.
      });
      return {
        adopted: adopted === fresh,
        role: await roleOf(member),
        pending: await isPending(id),
      };
    };

    // Invited as builder (a role the fold would give) and as user (the
    // role they have, so only the fold's landing decides the take-up).
    await expect(unfolded("builder")).resolves.toStrictEqual({
      adopted: true,
      role: "user",
      pending: true,
    });
    await expect(unfolded("user")).resolves.toStrictEqual({
      adopted: true,
      role: "user",
      pending: true,
    });
  });
});
