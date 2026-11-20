import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

/** Roles a member of the company has inside a deployment (from Better Auth). */
export const roleSchema = z.enum(["admin", "builder", "user"]);
export type Role = z.infer<typeof roleSchema>;

/**
 * The membership role of a guest: someone outside the company with an
 * account of the deployment, who reaches nothing of the platform. Not one
 * of `roleSchema`'s on purpose: a guest is never a member, so every check
 * that reads a membership's role as a member's finds none for them.
 */
export const guestRole = "guest";

// What each role may do, as allow-lists: a role not named here, such as
// one added later or one a membership row holds by mistake, gets nothing.

/** Admins: manage members, teams and permissions. */
export const isAdmin = (role: string): boolean => role === "admin";

/**
 * One of the organization's own admins: an admin, and not Grasp staff,
 * who are admins too but never decide a client's permissions.
 */
export const isMemberAdmin = ({
  role,
  staff,
}: {
  role: string;
  staff: boolean;
}): boolean => isAdmin(role) && !staff;

/** Admins and builders: build Apps and ask for the permissions they need. */
export const canBuild = (role: string): boolean =>
  role === "admin" || role === "builder";

/** Why a call was refused for the caller's role. */
export const roleErrors = defineErrorFamily({
  "role.forbidden": "Your role doesn't allow that.",
});

/** Refuses anyone but an admin, with `role.forbidden`. */
export const requireAdmin = ({ role }: { role: string }): void => {
  if (!isAdmin(role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** Refuses anyone who isn't an admin or a builder, with `role.forbidden`. */
export const requireBuilder = ({ role }: { role: string }): void => {
  if (!canBuild(role)) {
    throw roleErrors.create("role.forbidden");
  }
};
