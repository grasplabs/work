import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Service principals (platform specification 15.1): who a trigger's runs
// act for when no person should, such as an integration that runs on its
// own. One is no person: it never signs in, holds no role in the
// organization and no permission of its own, and acts only in the
// workflows an admin authorized it for, each by name (its scope). Only the
// client's own admins make, scope and revoke them, never Grasp staff.

/** Why a call on service principals was refused. */
export const servicePrincipalErrors = defineErrorFamily({
  "service.invalid": "That isn't a service principal's name or ID.",
  "service.not_found": "There's no such service principal, or it was revoked.",
});

/** The prefix of every service principal's ID: never a person's. */
export const servicePrincipalPrefix = "svc_";

/** A service principal's ID: `svc_` and a UUID. */
export const servicePrincipalIdSchema = z
  .string()
  .regex(/^svc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

/** Whether `id` names a service principal rather than a person. */
export const isServicePrincipal = (id: string): boolean =>
  id.startsWith(servicePrincipalPrefix);

/** What an admin names a service principal. */
export const servicePrincipalNameSchema = z.string().trim().min(1).max(100);

/** A service principal, as admins see it. */
export interface ServicePrincipal {
  id: string;
  name: string;
  /** Who made it, and when (ISO 8601). */
  createdBy: string;
  createdAt: string;
  /** When it was revoked (ISO 8601): it acts for nothing since. */
  revokedAt: string | null;
  /** The workflows it may act in now: its scope. */
  workflows: string[];
}

/** The organization's service principals, for its own admins only. */
export interface ServicePrincipalsApi {
  /** Every service principal, revoked ones too, newest first. */
  list: () => Promise<ServicePrincipal[]>;
  /** Makes a service principal named `name`, scoped to nothing. */
  create: (name: string) => Promise<ServicePrincipal>;
  /** Revokes it for good: it acts for no start or call from now on. */
  revoke: (id: string) => Promise<void>;
  /** Lets it act in workflow `workflowId`: one more workflow in its scope. */
  grantScope: (id: string, workflowId: string) => Promise<void>;
  /** Takes workflow `workflowId` out of its scope: no more starts there. */
  revokeScope: (id: string, workflowId: string) => Promise<void>;
}
