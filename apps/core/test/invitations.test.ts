import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
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
