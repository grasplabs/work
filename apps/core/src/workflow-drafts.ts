import { pointerJoin } from "@grasp-os/open-workflow/diagnostics";
import { workflowDiagram } from "@grasp-os/open-workflow/diagram";
import { profileName } from "@grasp-os/open-workflow/limits";
import { actorOf } from "@grasp-os/shared/audit";
import {
  workflowDraftEditSchema,
  workflowDraftPublishSchema,
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowDefinitionProblem,
  WorkflowDraft,
  WorkflowResourceVersion,
} from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  workflowResourceDraftInspections,
  workflowResourceDraftModules,
  workflowResourceDrafts,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { requireNotStaff } from "./sharing.ts";
import {
  compileModules,
  contractsFromManifest,
  modulesHashOf,
} from "./workflow-modules.ts";
import type { ModuleContracts } from "./workflow-modules.ts";
import {
  definitionProblems,
  firstFreeVersion,
  publishWorkflowVersion,
  requireWorkflowRole,
  sealedModules,
  workflowDefinition,
} from "./workflow-resources.ts";

// The draft of an independent workflow's next definition, as its builders
// and their agent edit it (platform specification 13.10 and 22.7). The
// draft is text and nothing runs it: only a published version runs, and
// only the latest draft that passed the profile, its checkpoint, can be
// published (`publishWorkflowDraft`). The editor's diagram is drawn from
// that checkpoint's JSON, never from anything else.
//
// Threat model, and how each is closed:
//
// - Two editors, or an editor and the agent, at once. Every edit names
//   the revision it read and inserts the next one in one statement that
//   requires that revision to still be the latest; the second of two
//   concurrent edits is refused (`workflow.draft_conflict`) and the first
//   stays, never merged or overwritten.
// - Incomplete or invalid text running. An edit is checked as publication
//   checks a definition (`definitionProblems`: the profile against the
//   host's catalog, and this workflow's identity), and its problems are
//   stored with it. Text that doesn't pass never becomes a checkpoint, and
//   publishing anything but the latest revision, once it passed, is
//   refused (`workflow.draft_unchecked`). Publication checks it again.
// - Disclosure. A definition can hold a sensitive parameter's default, so
//   only the workflow's builders read or edit its draft, as only they read
//   its published definitions. Grasp staff don't edit it.
// - Growth. A draft keeps only its latest revision and its latest
//   checkpoint, each at most the profile's 1 MiB with its problems at
//   most 256 KiB, and an edit is bounded as a definition is.
//
// A revision carries the workflow's own modules too (GRA-706 has the
// threat model in full), so a draft can call them through `local:`
// bindings and publishes them with its definition:
//
// - Module code running as a draft is checked. It is built and inspected
//   by `compileModules`, exactly as a publication does: only in the
//   sandbox, with no env, bindings or network, and what fails is reported
//   as the compiler's bounded diagnostics, never the module's own words.
// - Sealing other code than was checked. A revision's modules are written
//   in the batch that takes its revision, one row each, and never changed;
//   every read takes a revision with its own modules in one batch, so no
//   revision's definition is seen beside another's modules. Publishing
//   sends the latest revision's modules, which publication builds and
//   checks again before it seals them.
// - Contracts kept between edits. What an inspection answered is kept
//   with its revision, keyed by the modules' hash, and an edit that
//   carries exactly those modules checks its definition against it instead
//   of running them again; it is read back through the same checks as
//   when it was answered (`contractsFromManifest`). It only ever decides
//   what a draft reports: publishing builds and inspects the modules anew.
// - Starting from code nobody sealed. Before anyone edits, the modules
//   are the current version's, read back from its seal with every hash
//   checked (`sealedModules`).
// - Disclosure. Only the workflow's builders read them, as they read a
//   version's sources; the audit counts them, never says what they hold.

/**
 * The most a revision's problems take as stored JSON. A D1 row holds 2 MB
 * and its text up to 1 MiB, but a problem's pointer escapes characters of
 * the text as two (`/` as `~1`), so a single problem can outgrow the
 * text: past this, the problems are replaced by one short one.
 */
const maxProblemBytes = 256 * 1024;

/** `problems` as a revision stores them, within `maxProblemBytes`. */
const boundedProblems = (
  problems: WorkflowDefinitionProblem[]
): WorkflowDefinitionProblem[] => {
  const bytes = new TextEncoder().encode(JSON.stringify(problems)).byteLength;
  if (bytes <= maxProblemBytes) {
    return problems;
  }
  return [
    {
      code: "definition.problems_too_large",
      message: `The definition has ${problems.length} problems, too long together to show.`,
      pointer: "/",
      remedy:
        "Look for very long keys or values, shorten them, and check again.",
    },
  ];
};

/**
 * The draft of a workflow nobody has published yet: one that passes, at
 * `version`, one no earlier holder of its name published
 * (`firstFreeVersion`).
 */
const starterDefinition = (name: string, version: string): string =>
  `${JSON.stringify(
    {
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name,
        version,
        title: name,
        metadata: {
          grasp: { profile: profileName, params: {}, bindings: {} },
        },
      },
      input: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      output: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { done: { type: "boolean" } },
            required: ["done"],
            additionalProperties: false,
          },
        },
      },
      do: [{ finish: { set: { done: true } } }],
    },
    null,
    2
  )}\n`;

const problemsSchema = z.array(
  z.object({
    code: z.string(),
    message: z.string(),
    pointer: z.string(),
    taskId: z.string().optional(),
    remedy: z.string(),
  })
);

/** Problems as stored: what the profile said when the edit was saved. */
const storedProblems = (text: string): WorkflowDefinitionProblem[] =>
  problemsSchema.parse(JSON.parse(text));

type DraftRow = typeof workflowResourceDrafts.$inferSelect;

/**
 * A checkpoint as the editor shows it: its revision and text, and its
 * diagram, drawn from that very text, which passed the profile.
 */
const checkpointOf = (
  revision: number,
  source: string
): NonNullable<WorkflowDraft["checkpoint"]> => ({
  revision,
  source,
  diagram: workflowDiagram(z.json().parse(JSON.parse(source))),
});

/** Module rows, by path. */
const modulesOf = (
  rows: readonly { path: string; source: string }[]
): Record<string, string> =>
  Object.fromEntries(rows.map(({ path, source }) => [path, source]));

/**
 * The latest revision of workflow `id`'s draft, with its modules, and its
 * latest checkpoint.
 */
const draftRows = async (
  env: Env,
  id: string
): Promise<{
  latest?: DraftRow;
  modules: Record<string, string>;
  checkpoint?: DraftRow;
}> => {
  const db = drizzle(env.DB);
  // All in one batch, so they describe one saved state: never one
  // revision's text beside a later revision's checkpoint, or another
  // revision's modules.
  const [latestRows, checkpointRows, moduleRows] = await db.batch([
    db
      .select()
      .from(workflowResourceDrafts)
      .where(eq(workflowResourceDrafts.workflowResourceId, id))
      .orderBy(desc(workflowResourceDrafts.revision))
      .limit(1),
    db
      .select()
      .from(workflowResourceDrafts)
      .where(
        and(
          eq(workflowResourceDrafts.workflowResourceId, id),
          eq(workflowResourceDrafts.checked, true)
        )
      )
      .orderBy(desc(workflowResourceDrafts.revision))
      .limit(1),
    db
      .select({
        path: workflowResourceDraftModules.path,
        source: workflowResourceDraftModules.source,
      })
      .from(workflowResourceDraftModules)
      .where(
        and(
          eq(workflowResourceDraftModules.workflowResourceId, id),
          sql`${workflowResourceDraftModules.revision} = (SELECT MAX(revision)
            FROM workflow_resource_drafts WHERE workflow_resource_id = ${id})`
        )
      ),
  ]);
  const [latest] = latestRows;
  const [checkpoint] = checkpointRows;
  return {
    ...(latest === undefined ? {} : { latest }),
    modules: modulesOf(moduleRows),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
};

/**
 * The draft of `workflow` as `workflowDraft` answers it; given `saved`,
 * as that edit left it, whatever was saved after it.
 */
const draftOf = async (
  env: Env,
  by: Acting,
  workflow: Awaited<ReturnType<typeof requireWorkflowRole>>,
  saved?: {
    latest: DraftRow;
    modules: Record<string, string>;
    checkpoint?: DraftRow;
  }
): Promise<WorkflowDraft> => {
  // An edit's own answer is the row it wrote and the checkpoint its batch
  // read, never what was saved after it.
  const { latest, modules, checkpoint } =
    saved ?? (await draftRows(env, workflow.id));
  const published =
    workflow.currentVersion === null
      ? undefined
      : await workflowDefinition(env, by, workflow.id, workflow.currentVersion);
  const publishedCheckpoint =
    published === undefined ? null : checkpointOf(0, published);
  if (latest === undefined) {
    return {
      revision: 0,
      source:
        published ??
        starterDefinition(
          workflow.name,
          await firstFreeVersion(env, workflow.name)
        ),
      modules:
        workflow.currentVersion === null
          ? {}
          : await sealedModules(env, workflow.id, workflow.currentVersion),
      problems: [],
      checkpoint: publishedCheckpoint,
      editedBy: null,
      editedAt: null,
    };
  }
  return {
    revision: latest.revision,
    source: latest.source,
    modules,
    problems: storedProblems(latest.problems),
    checkpoint:
      checkpoint === undefined
        ? publishedCheckpoint
        : checkpointOf(checkpoint.revision, checkpoint.source),
    editedBy: latest.editedBy,
    editedAt: latest.editedAt.toISOString(),
  };
};

/**
 * Workflow `id`'s draft, for `by`, who must build it (`WorkflowDraft`).
 * Before anyone edits it, it is the current version's definition, which
 * passed when it was published, or a starting definition for this
 * workflow.
 */
export const workflowDraft = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowDraft> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  return await draftOf(env, by, workflow);
};

/** What a build of a draft's modules reported, as it refuses them. */
const diagnosticsSchema = z.object({
  diagnostics: z.array(
    z.object({
      file: z.string().nullable(),
      line: z.number().nullable(),
      message: z.string(),
    })
  ),
});

/**
 * The most bytes an inspection's answer takes as a row: past it, it isn't
 * kept, and the next edit with the same modules inspects them again.
 */
const maxManifestBytes = 1024 * 1024;

/** The modules' problems, from the diagnostics of a build that refused them. */
const moduleProblems = (error: unknown): WorkflowDefinitionProblem[] => {
  const details = diagnosticsSchema.safeParse(
    workflowResourceErrors.codeOf(error) === "workflow.modules_invalid" &&
      error instanceof Error &&
      "details" in error
      ? error.details
      : undefined
  );
  if (!details.success) {
    throw error;
  }
  return details.data.diagnostics.map(({ file, line, message }) => ({
    code: "modules.invalid",
    message:
      file === null
        ? message
        : `${file}${line === null ? "" : `:${line}`}: ${message}`,
    pointer: file === null ? "/modules" : pointerJoin("/modules", file),
    remedy: "Fix the module where the build says, then check again.",
  }));
};

/**
 * `modules` checked for a draft, as a publication builds and inspects
 * them: none for none, and the build's diagnostics as problems when they
 * don't build. A build that couldn't finish (slow, or the sandbox
 * unavailable) is thrown, and nothing is saved. When the revision the
 * edit builds on (`previous`) carries exactly these modules, what their
 * inspection answered then is checked again instead: most edits change
 * only the definition. Answers the inspection to keep with this revision.
 */
const checkModules = async (
  env: Env,
  workflowId: string,
  previous: number,
  modules: Record<string, string>
): Promise<{
  contracts?: ModuleContracts;
  problems: WorkflowDefinitionProblem[];
  inspection?: { modulesHash: string; manifest: string };
}> => {
  if (Object.keys(modules).length === 0) {
    return { problems: [] };
  }
  const modulesHash = await modulesHashOf(modules);
  const kept = await drizzle(env.DB)
    .select({ manifest: workflowResourceDraftInspections.manifest })
    .from(workflowResourceDraftInspections)
    .where(
      and(
        eq(workflowResourceDraftInspections.workflowResourceId, workflowId),
        eq(workflowResourceDraftInspections.revision, previous),
        eq(workflowResourceDraftInspections.modulesHash, modulesHash)
      )
    )
    .get();
  try {
    if (kept !== undefined) {
      return {
        contracts: contractsFromManifest(kept.manifest, modules),
        problems: [],
        inspection: { modulesHash, manifest: kept.manifest },
      };
    }
    const compiled = await compileModules(env, modules, workflowId);
    return {
      contracts: compiled,
      problems: [],
      inspection: { modulesHash, manifest: compiled.manifest },
    };
  } catch (error) {
    return { problems: moduleProblems(error) };
  }
};

/**
 * Saves an edit of workflow `id`'s draft for `by`, who must build it and
 * isn't Grasp staff (`workflowDraftEditSchema`): checked against the
 * profile as a publication would be, stored with its problems, and a
 * checkpoint when it has none. Refused as `workflow.draft_conflict` once
 * another edit took the revision it read. Answers the draft as saved.
 */
export const editWorkflowDraft = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowDraft> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { expectedRevision, source, modules } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowDraftEditSchema,
    input
  );
  const built = await checkModules(env, workflow.id, expectedRevision, modules);
  const problems = boundedProblems([
    ...built.problems,
    ...(await definitionProblems(env, by, workflow, source, built.contracts)),
  ]);
  const { inspection } = built;
  const kept =
    inspection !== undefined &&
    new TextEncoder().encode(inspection.manifest).byteLength <=
      maxManifestBytes;
  const checked = problems.length === 0;
  const revision = expectedRevision + 1;
  const editedAt = new Date();
  const db = drizzle(env.DB);
  let checkpoint: DraftRow | undefined;
  try {
    const [, checkpoints] = await auditedBatch(env, db, [
      db.insert(workflowResourceDrafts).values({
        // Only while the workflow is live and the revision read is still
        // the latest: otherwise NULL, which fails the batch.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL
            AND (SELECT COALESCE(MAX(revision), 0) FROM workflow_resource_drafts
              WHERE workflow_resource_id = ${workflow.id}) = ${expectedRevision})`,
        revision,
        source,
        checked,
        problems: JSON.stringify(problems),
        editedBy: by.userId,
        editedAt,
      }),
      // Its checkpoint as of this edit, read with it: this revision if it
      // passed, else the latest before it that did.
      db
        .select()
        .from(workflowResourceDrafts)
        .where(
          and(
            eq(workflowResourceDrafts.workflowResourceId, workflow.id),
            eq(workflowResourceDrafts.checked, true),
            lte(workflowResourceDrafts.revision, revision)
          )
        )
        .orderBy(desc(workflowResourceDrafts.revision))
        .limit(1),
      // Its modules, with the revision they belong to: the batch fails as
      // one when the revision does.
      ...Object.entries(modules).map(([path, text]) =>
        db.insert(workflowResourceDraftModules).values({
          workflowResourceId: workflow.id,
          revision,
          path,
          source: text,
        })
      ),
      // What their inspection answered, for the next edit that keeps them.
      ...(kept
        ? [
            db.insert(workflowResourceDraftInspections).values({
              workflowResourceId: workflow.id,
              revision,
              modulesHash: inspection.modulesHash,
              manifest: inspection.manifest,
            }),
          ]
        : []),
      // Only the latest revision and the latest checkpoint stay.
      db.delete(workflowResourceDrafts).where(
        and(
          eq(workflowResourceDrafts.workflowResourceId, workflow.id),
          sql`${workflowResourceDrafts.revision} < ${revision}`,
          sql`${workflowResourceDrafts.revision} IS NOT (SELECT MAX(revision)
              FROM workflow_resource_drafts
              WHERE workflow_resource_id = ${workflow.id} AND checked = 1)`
        )
      ),
      // And their modules and inspections, with them.
      db.delete(workflowResourceDraftModules).where(
        and(
          eq(workflowResourceDraftModules.workflowResourceId, workflow.id),
          sql`${workflowResourceDraftModules.revision} < ${revision}`,
          sql`${workflowResourceDraftModules.revision} IS NOT (SELECT MAX(revision)
              FROM workflow_resource_drafts
              WHERE workflow_resource_id = ${workflow.id} AND checked = 1)`
        )
      ),
      db.delete(workflowResourceDraftInspections).where(
        and(
          eq(workflowResourceDraftInspections.workflowResourceId, workflow.id),
          sql`${workflowResourceDraftInspections.revision} < ${revision}`,
          sql`${workflowResourceDraftInspections.revision} IS NOT (SELECT MAX(revision)
              FROM workflow_resource_drafts
              WHERE workflow_resource_id = ${workflow.id} AND checked = 1)`
        )
      ),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.draft.edited",
        target: { type: "workflow_resource", id: workflow.id },
        // Whether it passed, never what it says.
        detail: {
          revision,
          checked,
          problems: problems.length,
          modules: Object.keys(modules).length,
        },
      }),
    ]);
    [checkpoint] = checkpoints;
  } catch (error) {
    if (
      notNullFailed(error, "workflow_resource_drafts.workflow_resource_id") ||
      isUniqueViolation(error)
    ) {
      throw workflowResourceErrors.create("workflow.draft_conflict");
    }
    throw error;
  }
  return await draftOf(env, by, workflow, {
    latest: {
      workflowResourceId: workflow.id,
      revision,
      source,
      checked,
      problems: JSON.stringify(problems),
      editedBy: by.userId,
      editedAt,
    },
    modules,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  });
};

/**
 * Publishes workflow `id`'s draft for `by` (`workflowDraftPublishSchema`):
 * the revision they name, which must be the latest when they ask and have
 * passed, else `workflow.draft_unchecked`; then exactly as
 * `publishWorkflowVersion` publishes its text, on the current version it
 * names, which checks it again. What is published is the text of that
 * revision, the one the person saw: an edit someone saves meanwhile stays
 * the draft's next revision, neither published nor lost, and publishing
 * it is a publication of its own.
 */
export const publishWorkflowDraft = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResourceVersion> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { revision, basedOn } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowDraftPublishSchema,
    input
  );
  const { latest, modules } = await draftRows(env, workflow.id);
  // A revision another edit has replaced conflicts, as an edit of it
  // would; the latest one publishes only once it passed.
  const stale = latest !== undefined && latest.revision !== revision;
  if (stale) {
    throw workflowResourceErrors.create("workflow.draft_conflict");
  }
  if (latest === undefined || !latest.checked) {
    throw workflowResourceErrors.create("workflow.draft_unchecked");
  }
  // With its modules, which publication builds and checks again.
  return await publishWorkflowVersion(env, by, workflow.id, {
    definition: latest.source,
    basedOn,
    ...(Object.keys(modules).length === 0 ? {} : { modules }),
  });
};
