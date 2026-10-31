import type { AiProviderId } from "@grasp-os/shared/ai-providers";
/**
 * Which provider and model each of Grasp's own AI features uses (PDF
 * conversion for the Brain, transcription, speech: @grasp-os/shared/
 * platform-ai), as staff choose them on Platform → AI: kept once for the
 * platform in the admin's database, each change audited as the staff
 * member Access vouches for (`platform.ai`, with the settings before and
 * after), behind the Access check every request passes (src/access.ts).
 * Every deploy gives it to the client's core as its `PLATFORM_AI` var
 * (src/deploy/core-vars.ts), so a change reaches each client with its
 * next deploy: each client is marked (`configChangedAt`), so the next
 * rollout deploys it even on the release it runs.
 *
 * Only a provider Grasp has its own key for is offered or taken: the keys
 * live in Secrets Store and go to each client's connect alone; this reads
 * which are there, never what they are (`platformKeyProviders`).
 */
import { platformAiSchema } from "@grasp-os/shared/platform-ai";
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";

import type { Staff } from "./access.ts";
import { actIfChanged, adminDatabase } from "./db/act.ts";
import type { AdminDatabase } from "./db/act.ts";
import { clients, platformAi } from "./db/schema.ts";
import { platformKeyProviders } from "./deploy/context.ts";

/** Each feature's provider and model, every one set: what core is given. */
export type PlatformAiSettings = z.output<typeof platformAiSchema>;

/** One of the features. */
export type PlatformAiFeature = Exclude<keyof PlatformAiSettings, "region">;

/** The one row's id. */
const settingsId = 1;

/** The settings as stored, word for word (null before anyone chose), and as read. */
const storedOf = async (
  db: AdminDatabase
): Promise<{ raw: string | null; settings: PlatformAiSettings }> => {
  const row = await db
    .select({ settings: platformAi.settings })
    .from(platformAi)
    .where(eq(platformAi.id, settingsId))
    .get();
  // Checked when saved; parsed again, so nothing but settings core takes
  // ever goes out.
  const stored: unknown = row === undefined ? {} : JSON.parse(row.settings);
  return {
    raw: row?.settings ?? null,
    settings: platformAiSchema.parse(stored),
  };
};

/**
 * The platform's AI settings: as staff last chose them, or the defaults
 * (OpenAI's, and ElevenLabs's for speech) before they ever did.
 */
export const platformAiOf = async (
  db: AdminDatabase
): Promise<PlatformAiSettings> => {
  const { settings } = await storedOf(db);
  return settings;
};

/** The provider each feature sends to, for those that send anywhere. */
export const platformAiProviders = (
  settings: PlatformAiSettings
): { feature: PlatformAiFeature; provider: AiProviderId }[] => [
  ...(settings.conversion.provider === "local"
    ? []
    : [
        {
          feature: "conversion" as const,
          provider: settings.conversion.provider,
        },
      ]),
  { feature: "transcription", provider: settings.transcription.provider },
  { feature: "speech", provider: settings.speech.provider },
];

/** What Platform → AI shows: the settings, and which providers have Grasp's key. */
export interface PlatformAiView {
  settings: PlatformAiSettings;
  /** The providers Grasp has its own key for, so may be chosen. */
  keyed: AiProviderId[];
  /** Who last chose, and when; null while the defaults stand. */
  updated: { by: string; at: Date } | null;
}

export const platformAiView = async (envOf: Env): Promise<PlatformAiView> => {
  const db = adminDatabase(envOf.DB);
  const [settings, keyed, row] = await Promise.all([
    platformAiOf(db),
    platformKeyProviders(envOf),
    db
      .select({ by: platformAi.updatedBy, at: platformAi.updatedAt })
      .from(platformAi)
      .where(eq(platformAi.id, settingsId))
      .get(),
  ]);
  return { settings, keyed: [...keyed], updated: row ?? null };
};

/** How many times a save reads again after another crossed it. */
const saveAttempts = 5;

/**
 * Why a change was refused: settings core wouldn't take (`invalid`), or a
 * feature on a provider Grasp has no key for (`key_missing`).
 */
export type PlatformAiRefusal = "invalid" | "key_missing";

/**
 * Sets the platform's AI settings to `input`, as `staff`, audited
 * (`platform.ai`, `{from, to}`) and marking every client not offboarded
 * so its next deploy gives its core the new `PLATFORM_AI`. Refused while a
 * feature is moved to a provider not in `keyed`; one left on its provider
 * stays, key or not, so another feature can change while speech, whose
 * one provider is ElevenLabs, waits for its key. Answers whether it
 * changed.
 */
export const setPlatformAi = async (
  db: AdminDatabase,
  staff: Staff,
  input: unknown,
  keyed: ReadonlySet<AiProviderId>
): Promise<{ refused: PlatformAiRefusal | null; changed: boolean }> => {
  const parsed = platformAiSchema.safeParse(input);
  if (!parsed.success) {
    return { refused: "invalid", changed: false };
  }
  const to = parsed.data;
  const settings = JSON.stringify(to);
  for (let attempt = 0; attempt < saveAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read again after a save that crossed
    const from = await storedOf(db);
    const kept = platformAiProviders(from.settings);
    const moved = platformAiProviders(to).filter(
      (each) =>
        !kept.some(
          ({ feature, provider }) =>
            feature === each.feature && provider === each.provider
        )
    );
    if (moved.some(({ provider }) => !keyed.has(provider))) {
      return { refused: "key_missing", changed: false };
    }
    if (settings === JSON.stringify(from.settings)) {
      return { refused: null, changed: false };
    }
    const now = new Date();
    const row = { settings, updatedBy: staff.email, updatedAt: now };
    // Written only while the settings are still those read, and audited
    // only then, in the same batch: two saves that cross never both
    // record a change from the same settings.
    const written =
      from.raw === null
        ? db
            .insert(platformAi)
            .values({ id: settingsId, ...row })
            .onConflictDoNothing()
        : db
            .update(platformAi)
            .set(row)
            .where(
              and(
                eq(platformAi.id, settingsId),
                eq(platformAi.settings, from.raw)
              )
            );
    // oxlint-disable-next-line no-await-in-loop -- one save at a time
    const changed = await actIfChanged(
      db,
      staff,
      written,
      {
        action: "platform.ai",
        detail: { from: JSON.stringify(from.settings), to: settings },
      },
      // Marked either way: a save that crossed this one changed the
      // settings too, so each client's next deploy is due regardless.
      [
        db
          .update(clients)
          .set({ configChangedAt: now })
          .where(ne(clients.status, "offboarded")),
      ]
    );
    if (changed) {
      return { refused: null, changed: true };
    }
  }
  throw new Error("The platform's AI settings kept changing while saved");
};
