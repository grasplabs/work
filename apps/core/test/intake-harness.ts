import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { startAppBinding } from "../src/app-workflow-bindings.ts";
import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import { grantReviewed, ordinaryData } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { calledAs } from "./sealed-apps.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

/**
 * The intake's harness, shared by the intake*.test.ts files: the App
 * created from its blueprint, its members, the fake model provider, and
 * how its drafts, sources and statements are read through its functions.
 */

export const intake = "intake";

/**
 * The model the company chose, which the intake's workflow is approved to
 * read with: one that doesn't think, so its answer cap is the claims' alone.
 */
export const intakeModel = "mistral/mistral-large-latest";

/** The company's provider for `intakeModel`, answering with `replies`. */
export const fakeProvider = async (
  ...replies: ProviderReply[]
): Promise<FakeProvider> => await fakeProviderFor([intakeModel], ...replies);

export type Person = Awaited<ReturnType<typeof signedInApi>>;

/** What `person` gets calling the intake's `path` (a `kind`) with `input`. */
export const call = async (
  person: Person,
  app: AppId,
  path: string,
  kind: "query" | "mutation" | "action",
  input: unknown = {}
): Promise<OperationResult> =>
  await calledAs(await person.api.whoami(), app, { name: path, kind }, input);

/** What a call answered; a refusal fails the test, saying why. */
export const valueOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    throw new Error(
      `Refused: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? null)}`
    );
  }
  return result.value;
};

/** Why a call was refused, or `ok`. */
export const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

export const idSchema = z.string().min(1);

export const draftSchema = z
  .object({
    _id: z.string(),
    origin: z.string(),
    source: z.record(z.string(), z.unknown()),
    statements: z.array(z.record(z.string(), z.unknown())),
  })
  .loose();

export const summarySchema = z.object({
  id: z.string(),
  origin: z.string(),
  title: z.string(),
  date: z.string(),
  statements: z.number(),
  createdAt: z.number(),
});

export const sourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  medium: z.string(),
  date: z.string(),
  from: z.string(),
  guest: z.boolean(),
  createdAt: z.number(),
});

export const savedSourceSchema = z
  .object({
    _id: z.string(),
    title: z.string(),
    medium: z.string(),
    date: z.string(),
    from: z.string(),
    notes: z.string(),
    guest: z.boolean(),
  })
  .loose();

export const statementSchema = z.object({
  text: z.string(),
  tags: z.array(z.string()),
  quote: z.string(),
  source: z.string(),
  date: z.string(),
  guest: z.boolean(),
});

export const savedSchema = z.object({
  source: z.string(),
  statements: z.number(),
});

/** An interview, as someone types it into the review. */
export const interview = (title: string) => ({
  source: {
    title,
    medium: "interview",
    date: "2026-09-21",
    from: "  Anna, controller  ",
    notes: "Talked about month-end close.",
  },
  statements: [
    {
      text: "Closing the month takes three days.",
      tags: ["time_sink"],
      quote: "It's three days, every month.",
    },
    {
      text: "  Invoices wait for a second signature over 5,000.  ",
      tags: ["rule", "blocker", "rule"],
      quote: "",
    },
  ],
});

/** The drafts `person` sees waiting for review. */
export const draftsOf = async (person: Person, app: AppId) =>
  z
    .array(summarySchema)
    .parse(valueOf(await call(person, app, "drafts.list", "query")));

/** A draft as `person` opens it, or null once it's gone. */
export const draftOf = async (person: Person, app: AppId, id: string) =>
  draftSchema
    .nullable()
    .parse(valueOf(await call(person, app, "drafts.get", "query", { id })));

/** The ID of a draft as `person` opens it; undefined once it's gone. */
export const stillThere = async (person: Person, app: AppId, id: string) => {
  const found = await draftOf(person, app, id);
  return found?._id;
};

/** The sources `person` sees saved, newest first. */
export const sourcesOf = async (person: Person, app: AppId) =>
  z
    .array(sourceSchema)
    .parse(valueOf(await call(person, app, "drafts.saved", "query")));

/** A saved source as `person` reads it whole, notes and all. */
export const sourceOf = async (person: Person, app: AppId, id: string) =>
  savedSourceSchema.parse(
    valueOf(await call(person, app, "drafts.source", "query", { id }))
  );

/** A saved source's statements, by their text, as their fields. */
export const statementsOf = async (
  person: Person,
  app: AppId,
  source: string
) =>
  z
    .array(statementSchema.loose())
    .parse(
      valueOf(
        await call(person, app, "drafts.statementsOf", "query", { source })
      )
    )
    .map((statement) => statementSchema.parse(statement))
    .toSorted((one, other) => one.text.localeCompare(other.text));

/** Keeps a draft typed in by `person`, answering its ID. */
export const created = async (
  person: Person,
  app: AppId,
  draft: unknown
): Promise<string> =>
  idSchema.parse(
    valueOf(await call(person, app, "drafts.create", "mutation", draft))
  );

/** The `extract` workflow copy `app` got: the one it asks to start. */
export const workflowOf = async (
  admin: Person,
  app: AppId
): Promise<string> => {
  const asked = await admin.api.permissions.list({ type: "app", appId: app });
  const start = asked.find(({ binding }) => binding === "EXTRACT");
  if (start?.object.type !== "workflow") {
    throw new Error("Expected the copy to ask to start its workflow");
  }
  return start.object.workflowId;
};

/**
 * An App created from the intake by `admin`, its requests granted: to
 * start its `extract` workflow, whose `extractor` an admin approves for
 * the test's model unless `model` is false, and the guest chats
 * permission, which its `guests` is bound to when `guests` is true.
 */
export const copyOf = async (
  admin: Person,
  { model = true, guests = false }: { model?: boolean; guests?: boolean } = {}
): Promise<AppId> => {
  await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
  const made = await admin.api.apps.blueprints.create(intake, {
    name: `Intake ${unique()}`,
  });
  for (const { id } of made.permissions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await grantReviewed(admin.api, id);
  }
  await admin.api.apps.versions.setCurrent(made.app.id, 1);
  await admin.api.apps.publish(made.app.id);
  // The model the workflow reads with, approved by an admin on the
  // workflow's page, for the version the copy got.
  if (model) {
    await admin.api.workflowResources.approveBinding(
      await workflowOf(admin, appIdSchema.parse(made.app.id)),
      {
        alias: "ai",
        target: { kind: "model", model: intakeModel },
        reviewed: { version: 1 },
      }
    );
  }
  const permission = made.permissions.find(
    ({ binding }) => binding === "GUESTS"
  );
  if (guests && permission !== undefined) {
    await admin.api.resourceBindings.approve({
      app: made.app.id,
      alias: "guests",
      target: { kind: "guests", permissionId: permission.id },
      reviewed: { version: 1 },
    });
  }
  await ordinaryData(made.app.id);
  return appIdSchema.parse(made.app.id);
};

/**
 * Someone signed in with `role` at `idp`, sharing `app` with its admin as
 * `as`. Each file makes its own IdP (`mockIdp()`), which registers its
 * hooks: core's test files share their modules.
 */
export const memberIn =
  (idp: Idp) =>
  async (
    admin: Person,
    app: AppId,
    role: "user" | "builder",
    as: "user" | "builder"
  ): Promise<Person> => {
    const person = await signedInApi(idp, role);
    await admin.api.apps.members.add(app, {
      type: "person",
      id: person.userId,
      role: as,
    });
    return person;
  };

/**
 * The company connected an AI provider and chose its model, which the
 * intake's workflow is approved to read with and a stakeholder's chat is
 * invited with; a test that has the model answer connects its own.
 */
export const connected = async (): Promise<void> => {
  await fakeProvider();
};

/** What a run of `extract` ended as, and what its model was asked. */
export interface Reading {
  run: WorkflowResourceRun;
  provider: FakeProvider;
}

/**
 * Starts `extract` for `person` through copy `app`'s binding, as its
 * page starts it, with `input`, while `provider` answers its model,
 * and waits for the
 * run to end, as `admin` (who sees every workflow) reads it.
 */
export const extracted = async (
  admin: Person,
  person: Person,
  app: AppId,
  input: unknown,
  provider: FakeProvider
): Promise<Reading> => {
  const workflow = await workflowOf(admin, app);
  const { runId } = await startAppBinding(
    env,
    {
      subject: { type: "app", appId: app },
      onBehalfOf: person.userId,
      mode: "interactive",
      appVersion: 1,
    },
    "extract",
    { args: input, key: crypto.randomUUID() }
  );
  if (runId === null) {
    throw new Error("Expected the start to start a run");
  }
  await vi.waitFor(
    async () => {
      const run = await admin.api.workflowResources.run(workflow, runId);
      expect(run.endedAt).not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
  return {
    run: await admin.api.workflowResources.run(workflow, runId),
    provider,
  };
};

/** What a finished reading found. */
export const foundSchema = z.object({
  statements: z.array(
    z.object({ text: z.string(), tags: z.array(z.string()), quote: z.string() })
  ),
});

/** An interview's source, as someone describes it before it is read. */
export const interviewSource = (title: string, date = "2026-09-22") => ({
  title,
  medium: "interview",
  date,
  from: "Anna",
});

/** A guest's page's request to core, and core's answer. */
export const guest = async (body: unknown): Promise<unknown> => {
  const response = await routed("/api/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json();
};

/** A chat as `chats.notes` reads it, for the page to have it read. */
export const chatNotesSchema = z.object({
  source: z.object({
    title: z.string(),
    medium: z.string(),
    date: z.string(),
    from: z.string(),
  }),
  notes: z.string(),
  lines: z.array(z.object({ role: z.string(), text: z.string() })),
});
