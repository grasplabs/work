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
import { eq, ne } from "drizzle-orm";
import type { z } from "zod";

import type { Staff } from "./access.ts";
import { act, adminDatabase } from "./db/act.ts";
import type { AdminDatabase } from "./db/act.ts";
import { clients, platformAi } from "./db/schema.ts";
import { platformKeyProviders } from "./deploy/context.ts";

/** Each feature's provider and model, every one set: what core is given. */
export type PlatformAiSettings = z.output<typeof platformAiSchema>;

/** One of the features. */
export type PlatformAiFeature = keyof PlatformAiSettings;

/** The one row's id. */
const settingsId = 1;

/**
 * The platform's AI settings: as staff last chose them, or the defaults
 * (OpenAI's) before they ever did.
 */
export const platformAiOf = async (
  db: AdminDatabase
): Promise<PlatformAiSettings> => {
  const row = await db
    .select({ settings: platformAi.settings })
    .from(platformAi)
    .where(eq(platformAi.id, settingsId))
    .get();
  // Checked when saved; parsed again, so nothing but settings core takes
  // ever goes out.
  const stored: unknown = row === undefined ? {} : JSON.parse(row.settings);
  return platformAiSchema.parse(stored);
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

/**
 * Why a change was refused: settings core wouldn't take (`invalid`), or a
 * feature on a provider Grasp has no key for (`key_missing`).
 */
export type PlatformAiRefusal = "invalid" | "key_missing";

/**
 * Sets the platform's AI settings to `input`, as `staff`, audited
 * (`platform.ai`, `{from, to}`) and marking every client not offboarded
 * so its next deploy gives its core the new `PLATFORM_AI`. Refused while a
 * feature names a provider not in `keyed`. Answers whether it changed.
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
  if (platformAiProviders(to).some(({ provider }) => !keyed.has(provider))) {
    return { refused: "key_missing", changed: false };
  }
  const from = await platformAiOf(db);
  const settings = JSON.stringify(to);
  if (settings === JSON.stringify(from)) {
    return { refused: null, changed: false };
  }
  const now = new Date();
  await act(
    db,
    staff,
    [
      db
        .insert(platformAi)
        .values({
          id: settingsId,
          settings,
          updatedBy: staff.email,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: platformAi.id,
          set: { settings, updatedBy: staff.email, updatedAt: now },
        }),
      db
        .update(clients)
        .set({ configChangedAt: now })
        .where(ne(clients.status, "offboarded")),
    ],
    {
      action: "platform.ai",
      detail: { from: JSON.stringify(from), to: settings },
    }
  );
  return { refused: null, changed: true };
};
