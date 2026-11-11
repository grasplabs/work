import { definitionText } from "@grasp-os/runtime/definition";
import type {
  PreviewAt,
  PreviewRefresh,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { QuerySnapshotPush } from "@grasp-os/shared/pages";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { sealDraftRelease } from "../src/app-releases.ts";
import { draftDefinition, draftFiles } from "../src/apps.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import type { Draft } from "../src/workspace.ts";
import { openTestRun } from "./agent-chat.ts";
import { sourceParts } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";
import type { signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App of spec 8's layout, as a test
// drives it (draft-runs.ts): a draft written as the chat's agent writes
// one, and calls of its functions as a page of the draft sends them, on
// every page's call path under the preview's lease, by references read
// from the draft sealed as its preview seals it.

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
  changes: TestSource
) => {
  const chat = await person.api.chats.create("Build");
  const chatId = chatIdSchema.parse(chat.id);
  const write = async (
    written: TestSource,
    revision: number
  ): Promise<number> => {
    const { files, definition } = sourceParts(written);
    const saved = await chatsOf(person).saveDraft(
      chatId,
      app,
      1,
      { ...files },
      [],
      revision,
      { runId: await openTestRun(chatsOf(person), chatId) },
      definition === undefined ? undefined : definitionText(definition)
    );
    if (!saved) {
      throw new Error("The draft wasn't written");
    }
    return revision + 1;
  };
  return { chatId, revision: await write(changes, 0), write };
};

/** What the test reads of a draft release's manifest. */
export const keptManifestSchema = z.object({
  resourceVersion: z.int(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

/** What the test reads of a draft release's contracts. */
const contractsSchema = z.object({
  fingerprints: z.record(z.string(), z.string()),
  manifest: z.object({
    functions: z.record(z.string(), z.object({ kind: z.string() })),
  }),
});

/** A call's answer, as the test reads it: its result. */
const answerSchema = z.object({
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** The contracts of `draft`, a draft of `app`, sealed as its preview seals it. */
const draftContracts = async (
  app: AppId,
  draft: Pick<Draft, "base" | "changes" | "definition">
): Promise<string | undefined> => {
  const definition = await draftDefinition(env, app, draft);
  if (definition === null) {
    throw new Error("The draft has no definition");
  }
  const sealed = await sealDraftRelease(
    env,
    { app, version: (draft.base ?? 0) + 1 },
    await draftFiles(env, app, draft),
    definition.definition
  );
  const manifest = keptManifestSchema.parse(JSON.parse(sealed.manifest));
  const sha256 = manifest.artifacts.find(
    (artifact) => artifact.path === ".grasp/contracts.json"
  )?.sha256;
  const bytes = sealed.artifacts.find(
    (artifact) => artifact.sha256 === sha256
  )?.bytes;
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/**
 * The call of `path` with `input` as a page of the chat's draft of `app`
 * sends it: its reference read from the contracts of the draft as it is
 * now, or of the App's version `revision` names.
 */
export const requestFor = async (
  person: Person,
  {
    chatId,
    app,
    revision,
  }: { chatId: ChatId; app: AppId; revision: PreviewAt },
  path: string,
  input: unknown = {}
): Promise<string> => {
  const draft =
    typeof revision === "number"
      ? await chatsOf(person).previewDraft(chatId, person.userId, app)
      : { base: revision.appVersion, changes: {}, definition: null };
  const read = contractsSchema.parse(
    JSON.parse((await draftContracts(app, draft)) ?? "null")
  );
  return JSON.stringify({
    reference: { name: path, kind: read.manifest.functions[path]?.kind },
    args: input,
  });
};

/** The leases previews opened with, by person, chat and App. */
const leases = new Map<string, Promise<string>>();

/**
 * The lease the chat's preview of `app` opens with, for `person`: opened
 * once, as a frame keeps its lease across the draft's writes.
 */
export const previewLease = async (
  person: Person,
  chatId: string,
  app: string
): Promise<string> => {
  const key = JSON.stringify([person.userId, chatId, app]);
  const kept =
    leases.get(key) ??
    (async () => {
      const { lease } = await person.api.chats.preview(chatId, app);
      if (lease === undefined) {
        throw new Error("The preview opened with no lease.");
      }
      return lease;
    })();
  leases.set(key, kept);
  try {
    return await kept;
  } catch (error) {
    leases.delete(key);
    throw error;
  }
};

/**
 * A call of the chat's preview of `app`, as its frame's page sends it: on
 * every page's call path (page-calls.ts), under the preview's lease (read
 * as the preview opens, unless given). Answers what core answered.
 */
export const previewCall = async (
  person: Person,
  chatId: string,
  app: string,
  request: string,
  lease?: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: person.session,
      [pagePersonHeader]: person.userId,
      [pageLeaseHeader]: lease ?? (await previewLease(person, chatId, app)),
    },
    body: request,
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    const { code, message } = errorPayloadSchema.parse(answer);
    throw Object.assign(new Error(message), { code });
  }
  return answer;
};

/**
 * Follows a live query of the chat's preview of `app`, as its frame does:
 * over the page's socket, on a frame opened with the preview's lease.
 */
export const previewWatch = async (
  person: Person,
  chatId: string,
  app: string,
  request: string,
  onSnapshot: (push: QuerySnapshotPush) => void,
  lease?: string
) =>
  await person.api.pages
    .frame(app, lease ?? (await previewLease(person, chatId, app)))
    .watchQuery(request, onSnapshot);

/** What a call of a preview's function answered: its value, or its error's code. */
export const outcome = (answer: unknown): unknown => {
  const { result } = answerSchema.parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** The build `update` hands the open frame: any other answer fails the test. */
export const refreshed = (update: PreviewUpdate): PreviewRefresh => {
  if (!("refresh" in update)) {
    throw new Error(`The update handed no build: ${JSON.stringify(update)}`);
  }
  return update.refresh;
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

/**
 * Whether throwaway store `id` was emptied for good: its object discarded,
 * so it refuses every call (`DataStore.emptyThrowaway`).
 */
export const storeEmptied = async (id: string): Promise<boolean> =>
  await runInDurableObject(
    inJurisdiction(env, env.DATA_STORES).getByName(id),
    (_instance, state) =>
      state.storage.kv.get("grasp_fixture_discarded") === true
  );
