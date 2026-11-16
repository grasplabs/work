import { definitionText } from "@grasp-os/runtime/definition";
import type {
  PreviewAt,
  PreviewRefresh,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
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
import { appKind, draftDefinition } from "../src/apps.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { filesOf, readDraft, saveDraft } from "../src/drafts.ts";
import type { DraftState } from "../src/drafts.ts";
import {
  appPreview,
  inJurisdiction,
  workspace,
} from "../src/durable-objects.ts";
import { sourceParts } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { agentWriting } from "./draft-writers.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";
import type { signedInApi } from "./sign-in.ts";

// An App's preview of its one shared draft, as a test drives it
// (draft-runs.ts, app-preview.ts): the draft written as a chat's agent
// writes it, and calls of its functions as a page of the draft sends them,
// on every page's call path under the preview's lease, by references read
// from the draft sealed as its preview seals it.

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The Workspace object that holds `person`'s chats. */
export const chatsOf = (person: Pick<Person, "userId">) =>
  workspace(env, personalWorkspaceId(person.userId));

/** The object that holds App `app`'s preview of its draft (app-preview.ts). */
export const previewOf = (app: AppId) => appPreview(env, app);

/**
 * `person`'s new chat, whose agent writes `changes` into the draft of
 * `app` over version 1, as it writes one; `write` writes more, over the
 * draft's `revision` (refused with `app.conflict` once it moved).
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
    const now = await readDraft(env, { kind: "app", id: app });
    await saveDraft(
      env,
      appKind,

      app,
      { ...now, base: 1, revision },
      {
        changes: { ...files },
        unchanged: [],
        ...(definition === undefined
          ? {}
          : { definition: definitionText(definition) }),
      },
      await agentWriting(person, chatId)
    );
    return revision + 1;
  };
  const before = await readDraft(env, { kind: "app", id: app });
  return { chatId, revision: await write(changes, before.revision), write };
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
  draft: Pick<DraftState, "base" | "changes" | "definition">
): Promise<string | undefined> => {
  const definition = await draftDefinition(env, app, draft);
  if (definition === null) {
    throw new Error("The draft has no definition");
  }
  const sealed = await sealDraftRelease(
    env,
    { app, version: (draft.base ?? 0) + 1 },
    await filesOf(env, appKind, app, draft),
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
 * The call of `path` with `input` as a page of App `app`'s draft sends
 * it: its reference read from the contracts of the draft as the preview
 * shows it now, or of the App's version `revision` names.
 */
export const requestFor = async (
  { app, revision }: { app: AppId; revision: PreviewAt },
  path: string,
  input: unknown = {}
): Promise<string> => {
  const draft =
    typeof revision === "number"
      ? await previewOf(app).draft()
      : { base: revision.appVersion, changes: {}, definition: null };
  const read = contractsSchema.parse(
    JSON.parse((await draftContracts(app, draft)) ?? "null")
  );
  return JSON.stringify({
    reference: { name: path, kind: read.manifest.functions[path]?.kind },
    args: input,
  });
};

/** The leases previews opened with, by person and App. */
const leases = new Map<string, Promise<string>>();

/**
 * The lease `person`'s preview of `app` opens with: opened once, as a
 * frame keeps its lease across the draft's writes.
 */
export const previewLease = async (
  person: Person,
  app: string
): Promise<string> => {
  const key = JSON.stringify([person.userId, app]);
  const kept =
    leases.get(key) ??
    (async () => {
      const { lease } = await person.api.apps.preview.open(app);
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
 * A call of `person`'s preview of `app`, as its frame's page sends it: on
 * every page's call path (page-calls.ts), under the preview's lease (read
 * as the preview opens, unless given). Answers what core answered.
 */
export const previewCall = async (
  person: Person,
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
      [pageLeaseHeader]: lease ?? (await previewLease(person, app)),
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
 * Follows a live query of `person`'s preview of `app`, as its frame does:
 * over the page's socket, on a frame opened with the preview's lease.
 */
export const previewWatch = async (
  person: Person,
  app: string,
  request: string,
  onSnapshot: (push: QuerySnapshotPush) => void,
  lease?: string
) =>
  await person.api.pages
    .frame(app, lease ?? (await previewLease(person, app)))
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

/** The test stores App `app`'s preview named, oldest first. */
export const previewStores = async (app: AppId): Promise<string[]> =>
  await runInDurableObject(
    previewOf(app),
    (_instance, state) => state.storage.kv.get<string[]>("stores") ?? []
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
