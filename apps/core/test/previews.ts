import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { openTestRun } from "./agent-chat.ts";
import type { signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App of spec 8's layout, as a test
// drives it (sealed-previews.ts): a draft written as the chat's agent
// writes one, and calls of its functions as a screen of the draft sends
// them, by references read from the draft release the chat keeps.

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The Workspace object that holds `person`'s chats. */
export const chatsOf = (person: Pick<Person, "userId">) =>
  workspace(env, personalWorkspaceId(person.userId));

/**
 * `person`'s new chat, with a draft of `app` over version 1 whose files
 * are `changes`, as the chat's agent writes one.
 */
export const chatWithDraft = async (
  person: Person,
  app: AppId,
  changes: Record<string, string | null>
) => {
  const chat = await person.api.chats.create("Build");
  const chatId = chatIdSchema.parse(chat.id);
  const write = async (
    written: Record<string, string | null>,
    revision: number
  ): Promise<number> => {
    const saved = await chatsOf(person).saveDraft(
      chatId,
      app,
      1,
      written,
      [],
      revision,
      await openTestRun(chatsOf(person), chatId)
    );
    if (!saved) {
      throw new Error("The draft wasn't written");
    }
    return revision + 1;
  };
  return { chatId, revision: await write(changes, 0), write };
};

/** What the test reads of a kept draft release's manifest. */
export const keptManifestSchema = z.object({
  resourceVersion: z.int(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

/** What the test reads of a draft release's contracts. */
const contractsSchema = z.object({
  fingerprints: z.record(z.string(), z.string()),
  manifest: z.object({
    operations: z.record(z.string(), z.object({ kind: z.string() })),
  }),
});

/** A call's answer, as the test reads it: its result. */
const answerSchema = z.object({
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/**
 * The call of `path` with `input` as a screen of the draft at `revision`
 * sends it: its reference read from the contracts of the draft release
 * the chat's object keeps, sealed first if it isn't yet.
 */
export const requestFor = async (
  person: Person,
  { chatId, app, revision }: { chatId: ChatId; app: AppId; revision: number },
  path: string,
  input: unknown = {}
): Promise<string> => {
  await chatsOf(person).previewReferences(chatId, person.userId, app, revision);
  const kept = await runInDurableObject(chatsOf(person), (_instance, state) => {
    const [keptRelease] = state.storage.sql
      .exec<{ manifest: string }>(
        "SELECT manifest FROM preview_releases WHERE chat_id = ? AND app_id = ?",
        chatId,
        app
      )
      .toArray();
    const manifest = keptManifestSchema.parse(
      JSON.parse(keptRelease?.manifest ?? "null")
    );
    const sha256 = manifest.artifacts.find(
      (artifact) => artifact.path === ".grasp/contracts.json"
    )?.sha256;
    const [contracts] = state.storage.sql
      .exec<{ content: string }>(
        "SELECT content FROM preview_release_artifacts WHERE chat_id = ? AND sha256 = ?",
        chatId,
        sha256 ?? ""
      )
      .toArray();
    return { version: manifest.resourceVersion, text: contracts?.content };
  });
  const read = contractsSchema.parse(JSON.parse(kept.text ?? "null"));
  return JSON.stringify({
    reference: {
      resourceId: app,
      resourceVersion: kept.version,
      contractId: path,
      fingerprint: read.fingerprints[path],
      kind: read.manifest.operations[path]?.kind,
    },
    input,
  });
};

/** What a call of a preview's function answered: its value, or its error's code. */
export const outcome = (answer: unknown): unknown => {
  const { result } = answerSchema.parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** What the chat's object answered as text: its value, or its error's code. */
export const outcomeOfText = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);
  const answer: unknown =
    typeof parsed === "object" && parsed !== null && "answer" in parsed
      ? parsed.answer
      : parsed;
  return outcome(answer);
};

/** The stores the chat's previews of `app` keep, by revision. */
export const previewStores = async (
  person: Person,
  chatId: ChatId,
  app: AppId
) =>
  await runInDurableObject(chatsOf(person), (_instance, state) =>
    state.storage.sql
      .exec<{ store_id: string; revision: number }>(
        "SELECT store_id, revision FROM preview_stores WHERE chat_id = ? AND app_id = ?",
        chatId,
        app
      )
      .toArray()
  );
