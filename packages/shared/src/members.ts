import { defineErrorFamily } from "./errors.ts";
import type { Role } from "./roles.ts";

/** A person in the organization, as admins see them. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  /** When they first signed in (ISO 8601). */
  joinedAt: string;
}

/**
 * An admin's invitation, not taken up yet: the role `email` gets when they
 * first sign in through the organization's IdP. Grasp sends no email;
 * whoever invites tells them.
 */
export interface Invitation {
  id: string;
  /** Lowercased, in one of the deployment's sign-in domains. */
  email: string;
  role: Role;
  /** Who invited them, by name. */
  invitedBy: string;
  /** When (ISO 8601). */
  invitedAt: string;
  /** When it lapses unused (ISO 8601): they then join as users. */
  expiresAt: string;
}

/**
 * The organization's members, over `/rpc`, for admins only (never Grasp
 * staff): offboarding. Removing someone is for good: every session they
 * have ends, their open connections close on their next call, their
 * personal connections are disconnected, and signing in again doesn't
 * bring them back.
 */
export interface MembersApi {
  list: () => Promise<Member[]>;
  /**
   * Removes the member with `userId`. Removing someone already removed
   * finishes what the first removal left undone (disconnecting their
   * personal connections), so it is safe to try again.
   */
  remove: (userId: string) => Promise<{ connectionsDisconnected: number }>;
  /** Ends every session of the member with `userId`, who stays a member. */
  revokeSessions: (userId: string) => Promise<void>;
  /**
   * Gives the member with `userId` `role`. Refused when it would leave the
   * organization without an admin.
   */
  setRole: (userId: string, role: Role) => Promise<void>;
  /** The invitations nobody has taken up yet, newest first. */
  invitations: () => Promise<Invitation[]>;
  /**
   * Invites `email` as `role`: their first sign-in makes them a member
   * with it. Refused for an address outside the sign-in domains, someone
   * who is a member already, removed, or invited already.
   */
  invite: (email: string, role: Role) => Promise<Invitation>;
  /** Withdraws an invitation nobody has taken up: they'd join as users. */
  withdrawInvitation: (invitationId: string) => Promise<void>;
}

/** Why an admin's change to a member was refused or not finished. */
export const memberErrors = defineErrorFamily({
  "member.not_found": "There's no such member.",
  "member.self":
    "You can't remove yourself or end your own sessions here. Ask another admin, or sign out.",
  "member.connections_pending":
    "They're removed, but not all their personal connections could be disconnected yet. This is retried automatically, or remove them again.",
  "member.role_invalid": "That isn't a role here.",
  "member.role_changed":
    "Another admin changed their role at the same time. Check it, and try again.",
  "member.last_admin":
    "The organization needs at least one admin. Make someone else an admin first.",
  "member.invite_email":
    "Use an email address in one of the domains your organization signs in with.",
  "member.invite_member": "They're a member already.",
  "member.invite_removed":
    "They were removed from the organization, and can't join again.",
  "member.invite_pending": "They're invited already.",
  "member.invitation_not_found":
    "There's no such invitation: it was taken up or withdrawn.",
});
