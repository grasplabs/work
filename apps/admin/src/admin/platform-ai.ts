/**
 * The platform's default model transports, as staff set them on
 * Platform's AI page: one for each residency (`model_transport.eu`,
 * `model_transport.global` in `platform_settings`), the transport every
 * client of that residency takes until staff set one of its own
 * (src/deploy/model-transport.ts). Each change is audited
 * (`platform.model_transport`, the residency and the transport before and
 * after, kinds and names only) in the same batch as the change, and only
 * when it changes something. It reaches each client with its next deploy.
 */
import { modelResidencies } from "@grasp-os/shared/model-transport";
import type { ModelResidency } from "@grasp-os/shared/model-transport";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { platformSettings } from "../db/schema.ts";
import {
  AttestationError,
  attestationsOf,
  platformModelTransport,
  platformTransportKey,
  platformTransportSchema,
  stampAttestations,
  transportSummary,
} from "../deploy/model-transport.ts";
import type { PlatformTransport } from "../deploy/model-transport.ts";

/** Why staff's change to a platform default was refused, as the page words it. */
export const platformTransportErrorCodes = [
  /** A model transport that isn't one: a field missing or malformed. */
  "model_transport_invalid",
  /** An EU attestation made as someone other than the staff member saving it. */
  "attestation_not_yours",
  /** Others kept changing the default while this change was made: read it again. */
  "changed_meanwhile",
] as const;
export type PlatformTransportErrorCode =
  (typeof platformTransportErrorCodes)[number];

export class PlatformTransportError extends Error {
  readonly code: PlatformTransportErrorCode;

  constructor(code: PlatformTransportErrorCode, message: string) {
    super(message);
    this.name = "PlatformTransportError";
    this.code = code;
  }
}

/** A default as the page sends it; null takes it away, back to the built-in one. */
export const platformTransportInputSchema = z.object({
  residency: z.enum(modelResidencies),
  transport: z.unknown(),
});

/** Each residency's default as staff set it; null for one they set none for. */
export type PlatformTransports = Record<
  ModelResidency,
  PlatformTransport | null
>;

/** The platform's defaults, by residency. */
export const platformTransports = async (
  envOf: Env
): Promise<PlatformTransports> => {
  const db = adminDatabase(envOf.DB);
  const [eu, global] = await Promise.all([
    platformModelTransport(db, "eu"),
    platformModelTransport(db, "global"),
  ]);
  return { eu, global };
};

/** The default for `residency` as stored; undefined without one. */
const storedDefault = async (
  db: AdminDatabase,
  residency: ModelResidency
): Promise<string | undefined> => {
  const row = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, platformTransportKey(residency)))
    .get();
  return row?.value;
};

/** How often a default is read again when another save got in between. */
const defaultTries = 3;

/**
 * `input` as the default `staff` may set: refused as
 * `model_transport_invalid` for one that isn't a transport and
 * `attestation_not_yours` for an EU attestation made as someone else; a
 * new attestation is stamped with `staff` and now.
 */
const defaultToSet = (
  staff: Staff,
  input: unknown,
  had: PlatformTransport | null
): PlatformTransport => {
  let stamped: unknown = undefined;
  try {
    stamped = stampAttestations(input, attestationsOf(had), {
      email: staff.email,
      now: new Date(),
    });
  } catch (error) {
    if (error instanceof AttestationError) {
      throw new PlatformTransportError(
        "attestation_not_yours",
        "An EU attestation can only be made as yourself"
      );
    }
    throw error;
  }
  const parsed = platformTransportSchema.safeParse(stamped);
  if (!parsed.success) {
    throw new PlatformTransportError(
      "model_transport_invalid",
      "That isn't a model transport"
    );
  }
  return parsed.data;
};

/**
 * Sets the platform's default transport for `residency`, or with null
 * takes it away (back to the built-in one), as `staff`: audited
 * (`platform.model_transport`) when it changes. Clients of that residency
 * without a transport of their own take it with their next deploy.
 * Returns whether it changed.
 */
export const setPlatformModelTransport = async (
  envOf: Env,
  staff: Staff,
  input: z.input<typeof platformTransportInputSchema>
): Promise<boolean> => {
  const db = adminDatabase(envOf.DB);
  const { residency, transport } = platformTransportInputSchema.parse(input);
  const key = platformTransportKey(residency);
  for (let tried = 0; tried < defaultTries; tried += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read again after a save in between
    const had = await storedDefault(db, residency);
    // oxlint-disable-next-line no-await-in-loop -- read again after a save in between
    const hadDefault = await platformModelTransport(db, residency);
    const next =
      transport === null ? null : defaultToSet(staff, transport, hadDefault);
    const value = next === null ? undefined : JSON.stringify(next);
    if (value === had) {
      return false;
    }
    const now = new Date();
    const ofThis = eq(platformSettings.key, key);
    let statement: BatchItem<"sqlite">;
    if (value === undefined) {
      statement = db
        .delete(platformSettings)
        .where(and(ofThis, eq(platformSettings.value, had ?? "")));
    } else if (had === undefined) {
      statement = db
        .insert(platformSettings)
        .values({ key, value, updatedBy: staff.email, updatedAt: now })
        .onConflictDoNothing();
    } else {
      statement = db
        .update(platformSettings)
        .set({ value, updatedBy: staff.email, updatedAt: now })
        .where(and(ofThis, eq(platformSettings.value, had)));
    }
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    const changed = await actIfChanged(db, staff, statement, {
      action: "platform.model_transport",
      target: residency,
      detail: {
        residency,
        from: hadDefault === null ? "built-in" : transportSummary(hadDefault),
        to: next === null ? "built-in" : transportSummary(next),
      },
    });
    if (changed) {
      return true;
    }
  }
  throw new PlatformTransportError(
    "changed_meanwhile",
    `The ${residency} default kept changing while it was set`
  );
};

/** The platform's defaults, for Platform's AI page. */
export const fetchPlatformTransports = createServerFn({
  method: "GET",
}).handler(async () => await platformTransports(env));

/** What a change of a default answers: whether it changed anything, or why it was refused. */
export type PlatformTransportChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: PlatformTransportErrorCode };

/**
 * Sets the platform's default transport for a residency, audited as the
 * staff member Access vouches for; a refusal answered as its code.
 */
export const setPlatformModelTransportFn = createServerFn({ method: "POST" })
  .validator(platformTransportInputSchema)
  .handler(async ({ data, context }): Promise<PlatformTransportChange> => {
    try {
      return {
        changed: await setPlatformModelTransport(env, context.staff, data),
        refused: null,
      };
    } catch (error) {
      if (error instanceof PlatformTransportError) {
        return { changed: null, refused: error.code };
      }
      throw error;
    }
  });
