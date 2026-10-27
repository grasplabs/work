import { actorOf } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import { log } from "@grasp-os/shared/log";
import {
  billingSettingsSchema,
  noBilling,
  orgSettingsErrors,
  pulseSettingsSchema,
  quietPulse,
} from "@grasp-os/shared/org-settings";
import type {
  BillingSettings,
  BillingSettingsInput,
  OrgSettingsApi,
  PulseSettings,
  SignInSettings,
} from "@grasp-os/shared/org-settings";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { orgSettings } from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The organization's settings an admin keeps beside its name and time
// zone (@grasp-os/shared/org-settings): billing and Pulse, one row each in
// `org_settings`; and, read only, how people sign in, from the
// deployment's config. Its admins read them, Grasp staff included (whose every
// view is audited, staff-audit.ts); only its own admins change them, as
// for the organization's name: what the client is billed as and what
// Pulse watches are the client's to say. A change writes only while the
// admin still is one and the value differs, with its audit event in the
// same batch, naming the fields that changed, never their values (an
// address or an email is the client's business, not the log's).

/** A kind of setting: its row, how it is checked, and what it is until set. */
interface Kind<T> {
  key: "billing" | "pulse";
  schema: z.ZodType<T>;
  fallback: T;
  invalid: "org_settings.billing_invalid" | "org_settings.pulse_invalid";
}

const billing: Kind<BillingSettings> = {
  key: "billing",
  schema: billingSettingsSchema,
  fallback: noBilling,
  invalid: "org_settings.billing_invalid",
};

const pulse: Kind<PulseSettings> = {
  key: "pulse",
  schema: pulseSettingsSchema,
  fallback: quietPulse,
  invalid: "org_settings.pulse_invalid",
};

/**
 * A setting as stored, checked again as it is read: one that no longer
 * parses (a rule tightened since it was saved) reads as unset, and says so
 * in the logs, rather than handing a page what it can't show.
 */
const readSetting = async <T>(env: Env, kind: Kind<T>): Promise<T> => {
  const [row] = await drizzle(env.DB)
    .select({ value: orgSettings.value })
    .from(orgSettings)
    .where(eq(orgSettings.kind, kind.key));
  if (row === undefined) {
    return kind.fallback;
  }
  const parsed = kind.schema.safeParse(JSON.parse(row.value));
  if (!parsed.success) {
    log.warn("org_settings.unreadable", { kind: kind.key });
    return kind.fallback;
  }
  return parsed.data;
};

/** Admins read the settings, Grasp staff included; nobody else does. */
const requireReader = (by: Identity): void => {
  if (!isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** The fields of `next` whose value differs from `before`'s, by name, comma-separated. */
const changedFields = (before: object, next: object): string => {
  const was = new Map(Object.entries(before));
  return Object.entries(next)
    .filter(
      ([field, value]) =>
        JSON.stringify(value) !== JSON.stringify(was.get(field))
    )
    .map(([field]) => field)
    .toSorted()
    .join(",");
};
/**
 * Replaces a setting with `input`, checked, while `by` is one of the
 * organization's own admins: in one batch, the write (only while it
 * differs and they still are an admin) and its audit event, recorded only
 * when it wrote.
 */
const saveSetting = async <T extends object>(
  env: Env,
  by: Identity,
  kind: Kind<T>,
  input: unknown
): Promise<T> => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("org_settings.refused", { actor: by.userId, kind: kind.key });
    throw roleErrors.create("role.forbidden");
  }
  const parsed = kind.schema.safeParse(input);
  if (!parsed.success) {
    throw orgSettingsErrors.create(kind.invalid);
  }
  const next = parsed.data;
  const before = await readSetting(env, kind);
  const value = JSON.stringify(next);
  const now = Date.now();
  const db = drizzle(env.DB);
  // A row only while the person is still an admin; written only while it
  // differs, so the same save twice records one change.
  const whileAdmin = db
    .select({
      kind: sql<string>`${kind.key}`.as("kind"),
      value: sql<string>`${value}`.as("value"),
      updatedAt: sql<Date>`${now}`.as("updated_at"),
    })
    .from(sql`(SELECT 1)`)
    .where(activeMember(by.userId, ["admin"]));
  const [written] = await auditedBatch(env, db, [
    db
      .insert(orgSettings)
      .select(whileAdmin)
      .onConflictDoUpdate({
        target: orgSettings.kind,
        set: { value, updatedAt: new Date(now) },
        setWhere: sql`${orgSettings.value} <> ${value}`,
      }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: `org_settings.${kind.key}.updated`,
      target: { type: "organization", id: organizationId },
      detail: { fields: changedFields(before, next) },
    }),
  ]);
  if (written.meta.changes === 0) {
    // Nothing written: it already was so, or they stopped being an admin
    // since their session was checked.
    const still = await db.get<{ admin: number }>(
      sql`SELECT ${activeMember(by.userId, ["admin"])} AS admin`
    );
    if (still.admin !== 1) {
      throw roleErrors.create("role.forbidden");
    }
  }
  return await readSetting(env, kind);
};

const isSet = (secret: string | undefined): boolean =>
  secret !== undefined && secret !== "";

/**
 * How people sign in, from the deployment's config (auth/config.ts): what
 * is set up, and whether each secret is, never a secret itself.
 */
const signInOf = (env: Env, now: number): SignInSettings => {
  const config = signInConfig(env);
  if (config === undefined) {
    return { configured: false, domains: [], providers: [], staffWindow: null };
  }
  const entraSecret = isSet(env.ENTRA_CLIENT_SECRET);
  const googleSecret = isSet(env.GOOGLE_CLIENT_SECRET);
  return {
    configured: true,
    domains: config.domains,
    providers: [
      ...(config.entra === undefined
        ? []
        : [
            {
              provider: "microsoft" as const,
              tenantId: config.entra.tenantId,
              clientId: config.entra.clientId,
              secretSet: entraSecret,
              offered: entraSecret,
            },
          ]),
      ...(config.google === undefined
        ? []
        : [
            {
              provider: "google" as const,
              hostedDomain: config.google.hostedDomain,
              clientId: config.google.clientId,
              secretSet: googleSecret,
              offered: googleSecret,
            },
          ]),
    ],
    staffWindow:
      config.staff === undefined
        ? null
        : { open: staffWindowOpen(config, now), until: config.staff.until },
  };
};

/** A signed-in person's `orgSettings`. */
export class OrgSettingsRpc extends CoreRpcTarget implements OrgSettingsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async billing(): Promise<BillingSettings> {
    return await withPerson(this.#check, async (by) => {
      requireReader(by);
      return await readSetting(this.#env, billing);
    });
  }

  async updateBilling(input: BillingSettingsInput): Promise<BillingSettings> {
    return await withPerson(
      this.#check,
      async (by) => await saveSetting(this.#env, by, billing, input)
    );
  }

  async pulse(): Promise<PulseSettings> {
    return await withPerson(this.#check, async (by) => {
      requireReader(by);
      return await readSetting(this.#env, pulse);
    });
  }

  async signIn(): Promise<SignInSettings> {
    return await withPerson(this.#check, (by) => {
      requireReader(by);
      return signInOf(this.#env, Date.now());
    });
  }

  async updatePulse(input: PulseSettings): Promise<PulseSettings> {
    return await withPerson(
      this.#check,
      async (by) => await saveSetting(this.#env, by, pulse, input)
    );
  }
}
