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
  /**
   * Their suspension, while they are suspended (they may not act or be
   * read as): since when (ISO 8601), and why, as the directory has their
   * account now (`DirectoryAccount`). Only the directory lifts it, at its
   * next daily read once it holds the account turned on again.
   */
  suspension: { since: string; reason: DirectoryAccount } | null;
}

/**
 * A member's account as the organization's directory holds it now: turned
 * on, turned off, deleted (Entra keeps a deleted account 30 days), or not
 * in it at all.
 */
export type DirectoryAccount = "enabled" | "disabled" | "deleted" | "unlisted";

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

/** A member, by name, as the directory's placement shows them to admins. */
export interface PlacedMember {
  userId: string;
  name: string;
  email: string;
}

/** A team, by its ID and name. */
export interface TeamName {
  id: string;
  name: string;
}

/**
 * A member who may act and is in no team (GRA-2056, slice 4), with what
 * the directory says of them: an admin places them by hand.
 */
export interface UnplacedMember extends PlacedMember {
  /**
   * Their department as the directory holds it: empty for none, null when
   * the directory holds no account of theirs (or none is read).
   */
  department: string | null;
  /** The team that department is linked to, if it is. */
  departmentTeam: TeamName | null;
}

/**
 * A member in a team the directory's read put them in, which their
 * department there no longer fills (GRA-2135): the read moves them only
 * into the team their department fills, so they stay until an admin acts.
 */
export interface DirectoryMover extends PlacedMember {
  /** The team the read put them in. */
  team: TeamName;
  /** Their department as the directory holds it now; empty for none. */
  department: string;
  /** The team that department is linked to, if it is. */
  departmentTeam: TeamName | null;
}

/**
 * An admin's hand add (`kept`) or removal of a member tied to the
 * directory, in a team: the directory's read leaves that pair as the
 * admin set it until an admin releases it (`releaseTeamPin`).
 */
export interface TeamPin extends PlacedMember {
  team: TeamName;
  kept: boolean;
  /** When an admin set it (ISO 8601). */
  pinnedAt: string;
}

/** Who the directory leaves for an admin to place, and what admins placed by hand. */
export interface DirectoryPlacement {
  unplaced: UnplacedMember[];
  movers: DirectoryMover[];
  pins: TeamPin[];
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
  /**
   * `pending` until done, retried until then; `complete` once done;
   * `skipped` when it couldn't be done and won't be tried again (an
   * interview whose address was released, say): left as it is.
   */
  state: "pending" | "complete" | "skipped";
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
   * The areas erasing them takes, in the order they run: exactly what
   * this deployment's erasure does, so nothing more is promised.
   */
  areas: string[];
  /**
   * Whether the address that was theirs is kept out once they're erased:
   * signing in or being invited under it is refused, until an admin
   * releases it (`releaseAddress`) because the company gave it to someone
   * else.
   */
  addressKeptOut: boolean;
}

/**
 * Someone an admin removed, as admins see them, for erasing them
 * (GRA-903): their email until their erasure erases it, and where that
 * stands.
 */
export interface RemovedPerson {
  userId: string;
  name: string;
  /** Their email, or null once their erasure erased it. */
  email: string | null;
  /** When they were removed (ISO 8601). */
  removedAt: string;
  erasure: Erasure | null;
  /** As `ErasurePreview.addressKeptOut`. */
  addressKeptOut: boolean;
}

/**
 * Where a page of removed people or erasures goes on from: the last one
 * shown, by its time (`at`, ISO 8601) and the person's ID. The next page
 * lists those before it.
 */
export interface ErasureCursor {
  at: string;
  userId: string;
}

/** A page of the people admins removed, most recently removed first. */
export interface RemovedPeoplePage {
  people: RemovedPerson[];
  /** Whether more follow: list again from the last one's cursor. */
  more: boolean;
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
   * Erases the removed person with `userId` (GRA-903): each area the
   * preview names (`ErasurePreview.areas`) goes; their name and ID stay on
   * the company's records, so what they did stays traceable. `name` must be
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
  /**
   * The people admins removed, most recently removed first, with where
   * each one's erasure stands: who an admin may erase, and who they did.
   * The latest page, or the page before `before`.
   */
  removed: (before?: ErasureCursor) => Promise<RemovedPeoplePage>;
  /**
   * Lets the organization's directory decide again whether the member with
   * `userId` is in team `teamId`: takes away the pin an admin's hand add or
   * removal put on them there, audited. The membership stays as it is
   * until the directory's next daily read. Answers whether there was one.
   */
  releaseTeamPin: (
    userId: string,
    teamId: string
  ) => Promise<{ released: boolean }>;
  /**
   * Who of the members the directory leaves for an admin to place (in no
   * team; in a team its read made that their department no longer fills),
   * and every hand pin on a member tied to the directory.
   */
  directoryPlacement: () => Promise<DirectoryPlacement>;
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
  "member.invalid": "That isn't a page of this list as it was shown.",
  "member.erase_name_mismatch":
    "That isn't their name as it stands now. Check who you're erasing, and type their name exactly.",
});
