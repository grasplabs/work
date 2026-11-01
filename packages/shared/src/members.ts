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
 * One of the organization's teams, as admins manage them: who is in it,
 * by user ID. Teams are made and changed through Better Auth's
 * organization routes (`/api/auth/organization/*`), which audit each
 * change; this is only how an admin reads them all, as Better Auth lists
 * a team's members only to those in it.
 */
export interface OrganizationTeam {
  id: string;
  name: string;
  memberIds: string[];
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

/** Where one area of a person's erasure stands. */
export interface ErasureArea {
  /** The area, as the erasure names it: `identity` and so on. */
  area: string;
  /** `pending` until done, retried until then; `complete` once done. */
  state: "pending" | "complete";
}

/** A person's erasure, as admins see it. */
export interface Erasure {
  /** When an admin asked for it (ISO 8601). */
  requestedAt: string;
  /** When every area was done (ISO 8601), or null while any is pending. */
  completedAt: string | null;
  areas: ErasureArea[];
}

/**
 * What an admin sees before erasing someone (GRA-903): who they are now,
 * whether they were removed, which only then may be erased, and their
 * erasure, if one was asked for.
 */
export interface ErasurePreview {
  userId: string;
  name: string;
  /** Their email, or null once their erasure erased it. */
  email: string | null;
  removed: boolean;
  erasure: Erasure | null;
  /**
   * Whether the address that was theirs is kept out once they're erased:
   * signing in or being invited under it is refused, until an admin
   * releases it (`releaseAddress`) because the company gave it to someone
   * else.
   */
  addressKeptOut: boolean;
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
  /** The organization's teams by name, each with its members. */
  teams: () => Promise<OrganizationTeam[]>;
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
  /**
   * What erasing the person with `userId` would do, or where their erasure
   * stands: for a removed person only to be erased.
   */
  erasure: (userId: string) => Promise<ErasurePreview>;
  /**
   * Erases the removed person with `userId` (GRA-903): their email, their
   * sign-ins and their personal content go; their name and ID stay on the
   * company's records, so what they did stays traceable. `name` must be
   * their name exactly as the preview showed it. Asking again while it
   * runs, or after, answers where it stands.
   */
  erase: (userId: string, name: string) => Promise<Erasure>;
  /**
   * Lets `email` in again once it was an erased person's: the company gave
   * the address to someone else. Anyone signing in under it then comes
   * in, the erased person too, if their IdP still has the address.
   * Audited by the erased person's ID only. Answers whether an erased
   * person's address it was.
   */
  releaseAddress: (email: string) => Promise<{ released: boolean }>;
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
    "They were removed from the organization, and can't join again. If they were erased and the company gave their address to someone else, release the address first.",
  "member.invite_pending": "They're invited already.",
  "member.invitation_not_found":
    "There's no such invitation: it was taken up or withdrawn.",
  "member.erase_not_removed":
    "Remove them from the organization first: only someone removed can be erased.",
  "member.erase_name_mismatch":
    "That isn't their name as it stands now. Check who you're erasing, and type their name exactly.",
});
