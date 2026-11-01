/**
 * The deployment config every deploy derives for a client's core:
 * `SIGN_IN`, from the client's record, `MAIL_FROM`, Grasp's onboarding
 * sender at the client's sending domain (`onboardingSender`), and
 * `RUNTIME_PROFILE`, `cloudflare`: every client runs on Cloudflare, which
 * enforces Code Mode's CPU limit, so its run records say so (core's
 * src/code-mode.ts). Derived on every deploy, so rollouts keep them. And
 * the check every deploy makes of the config it is about to set before it
 * changes anything (`checkDeployedConfig`).
 */
import {
  signInConfigSchema,
  unreachableAdmins,
} from "@grasp-os/shared/deployment-config";
import type {
  MailFrom,
  SignInConfig,
} from "@grasp-os/shared/deployment-config";
import { clientDomain } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { oauthRelayOrigin } from "@grasp-os/shared/oauth-relay";
import { z } from "zod";

import { DeployError } from "./errors.ts";

/**
 * The runtime every client's core runs on: Cloudflare, where the isolates
 * Code Mode loads have their CPU limit enforced. Not a setting: a client
 * can't make its run records claim otherwise.
 */
export const clientRuntimeProfile = "cloudflare";

/**
 * The client's sending domain: `mail.<id>.<domain>`, a zone of its own in
 * the client's account, below the client's hostname (`<id>.<domain>`)
 * rather than at it, so delegating it never takes the hostname the router
 * serves away from the router (src/hosting/operation.ts ensures it).
 */
export const clientMailDomain = (clientId: string, domain: string): string =>
  `mail.${clientId}.${domain}`;

/**
 * Who a client's onboarding mail is from: Grasp's onboarding sender at
 * the client's sending domain, by the product's name. Core's `MAIL_FROM`,
 * which is also where replies go unless a mail names another address, and
 * the only address the `EMAIL` binding may send from
 * (`allowed_sender_addresses`, src/deploy/upload.ts).
 */
export const onboardingSender = (
  clientId: string,
  domain: string
): MailFrom => ({
  name: "Grasp Work",
  address: `onboarding@${clientMailDomain(clientId, domain)}`,
});

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

/**
 * Grasp's multi-tenant OAuth apps' client ids (not secret: their secrets
 * are shared secrets, src/deploy/context.ts). Unset while the admin has
 * none for that IdP.
 */
export interface SignInApps {
  entraClientId?: string;
  googleClientId?: string;
}

/**
 * Client `clientId`'s `SIGN_IN`, from its record's `signIn` (JSON), at
 * `https://<clientId>.<domain>`; undefined for a client without one.
 * Refused (`sign_in_incomplete`) when the record doesn't parse (its
 * message says `admin_unreachable` when no first admin could sign in), or
 * it names an IdP the admin has no app id for, so no deploy leaves its
 * people unable to sign in unnoticed.
 */
const signInOf = (
  clientId: string,
  signIn: string | null,
  domain: string,
  apps: SignInApps,
  oauthRelay: Stage | undefined
): SignInConfig | undefined => {
  if (signIn === null) {
    return undefined;
  }
  const incomplete = (why: string): DeployError =>
    new DeployError("sign_in_incomplete", `${clientId}'s sign-in: ${why}`);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(signIn);
  } catch {
    // Not JSON: refused below, as a record that doesn't parse.
  }
  const record = clientSignInSchema.safeParse(parsed);
  if (!record.success) {
    // Named by its code, never its emails: a deploy's error is audited.
    const unreachable = record.error.issues.some(
      (issue) =>
        issue.code === "custom" && issue.params?.code === adminUnreachable
    );
    throw incomplete(
      unreachable
        ? `${adminUnreachable}: no first admin can sign in`
        : "its record doesn't parse"
    );
  }
  const { entraTenantId, googleHostedDomain } = record.data;
  if (entraTenantId !== undefined && apps.entraClientId === undefined) {
    throw incomplete("ENTRA_CLIENT_ID isn't set on the admin");
  }
  if (googleHostedDomain !== undefined && apps.googleClientId === undefined) {
    throw incomplete("GOOGLE_CLIENT_ID isn't set on the admin");
  }
  // The relay sends browsers back only to its stage's hosted domain.
  if (oauthRelay !== undefined && domain !== clientDomain(oauthRelay)) {
    throw incomplete(
      `the OAuth relay serves clients under ${clientDomain(oauthRelay)}, not ${domain}`
    );
  }
  const config = signInConfigSchema.safeParse({
    origin: `https://${clientId}.${domain}`,
    // Relay mode: the client's IdPs send people back through the stage's
    // OAuth relay (@grasp-os/shared/oauth-relay), so Grasp's shared OAuth
    // apps name one redirect URI, not one per client.
    ...(oauthRelay === undefined
      ? {}
      : { callbackOrigin: oauthRelayOrigin(oauthRelay) }),
    domains: record.data.domains,
    admins: record.data.admins,
    ...(entraTenantId === undefined
      ? {}
      : { entra: { tenantId: entraTenantId, clientId: apps.entraClientId } }),
    ...(googleHostedDomain === undefined
      ? {}
      : {
          google: {
            hostedDomain: googleHostedDomain,
            clientId: apps.googleClientId,
          },
        }),
  });
  if (!config.success) {
    throw incomplete("core wouldn't take it");
  }
  return config.data;
};

/**
 * Why `value` can't be core's `SIGN_IN`, as a code, or null when it can:
 * `sign_in_invalid` when core wouldn't parse it (one that names neither an
 * Entra tenant nor a Google Workspace included: nobody could sign in),
 * `admin_unreachable` when it names no admin, or one whose email isn't in
 * its domains (the rule `clientSignInSchema` applies to a client's
 * record). Checked on the `SIGN_IN` a deploy is about to set. A code,
 * never the emails: a deploy's error is audited.
 */
export const signInSettingProblem = (
  value: unknown
): "sign_in_invalid" | typeof adminUnreachable | null => {
  const config = signInConfigSchema.safeParse(value);
  if (!config.success) {
    return "sign_in_invalid";
  }
  return config.data.admins.length === 0 ||
    unreachableAdmins(config.data).length > 0
    ? adminUnreachable
    : null;
};

/**
 * Throws `sign_in_incomplete` unless `vars`, the config vars a deploy
 * of client `clientId` is about to set on core, has no `SIGN_IN` or one
 * with an admin who can sign in (`signInSettingProblem`).
 */
const checkDeployedSignIn = (
  clientId: string,
  vars: Readonly<Record<string, unknown>>
): void => {
  if (vars.SIGN_IN === undefined) {
    return;
  }
  const problem = signInSettingProblem(vars.SIGN_IN);
  if (problem !== null) {
    throw new DeployError(
      "sign_in_incomplete",
      `${clientId}'s SIGN_IN to deploy: ${problem}`
    );
  }
};

/**
 * Throws unless core would take the config a deploy of client `clientId`
 * is about to set on core (`vars`): `sign_in_incomplete` for a `SIGN_IN`
 * nobody, or no admin, could sign in with (`checkDeployedSignIn`). The
 * error never names an email.
 */
export const checkDeployedConfig = checkDeployedSignIn;

/**
 * The IdP `signIn` names that the admin has no OAuth app id for
 * (`apps`), or null when it has one for each: a deploy would refuse such
 * a sign-in (`sign_in_incomplete`), so it's refused when saved.
 */
export const missingSignInApp = (
  signIn: Pick<ClientSignInRecord, "entraTenantId" | "googleHostedDomain">,
  apps: SignInApps
): "entra" | "google" | null => {
  if (signIn.entraTenantId !== undefined && apps.entraClientId === undefined) {
    return "entra";
  }
  if (
    signIn.googleHostedDomain !== undefined &&
    apps.googleClientId === undefined
  ) {
    return "google";
  }
  return null;
};

/** What a client's derived core config is made from. */
export interface CoreConfigInputs {
  clientId: string;
  /** Its record's sign-in, JSON; null when it has none. */
  signIn: string | null;
  /** The domain clients are served under. */
  domain: string;
  apps: SignInApps;
  /**
   * Relay mode (`OAUTH_RELAY`, src/deploy/context.ts): the stage whose
   * OAuth relay the client's sign-in and connections come back through,
   * as Grasp-hosted clients' do. Absent, they come back to the client's
   * own origin, which needs its own OAuth apps.
   */
  oauthRelay?: Stage;
}

/**
 * The deployment config vars a deploy derives for a client's core:
 * `RUNTIME_PROFILE`, `CLIENT_ID` and `MAIL_FROM` (`onboardingSender`)
 * always, `SIGN_IN` when its record has sign-in. Every model key is its
 * connect's. `CLIENT_ID` is what core answers the provisioning probe with
 * (src/hosting/probe.ts).
 */
export const derivedCoreConfig = ({
  clientId,
  signIn,
  domain,
  apps,
  oauthRelay,
}: CoreConfigInputs): Record<string, unknown> => {
  const config = signInOf(clientId, signIn, domain, apps, oauthRelay);
  return {
    RUNTIME_PROFILE: clientRuntimeProfile,
    CLIENT_ID: clientId,
    MAIL_FROM: onboardingSender(clientId, domain),
    ...(config === undefined ? {} : { SIGN_IN: config }),
  };
};
