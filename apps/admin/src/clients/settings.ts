/**
 * A client's settings, as staff change them on its page: its ring, its
 * sign-in (its record's `signIn`, which every deploy makes core's
 * `SIGN_IN` from), its Teams bot (src/clients/teams-bot.ts) and its sealed
 * secrets, such as its Teams bot's (src/deploy/sealed-secrets.ts). Each change is audited in the same batch
 * as the change, and only when it changes something.
 *
 * None of it reaches the client's account at once. The ring decides which
 * rollouts reach it; sign-in is set on core, the bot on connect and core,
 * and a sealed secret on connect, by its next deploy. Each also marks the
 * client
 * (`configChangedAt`), so the next rollout deploys it even when it's on
 * the release already (src/rollout/targets.ts).
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientRuns, clients, clientSealedSecrets } from "../db/schema.ts";
import {
  MissingStoreSecretError,
  signInApps,
  storeSecret,
} from "../deploy/context.ts";
import {
  adminUnreachable,
  clientSignInSchema,
  missingSignInApp,
} from "../deploy/core-config.ts";
import { sealSecret } from "../deploy/sealed-secrets.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { keyedHash } from "../deploy/upload.ts";
import { currentRun, hasEnded } from "../runners.ts";
import { teamsBotSchema } from "./teams-bot.ts";

/** Why staff's change to a client's settings was refused, as the page words it. */
export const settingsErrorCodes = [
  /** No such client. */
  "unknown_client",
  /** The sign-in isn't one: no IdP, a domain or email that isn't one. */
  "sign_in_invalid",
  /** The sign-in names no first admin, or one whose email isn't in its domains. */
  adminUnreachable,
  /** The sign-in names an IdP the admin has no OAuth app id for (ENTRA_CLIENT_ID, GOOGLE_CLIENT_ID). */
  "sign_in_app_missing",
  /** The client isn't active, so there's nothing live to apply settings to. */
  "not_active",
  /** The client's Workers don't run one release the admin made live. */
  "nothing_deployed",
  /** Another runner (provisioning, a rollout, a rollback) has the client. */
  "client_busy",
  /** Secrets Store has no `CLIENT_KEY` to fingerprint a sign-in's admins, or seal a secret, with. */
  "store_secret_missing",
  /** A secret to seal isn't one: empty, with spaces in it, or too long. */
  "secret_invalid",
  /** A Teams bot that isn't one: an app id or tenant that isn't a GUID, or no expiry day. */
  "teams_bot_invalid",
] as const;
export type SettingsErrorCode = (typeof settingsErrorCodes)[number];

export class SettingsError extends Error {
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

const clientIdSchema = z.string().min(1);

export const ringInputSchema = z.object({
  clientId: clientIdSchema,
  ring: z.int().nonnegative(),
});

/**
 * A sign-in as the page sends it, checked here rather than by the server
 * function's validator, so a refusal comes back as its code.
 */
export const signInInputSchema = z.object({
  clientId: clientIdSchema,
  signIn: z.unknown(),
});

/** Throws `unknown_client` unless the admin has client `clientId`. */
const assertClient = async (
  db: AdminDatabase,
  clientId: string
): Promise<void> => {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new SettingsError("unknown_client", `No client ${clientId}`);
  }
};

/**
 * Moves client `clientId` to ring `ring`, as `staff`, audited
 * (`client.ring`) when it changes: rollouts started from then on reach it
 * with that ring. Returns whether it changed.
 */
export const setRing = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof ringInputSchema>
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const { clientId, ring } = ringInputSchema.parse(input);
  await assertClient(db, clientId);
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ ring, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), ne(clients.ring, ring))),
    { action: "client.ring", clientId, detail: { ring } }
  );
};

/** What the key admins fingerprints are made with is derived for. */
const adminsFingerprintPurpose = "grasp-os console admins fingerprint";

/**
 * A fingerprint of client `clientId`'s first admins, whatever their
 * order: HMAC-SHA256 under a key HKDF derives from `key` (`CLIENT_KEY`)
 * for this purpose alone, as `secretsFingerprint` is made. It tells the
 * audit log that the admins changed, and whether to a list it had before,
 * without naming anyone; with the client's id in it, the same people at
 * two clients don't share one.
 */
const adminsFingerprint = async (
  key: string,
  clientId: string,
  admins: readonly string[]
): Promise<string> =>
  await keyedHash(await hkdfHmacKey(key, adminsFingerprintPurpose, ["sign"]), {
    clientId,
    admins: admins.toSorted(),
  });

/** `CLIENT_KEY`, or null while Secrets Store doesn't have it. */
const clientKey = async (env: Env): Promise<string | null> => {
  try {
    return await storeSecret(env, "CLIENT_KEY");
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
};

/**
 * Sets client `clientId`'s sign-in, as `staff`, audited (`client.sign_in`,
 * with its domains and IdPs, and of its admins, whose emails are personal
 * data, only a count and a keyed fingerprint, `adminsFingerprint`) when
 * it changes. Its
 * next deploy makes core's `SIGN_IN` from it. Refused as the record's own
 * rule refuses it: `admin_unreachable` without a first admin who can sign
 * in, `sign_in_app_missing` for an IdP the admin has no app id for,
 * `sign_in_invalid` for anything else. Returns whether it changed.
 *
 * Whether it changes anything is decided once, by the write itself: it
 * changes the record only where the sign-in there differs, whatever
 * another request made of it a moment before. While Secrets Store has no
 * `CLIENT_KEY` to make the fingerprint with, nothing is written, since a
 * change that couldn't say which admins it set isn't made: the same
 * condition is read instead, and a sign-in that differs is refused
 * (`store_secret_missing`), while the one the client has is no change.
 */
export const setSignIn = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof signInInputSchema>
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const { clientId, signIn } = signInInputSchema.parse(input);
  const parsed = clientSignInSchema.safeParse(signIn);
  if (!parsed.success) {
    const unreachable = parsed.error.issues.some(
      (issue) =>
        issue.code === "custom" && issue.params?.code === adminUnreachable
    );
    throw new SettingsError(
      unreachable ? adminUnreachable : "sign_in_invalid",
      `${clientId}'s sign-in isn't one it can be given`
    );
  }
  const missing = missingSignInApp(parsed.data, signInApps(env));
  if (missing !== null) {
    throw new SettingsError(
      "sign_in_app_missing",
      `The admin has no ${missing} app id for ${clientId}'s sign-in`
    );
  }
  await assertClient(db, clientId);
  const value = JSON.stringify(parsed.data);
  /** The client's record, while its sign-in isn't `value` already. */
  const whereItDiffers = and(
    eq(clients.id, clientId),
    or(isNull(clients.signIn), ne(clients.signIn, value))
  );
  const key = await clientKey(env);
  if (key === null) {
    // Nothing is written without the key, so this one read is the whole
    // decision: no change to make, or one that can't be recorded.
    const [differing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(whereItDiffers);
    if (differing === undefined) {
      return false;
    }
    throw new SettingsError(
      "store_secret_missing",
      `CLIENT_KEY is missing from Secrets Store: ${clientId}'s sign-in can't be changed`
    );
  }
  const admins = await adminsFingerprint(key, clientId, parsed.data.admins);
  const now = new Date();
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ signIn: value, configChangedAt: now, updatedAt: now })
      .where(whereItDiffers),
    {
      action: "client.sign_in",
      clientId,
      detail: {
        domains: parsed.data.domains.join(","),
        admins: parsed.data.admins.length,
        adminsFingerprint: admins,
        ...(parsed.data.entraTenantId === undefined
          ? {}
          : { entraTenantId: parsed.data.entraTenantId }),
        ...(parsed.data.googleHostedDomain === undefined
          ? {}
          : { googleHostedDomain: parsed.data.googleHostedDomain }),
      },
    }
  );
};

/**
 * A secret to seal as the page sends it: its value checked here rather
 * than by the server function's validator, so a refusal comes back as its
 * code and never carries the value back with it.
 */
export const sealedSecretInputSchema = z.object({
  clientId: clientIdSchema,
  name: z.enum(clientSealedSecrets.name.enumValues),
  value: z.unknown(),
});

/**
 * A secret's value: printable ASCII without spaces, as Entra's client
 * secrets are, so a value pasted with a space in it is refused rather
 * than sealed as a secret that never works.
 */
const secretValuePattern = /^[\u0021-\u007E]{8,256}$/u;

/** How often a set is tried while other sets of the same secret race it. */
const sealAttempts = 3;

/**
 * Writes `sealed` as client `clientId`'s secret `name` for
 * `setSealedSecret`, with its event, in one batch, only while what it
 * read still holds: false when another set of the same secret got there
 * in between, so the event's `replaced` would be wrong and it's read
 * again. Refused (`client_busy`) while a rollback holds the client.
 *
 * A rollback checks, once it holds the client, that the versions it puts
 * back carry the sealed secrets the admin holds (src/rollout/rollback.ts),
 * then puts them back: one replaced in between would come back with them.
 * So none is set while a rollback holds the client, in the same batch as
 * the set, as a rollback that claims the client after it reads the new
 * one.
 */
const writeSealed = async (
  env: Env,
  staff: Staff,
  {
    clientId,
    name,
    sealed,
  }: { clientId: string; name: SealedSecretName; sealed: string }
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const ofThis = and(
    eq(clientSealedSecrets.clientId, clientId),
    eq(clientSealedSecrets.name, name)
  );
  const [[had], run] = await Promise.all([
    db
      .select({ sealed: clientSealedSecrets.sealed })
      .from(clientSealedSecrets)
      .where(ofThis),
    currentRun(env, clientId),
  ]);
  const rollback = run?.kind === "rollback" ? run : null;
  if (rollback !== null && !hasEnded(rollback.status)) {
    throw new SettingsError(
      "client_busy",
      `${clientId} is being rolled back: set its ${name} once that's done`
    );
  }
  const noRollback = sql`NOT EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${clientId} AND ${clientRuns.kind} = ${"rollback"}${
    rollback === null
      ? sql``
      : sql` AND ${clientRuns.runId} <> ${rollback.runId}`
  })`;
  // Each seal has a fresh nonce, so what was read is told apart from any
  // other set's.
  const unchanged =
    had === undefined
      ? sql`NOT EXISTS (SELECT 1 FROM ${clientSealedSecrets} WHERE ${ofThis})`
      : sql`EXISTS (SELECT 1 FROM ${clientSealedSecrets} WHERE ${ofThis} AND ${clientSealedSecrets.sealed} = ${had.sealed})`;
  const now = new Date();
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ configChangedAt: now, updatedAt: now })
      .where(and(eq(clients.id, clientId), noRollback, unchanged)),
    {
      action: "client.sealed_secret",
      clientId,
      target: name,
      detail: { replaced: had !== undefined },
    },
    [
      // Only once the event is recorded: `changes()` reads its insert.
      db
        .insert(clientSealedSecrets)
        .select(
          sql`SELECT ${clientId}, ${name}, ${sealed}, ${staff.email}, ${now.getTime()} WHERE changes() > 0`
        )
        .onConflictDoUpdate({
          target: [clientSealedSecrets.clientId, clientSealedSecrets.name],
          set: { sealed, setBy: staff.email, setAt: now },
        }),
    ]
  );
};

/**
 * Seals `value` as client `clientId`'s secret `name`, such as its Teams
 * bot's (`TEAMS_BOT_SECRET`), as `staff`, replacing the one it had:
 * audited (`client.sealed_secret`, its name as the target, and whether it
 * replaced one), never with anything of the value, and marking the client
 * (`configChangedAt`) so its next deploy gives it to its connect. Refused
 * as `secret_invalid` for a value that isn't one, as
 * `store_secret_missing` while Secrets Store has no `CLIENT_KEY` to seal
 * it with, and as `client_busy` while a rollback holds the client
 * (`writeSealed`). Every set is a change: a sealed value can't be
 * compared without opening it, and nothing here opens one.
 *
 * Nothing reads it back: what staff see of it is who set it and when
 * (src/clients/setup.ts), and only a deploy opens it
 * (src/deploy/sealed-secrets.ts).
 */
export const setSealedSecret = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof sealedSecretInputSchema>
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const { clientId, name, value } = sealedSecretInputSchema.parse(input);
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!secretValuePattern.test(trimmed)) {
    throw new SettingsError(
      "secret_invalid",
      `That isn't a value ${clientId}'s ${name} can be`
    );
  }
  await assertClient(db, clientId);
  const key = await clientKey(env);
  if (key === null) {
    throw new SettingsError(
      "store_secret_missing",
      `CLIENT_KEY is missing from Secrets Store: ${clientId}'s ${name} can't be sealed`
    );
  }
  const sealed = await sealSecret(key, clientId, name, trimmed);
  for (let attempt = 0; attempt < sealAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only after a race
    if (await writeSealed(env, staff, { clientId, name, sealed })) {
      return true;
    }
  }
  throw new SettingsError(
    "client_busy",
    `${clientId}'s ${name} kept changing while it was set: try again`
  );
};

/**
 * A Teams bot as the page sends it, checked here rather than by the
 * server function's validator, so a refusal comes back as its code. Null
 * takes the bot away.
 */
export const teamsBotInputSchema = z.object({
  clientId: clientIdSchema,
  bot: z.unknown(),
});

/**
 * Sets client `clientId`'s Teams bot (src/clients/teams-bot.ts), or takes
 * it away with null, as `staff`: audited (`client.teams_bot`, with the
 * bot's app id, tenant and secret's expiry, none of them secret) and
 * marking the client (`configChangedAt`) when it changes, so its next
 * deploy gives its connect and core the bot. Refused as
 * `teams_bot_invalid` for one that isn't a bot. Returns whether it
 * changed; whether it does is decided by the write alone, as
 * `setSignIn`'s is.
 */
export const setTeamsBot = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof teamsBotInputSchema>
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const { clientId, bot } = teamsBotInputSchema.parse(input);
  const parsed = bot === null ? null : teamsBotSchema.safeParse(bot);
  if (parsed !== null && !parsed.success) {
    throw new SettingsError(
      "teams_bot_invalid",
      `That isn't a Teams bot ${clientId} can have`
    );
  }
  await assertClient(db, clientId);
  const now = new Date();
  if (parsed === null) {
    return await actIfChanged(
      db,
      staff,
      db
        .update(clients)
        .set({ teamsBot: null, configChangedAt: now, updatedAt: now })
        .where(and(eq(clients.id, clientId), isNotNull(clients.teamsBot))),
      { action: "client.teams_bot", clientId, detail: { removed: true } }
    );
  }
  // Its fields in one order, so the same bot is stored, and compared, alike.
  const { appId, tenantId, secretExpiresOn } = parsed.data;
  const value = JSON.stringify({ appId, tenantId, secretExpiresOn });
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ teamsBot: value, configChangedAt: now, updatedAt: now })
      .where(
        and(
          eq(clients.id, clientId),
          or(isNull(clients.teamsBot), ne(clients.teamsBot, value))
        )
      ),
    {
      action: "client.teams_bot",
      clientId,
      detail: { appId, tenantId, secretExpiresOn },
    }
  );
};
