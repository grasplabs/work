/**
 * How a client's people sign in, as its record keeps it, and the one check
 * of it the new-client form, the server functions and every deploy make
 * (src/deploy/core-config.ts derives core's config from it). Plain data
 * and checks, so the admin's pages load it without any of the deploy.
 */
import {
  signInConfigSchema,
  unreachableAdmins,
} from "@grasp-os/shared/deployment-config";
import { z } from "zod";

const { domains, admins } = signInConfigSchema.shape;
const { hostedDomain } = signInConfigSchema.shape.google.unwrap().shape;

/**
 * Why a client's sign-in can't leave it with an admin: the code its issue
 * carries (`params.code`), which the new-client form and a deploy report.
 */
export const adminUnreachable = "admin_unreachable";

/**
 * How a client's people sign in, as its record keeps it: its own Entra
 * tenant, its Google Workspace (by its primary domain), or both; the email
 * domains they sign in with, and who gets the admin role on joining.
 *
 * Refused (`admin_unreachable`) without a first admin, and with one whose
 * email isn't in the email domains: core signs in only those, whichever
 * IdP they come from, so the client would have no admin who can ever
 * sign in. The same check for the form, the server functions and every
 * deploy.
 */
export const clientSignInSchema = z
  .object({
    domains,
    admins,
    entraTenantId: z.guid().optional(),
    googleHostedDomain: hostedDomain.optional(),
  })
  .refine(
    ({ entraTenantId, googleHostedDomain }) =>
      entraTenantId !== undefined || googleHostedDomain !== undefined,
    {
      message: "An Entra tenant or a Google Workspace",
      path: ["entraTenantId"],
    }
  )
  .superRefine((signIn, context) => {
    if (signIn.admins.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["admins"],
        params: { code: adminUnreachable },
        message:
          "Name at least one first admin, with an email in the email domains.",
      });
      return;
    }
    const unreachable = unreachableAdmins(signIn);
    if (unreachable.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["admins"],
        params: { code: adminUnreachable },
        message: `${unreachable.join(", ")} can't sign in: every first admin's email must be in the email domains (${signIn.domains.join(", ")}).`,
      });
    }
  });

/**
 * Why `signIn` isn't a client's sign-in, in words; null when it is.
 */
export const signInProblem = (signIn: unknown): string | null => {
  const parsed = clientSignInSchema.safeParse(signIn);
  if (parsed.success) {
    return null;
  }
  const [issue] = parsed.error.issues;
  return issue?.message ?? "The sign-in isn't complete.";
};
export type ClientSignIn = z.input<typeof clientSignInSchema>;
/** A client's sign-in as its record keeps it, once checked. */
export type ClientSignInRecord = z.output<typeof clientSignInSchema>;
