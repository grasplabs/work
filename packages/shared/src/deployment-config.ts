import { z } from "zod";

import { appIdSchema, connectionIdSchema, workflowIdSchema } from "./ids.ts";
import { roleSchema } from "./roles.ts";
import { loopbackHosts } from "./router.ts";

// The deployment config vars the admin sets on core, as core parses them
// (with `deploymentConfig`, @grasp-os/shared/config) and the admin
// validates them before it deploys: one schema for both, so the admin
// never sets a value core would refuse. Each var is deployment config,
// never an in-product setting, so no admin session can change it. The
// `MEMORY_LIMITS` var's schema is `memoryLimitsSchema` in
// @grasp-os/shared/memory, `QUOTA_LIMITS`'s is `quotaLimitsSchema` in
// @grasp-os/shared/quota-policy, and `PLATFORM_CHANGE`'s is in
// @grasp-os/shared/platform-change.

// SIGN_IN (core's src/auth/config.ts)

export const domainSchema = z
  .string()
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, "a lowercase domain, e.g. acme.com");

/** An HTTPS origin, or plain HTTP on this machine for local development. */
const isOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  return secure && url.origin === value;
};

/**
 * How people sign in to a deployment: the `SIGN_IN` var. A compromised
 * admin session can't add a tenant, widen the domains or open staff
 * access. Without it nobody can sign in.
 *
 * It names at least one IdP for the client's people: its Entra tenant, its
 * Google Workspace, or both. One that names neither isn't a sign-in config
 * (its people could never sign in), so it's refused here, where core and
 * the admin both read it.
 */
export const signInConfigSchema = z
  .object({
    /**
     * The deployment's own address, e.g. `https://acme.<domain>`: where the
     * IdPs send people back, and the only page that may open `/rpc`.
     */
    origin: z.url().refine(isOrigin, "an https origin, without a path"),
    /** Email domains people may sign in with, exactly (no subdomains). */
    domains: z.array(domainSchema).min(1),
    /** Emails that get the admin role when they join. */
    admins: z.array(z.email().toLowerCase()).default([]),
    /*
     * A deployment may offer both IdPs, but a person is one account at one of
     * them: an email already signed in through one is refused through the
     * other, as accounts are never linked by email (threat model R15).
     */
    /** The client's Microsoft Entra tenant, pinned. */
    entra: z
      .object({ tenantId: z.guid(), clientId: z.string().min(1) })
      .optional(),
    /** The client's Google Workspace, pinned by its primary domain (`hd`). */
    google: z
      .object({ hostedDomain: domainSchema, clientId: z.string().min(1) })
      .optional(),
    /**
     * Grasp staff access, off unless the admin opens a window. Only the
     * listed people (Entra object ids in Grasp's own tenant) sign in, get
     * `role` without joining the organization, and lose access when `until`
     * passes. A window longer than {@link staffWindowMaxMs} is closed
     * (`staffWindowOpen`).
     */
    staff: z
      .object({
        tenantId: z.guid(),
        clientId: z.string().min(1),
        domains: z.array(domainSchema).min(1),
        oids: z.array(z.guid()).min(1),
        role: roleSchema,
        /**
         * What they reach: everything their role allows (`full`), or the
         * onboarding alone (`onboarding`: only its own `/rpc` namespaces,
         * until 7 days after Grasp's go).
         */
        scope: z.enum(["full", "onboarding"]).default("full"),
        /** When the admin opened the window. */
        opened: z.iso.datetime({ offset: true }),
        until: z.iso.datetime({ offset: true }),
      })
      .optional(),
  })
  .refine(({ entra, google }) => entra !== undefined || google !== undefined, {
    message: "An Entra tenant or a Google Workspace",
    path: ["entra"],
  });
export type SignInConfig = z.infer<typeof signInConfigSchema>;

/**
 * The domain of `email`, as core's sign-in reads it (core's
 * src/auth/claims.ts): after the last `@`, lowercase.
 */
const emailDomainOf = (email: string): string | undefined => {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : undefined;
};

/**
 * The admins of `config` who can never sign in: core signs in only people
 * whose email is in one of its `domains`, whichever IdP they come from.
 */
export const unreachableAdmins = ({
  domains,
  admins,
}: {
  domains: readonly string[];
  admins: readonly string[];
}): string[] =>
  admins.filter((email) => {
    const domain = emailDomainOf(email);
    return domain === undefined || !domains.includes(domain);
  });

/** The longest a staff window may be. */
export const staffWindowMaxMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the staff window is open at `now`: between `opened` and `until`,
 * and seven days long at most. A longer window counts as closed for its
 * whole length, never only once its end draws near: the admin opens short
 * windows, and a longer one is a mistake rather than a reason to let staff
 * in.
 */
export const staffWindowOpen = (
  config: SignInConfig | undefined,
  now: number
): boolean => {
  if (config?.staff === undefined) {
    return false;
  }
  const opened = Date.parse(config.staff.opened);
  const until = Date.parse(config.staff.until);
  return opened <= now && now < until && until - opened <= staffWindowMaxMs;
};

// MODEL_GATEWAY (core's src/models.ts and src/model-rules.ts)
//
// Its model references are checked against the models the gateway offers,
// which only core knows (its provider catalogs): each schema here takes
// that check as `modelRef`.

/** An AI Gateway ID: lowercase letters, digits and dashes. */
const gatewayIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * The provider the allowlist names voice models by, `elevenlabs/<model>`,
 * whichever way the gateway reaches it (`voiceGatewayProviders`).
 */
export const voiceModelProvider = "elevenlabs";

/**
 * How AI Gateway reaches ElevenLabs, by the gateway path it takes: its
 * native `elevenlabs` provider, or `custom-elevenlabs-eu`, a custom
 * provider in the deployment's gateway for ElevenLabs's EU host
 * (`https://api.eu.residency.elevenlabs.io`), as AI Gateway has no EU
 * endpoint of its own. The ElevenLabs key stays in the gateway either way.
 */
export const voiceGatewayProviders = [
  "elevenlabs",
  "custom-elevenlabs-eu",
] as const;

/** The `voice` part of the `MODEL_GATEWAY` var: the native provider unless set. */
const voiceGatewaySchema = z
  .strictObject({ provider: z.enum(voiceGatewayProviders) })
  .optional();

/**
 * The allowlist's part of the `MODEL_GATEWAY` var: the deployment's AI
 * Gateway, the models it allows, and how it reaches the voice models.
 * `modelRef` checks one `<provider>/<model>` the gateway offers.
 */
export const modelGatewayConfigSchema = (modelRef: z.ZodType<string>) =>
  z
    .object({
      /** The deployment's AI Gateway, in the deployment's own account. */
      gateway: z.string().regex(gatewayIdPattern),
      /** The models this deployment allows; every other model is refused. */
      models: z.array(modelRef).min(1),
      /**
       * The model that plays each role (`modelRoles`), one of the allowed
       * models. A role left out goes to the first allowed model the
       * call's rules let it use, as every call did before roles.
       */
      roles: z
        .strictObject({
          quick: modelRef.optional(),
          careful: modelRef.optional(),
        } satisfies Record<ModelRole, z.ZodType>)
        .optional(),
      /** How the gateway reaches ElevenLabs: its native provider unless set. */
      voice: voiceGatewaySchema,
    })
    .refine(
      ({ models: allowed, roles }) =>
        Object.values(roles ?? {}).every(
          (ref) => ref === undefined || allowed.includes(ref)
        ),
      { message: "A role's model is an allowed model", path: ["roles"] }
    );

/**
 * What core's own features ask the gateway for, rather than a model:
 * `quick` for a line someone is waiting to hear, `careful` for reading and
 * writing that must be right. The deployment names the model for each in
 * `MODEL_GATEWAY`'s `roles`.
 */
export const modelRoles = ["quick", "careful"] as const;
export type ModelRole = (typeof modelRoles)[number];

/**
 * The model a role gets on a deployment that names none for it, where its
 * allowlist has that model and the rules let the call use it; otherwise
 * the role takes the first allowed model the rules let it use. `quick`
 * defaults to GLM 5.3 Flash, which thinks at low effort, as quick lines
 * ask: DeepSeek V4.1 Flash, chat's default and the first allowed, thinks
 * at high at least, too slow for a line someone is waiting to hear.
 */
export const defaultRoleModels: Readonly<Partial<Record<ModelRole, string>>> = {
  quick: "workers-ai/@cf/zai-org/glm-5.3-flash",
};

/**
 * The models a new deployment allows until staff change its
 * `MODEL_GATEWAY`, and core allows while none is set: Workers AI's, which
 * AI Gateway runs on the client's own account with no provider key, so a
 * client can call a model on day one. The first is chat's default.
 *
 * Chosen on the Brain baseline's real-model runs: DeepSeek V4.1 Flash
 * answered best and followed the answer protocol, well within the cost
 * target; GLM 5.3 Flash is the cheapest to complete a task with. Both
 * search Knowledge with tools, which Llama 3.3, the earlier default, never
 * did.
 */
export const defaultGatewayModels = [
  "workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "workers-ai/@cf/zai-org/glm-5.3-flash",
] as const;

const budgetSchema = z.strictObject({
  /**
   * US dollars a month (a run lineage's: for its whole life): a cent at
   * least, and well within an integer.
   */
  limit: z.number().min(0.01).max(1_000_000_000),
  /** The percent of the limit at which admins are alerted. */
  alertAt: z.int().min(1).max(99).default(80),
});

/** The budgets' part of the gateway config (core's src/model-budgets.ts). */
export const budgetsSchema = z
  .strictObject({
    /** All the deployment's calls together. */
    deployment: budgetSchema.optional(),
    /** Each workflow's AI steps, each workflow on its own. */
    workflow: budgetSchema.optional(),
    /** The calls made by or for each person, each on their own. */
    user: budgetSchema.optional(),
    /**
     * Each run lineage on its own: a run and every run started under it,
     * all its steps and retries, for the lineage's whole life, never reset
     * by a new month. No limit when absent: the lineage is still counted.
     */
    run: budgetSchema.optional(),
  })
  .optional();

/**
 * The rules' part of the gateway config: `modelRef` checks one
 * `<provider>/<model>` the gateway offers.
 */
const modelRulesShape = (modelRef: z.ZodType<string>) => ({
  eu: z
    .strictObject({
      /** The allowed models hosted in the EU. */
      models: z.array(modelRef).min(1),
      /** Every call of the deployment must stay in the EU. */
      deployment: z.boolean().default(false),
      /** Workflows whose AI steps must stay in the EU. */
      workflows: z
        .array(z.strictObject({ app: appIdSchema, workflow: workflowIdSchema }))
        .default([]),
      /** Connections whose data must stay in the EU. */
      connections: z.array(connectionIdSchema).default([]),
    })
    .optional(),
  sensitive: z
    .strictObject({
      /** The allowed models that may take sensitive data. */
      models: z.array(modelRef).min(1),
      /** Connections whose data is sensitive. */
      connections: z.array(connectionIdSchema).default([]),
    })
    .optional(),
  budgets: budgetsSchema,
});

export type ModelRules = z.output<
  z.ZodObject<ReturnType<typeof modelRulesShape>>
>;

/**
 * The client's other rules, in the same var as the allowlist. Core parses
 * them apart from it: a rule that doesn't parse refuses every call.
 */
export const modelRulesConfigSchema = (modelRef: z.ZodType<string>) =>
  z
    .object({
      models: z.array(z.string()),
      voice: voiceGatewaySchema,
      ...modelRulesShape(modelRef),
    })
    .refine(
      ({ models: allowed, eu }) =>
        eu === undefined || eu.models.every((ref) => allowed.includes(ref)),
      { message: "EU models are allowed models", path: ["eu", "models"] }
    )
    .refine(
      ({ models: allowed, sensitive }) =>
        sensitive === undefined ||
        sensitive.models.every((ref) => allowed.includes(ref)),
      {
        message: "Models for sensitive data are allowed models",
        path: ["sensitive", "models"],
      }
    )
    // ElevenLabs's native host isn't in the EU: a voice model listed as
    // hosted there is one the gateway reaches at ElevenLabs's EU host.
    .refine(
      ({ eu, voice }) =>
        voice?.provider === "custom-elevenlabs-eu" ||
        eu === undefined ||
        !eu.models.some((ref) => ref.startsWith(`${voiceModelProvider}/`)),
      {
        message: "EU voice models are reached at ElevenLabs's EU host",
        path: ["voice", "provider"],
      }
    );

// AUDIT_RETENTION_DAYS and AUDIT_ARCHIVE_RETENTION_DAYS (core's
// src/audit-log.ts)

/** Days the audit log keeps an event where admins search it, unless set. */
export const auditRetentionDefaultDays = 180;

/**
 * `AUDIT_RETENTION_DAYS`: at least 30 days (so an admin always has the
 * last month to search), at most ten years.
 */
export const auditRetentionSchema = z.int().min(30).max(3650);

/**
 * `AUDIT_ARCHIVE_RETENTION_DAYS`: how long archived stretches are kept, in
 * days from when the log received their last event: at least a year, at
 * most ten. Core also refuses one shorter than the retention.
 */
export const auditArchiveRetentionSchema = z.int().min(365).max(3650);

/**
 * Days an event is kept in all, archive included, unless set: seven years
 * (Nick's decision on GRA-903), or the log's own retention if that is
 * longer, so an unset archive retention is never shorter than it.
 */
export const auditArchiveRetentionDefaultDays = 7 * 365;

// RUN_RETENTION_DAYS (core's src/workflows/retention.ts)

/** Days an ended workflow run keeps its details, unless set. */
export const runRetentionDefaultDays = 30;

/**
 * `RUN_RETENTION_DAYS`: how long a workflow run keeps its details (its
 * input, what its steps returned, its output, why it failed) once it has
 * ended, in days: at least one, at most 30. Most of those details are the
 * engine's record of the run, and core has Cloudflare Workflows keep it
 * for this long (each instance's `retention`), which can be no longer
 * than the 30 days it keeps an ended instance on the Workers Paid plan.
 */
export const runRetentionSchema = z.int().min(1).max(30);

// INBOUND_MAIL_DOMAIN (core's src/workflows/overview.ts)

/**
 * `INBOUND_MAIL_DOMAIN`: the domain the deployment receives mail at, as
 * its Email Routing catch-all rule sends it to core (set up outside core),
 * so an email trigger's address shows whole: `<local part>@<domain>`. A
 * lowercase hostname of at most 253 characters, its labels at most 63,
 * none starting or ending with a hyphen.
 * Unset, triggers show their local part alone.
 */
export const inboundMailDomainSchema = domainSchema
  .max(253)
  .refine(
    (domain) =>
      domain
        .split(".")
        .every(
          (label) =>
            label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")
        ),
    {
      message:
        "Each part of the domain is at most 63 characters, and starts and ends with a letter or digit",
    }
  );

// MAIL_FROM (core's src/mail.ts)

/**
 * `MAIL_FROM`: who the mail core sends is from, `"<name>" <<address>>`:
 * an address on the deployment's sending domain, set up for Email Sending
 * outside core (the admin's src/deploy/resources.ts, which also locks
 * the `EMAIL` binding to that address), and the name shown with it. The name is one line with no
 * quotes or angle brackets, so it can't change the header it goes in.
 * Unset, core sends no mail: each one fails, and says why.
 */
export const mailFromSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^"<>\r\n]+$/u, "One line, without quotes or angle brackets"),
  address: z.email().max(254),
});
export type MailFrom = z.infer<typeof mailFromSchema>;

/**
 * The names of the deployment config vars above, the only settings the
 * admin sets on core as vars. `PLATFORM_CHANGE` is the admin's own, set
 * on every version it deploys, never a setting.
 */
export const deploymentConfigVars = [
  "SIGN_IN",
  "MODEL_GATEWAY",
  "MEMORY_LIMITS",
  "AUDIT_RETENTION_DAYS",
  "AUDIT_ARCHIVE_RETENTION_DAYS",
  "RUN_RETENTION_DAYS",
  "QUOTA_LIMITS",
  "INBOUND_MAIL_DOMAIN",
  "MAIL_FROM",
] as const;
