import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowDraft,
} from "@grasp-os/shared/workflow-resources";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { buildingAs, buildsApps, maxCreatesPerTurn } from "./agent-builds.ts";
import { asPerson } from "./agent-person.ts";
import { admitEffect } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { bindWorkflowToApp } from "./app-workflow-bindings.ts";
import { appFor } from "./apps.ts";
import type { Acting } from "./auth/identity.ts";
import { workspace } from "./durable-objects.ts";
import { requireResourceRole } from "./permission-resources.ts";
import { requestPermission } from "./permissions.ts";
import {
  editWorkflowDraft,
  publishWorkflowDraft,
  workflowDraft,
} from "./workflow-drafts.ts";
import { createWorkflowResource } from "./workflow-resources.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "./workflows/candidate-runs.ts";

// Building independent workflows from a chat: `await
// env.workflowBuild.edit(workflow, { ... })`. The chat's agent creates a
// JSON workflow for its person, edits its draft, test-runs the draft's
// checkpoint, publishes it as the workflow's next version, binds that
// version to an App by an alias, and asks for the permissions it needs:
// each step exactly the function a person's session calls
// (workflow-resources-rpc.ts), as the chat's person, read again on every
// call. Nothing here grants, approves or starts anything.
//
// Threat model (failure modes and attacks first), and how each is closed:
//
// - The agent building without being let to. Every call needs the agent's
//   own permission to build (`write` on the Apps collection, as
//   `env.build`: building Apps and the workflows they bind is one
//   capability), read again on each call, and is refused once the code
//   run that made it ended or one of the agent's permissions was revoked
//   since it opened (`asPerson`, `admitEffect` right before each write).
// - The agent doing more than its person may. Each call is the person's
//   own function, with the person's role read now: only a builder creates
//   a workflow; only the workflow's builders read or edit its draft, test
//   or publish it; only someone who builds the App and has a role in the
//   workflow binds it; only its builders ask for its permissions. A
//   workflow the person has no role in is "unavailable", as one that
//   doesn't exist. Grasp staff never act through a chat.
// - The agent granting itself, or anything, authority. No call here
//   grants, approves or starts: a published version runs nothing until
//   something with a grant starts it; each catalog binding it declares
//   (a connector, store operation, model or decision) waits for an
//   admin's approval of that exact version (workflow-bindings.ts); an App
//   starts it only through its own `start` permission, which an admin
//   grants; and a request asks for a permission for the workflow it
//   names, never for the agent (`subject` is set here, whatever the code
//   passes).
// - Code nobody reviewed going live. An App's screens start only the
//   version their sealed release pinned, so a new binding reaches them
//   only through an App version a builder makes current. An App's server
//   code starts what the alias binds as it starts (app-workflow-bindings.ts),
//   so rebinding an alias whose App already holds `start` moves those
//   starts to the new version at once, as it does when the person rebinds
//   it themselves; anything that version calls outside itself still waits
//   for an admin's approval of that version. Allowed and audited, as for
//   the person: the audit log names the agent acting for them.
// - A test run with an effect, or reading a secret. A test run calls
//   nothing (each call answered from the fixtures the code gives) and runs
//   with the start's parameters or the defaults, never the values set on
//   the workflow (workflows/candidate-runs.ts).
// - Restricted data leaking into what others read. A chat that read
//   restricted data writes no workflow, as it writes no App code
//   (`buildingAs`): a definition, its modules and a test run's input are
//   read by every builder of the workflow.
// - A turn that runs away. A turn creates at most `maxCreatesPerTurn`
//   Apps and workflows together, as a workflow can't be deleted free (each
//   counts against its person's quota for good). Test runs have their own
//   limits per person; the rest is bounded by the calls a code run may
//   make and the runs a turn may make (code-mode.ts).
// - Two editors at once. An edit names the revision it read and is
//   refused if anyone, the person in Grasp included, saved since
//   (`workflow.draft_conflict`): nobody's edit is overwritten.
// - Its record. Every call is audited as `agent.call`, and what it changes
//   (`workflow.resource.created`, a draft saved, a version published, an
//   App binding, a permission requested) as the agent acting for the
//   person (`buildingAs` sets the actor).

/** A draft, as the agent reads it: without the editor's diagram. */
export interface AgentWorkflowDraft {
  revision: number;
  source: string;
  modules: Record<string, string>;
  problems: WorkflowDraft["problems"];
  /** The latest revision that passed: what may be test-run and published. */
  checkpoint: { revision: number } | null;
}

const agentDraft = (draft: WorkflowDraft): AgentWorkflowDraft => ({
  revision: draft.revision,
  source: draft.source,
  modules: draft.modules,
  problems: draft.problems,
  checkpoint:
    draft.checkpoint === null ? null : { revision: draft.checkpoint.revision },
});

/** A published version, as the agent reads it. */
export interface AgentWorkflowVersion {
  version: number;
  definitionVersion: string;
  /** Whether a run can execute it (`build.executable`). */
  executable: boolean;
  /** Each binding it declares; a catalog binding waits for an admin's approval. */
  bindings: { alias: string; kind: string; contractId: string | null }[];
}

/** A test run, as the agent reads it. */
export type AgentTestRun = Pick<
  WorkflowCandidateRun,
  | "id"
  | "draftRevision"
  | "status"
  | "createdAt"
  | "endedAt"
  | "output"
  | "error"
>;

/** The ID a call named, for the audit log. */
const named = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Building independent workflows, as a chat's code does it. */
export class WorkflowBuildApi extends WorkerEntrypoint<Env, AgentScope> {
  /**
   * Runs one call as the chat's person, with the agent as the audit log's
   * actor for what it changes: once the agent may build, and only from a
   * chat that hasn't read restricted data.
   */
  async #build<T>(
    method: string,
    run: (by: Acting) => Promise<T>,
    detail?: (result: T) => Record<string, AuditDetailValue>
  ): Promise<T> {
    const { env } = this;
    const scope = this.ctx.props;
    return await asPerson(env, scope, {
      allowed: buildsApps,
      action: "write",
      method: `workflowBuild.${method}`,
      read: async (person) => await run(await buildingAs(env, scope, person)),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** Admits this run's write, right before it commits. */
  async #admit(): Promise<void> {
    await admitEffect(this.env, this.ctx.props);
  }

  /**
   * A new workflow owned by the person, named `name`: at most
   * {@link maxCreatesPerTurn} Apps and workflows a turn, given back when
   * it creates nothing.
   */
  async create(name: unknown): Promise<{ id: string; name: string }> {
    return await this.#build(
      "create",
      async (by) => {
        const { workspaceId, chatId, runId } = this.ctx.props;
        const chats = workspace(this.env, workspaceId);
        await this.#admit();
        if (!(await chats.takeCreate(chatId, maxCreatesPerTurn, runId))) {
          throw workflowResourceErrors.create("workflow.creates_exhausted");
        }
        try {
          const created = await createWorkflowResource(this.env, by, name);
          return { id: created.id, name: created.name };
        } catch (error) {
          await chats.releaseCreate(chatId);
          throw error;
        }
      },
      (created) => ({ workflow: created.id })
    );
  }

  /** The workflow's draft: its latest text, modules and problems. */
  async draft(workflow: unknown): Promise<AgentWorkflowDraft> {
    return await this.#build(
      "draft",
      async (by) => agentDraft(await workflowDraft(this.env, by, workflow)),
      (draft) => ({ workflow: named(workflow), revision: draft.revision })
    );
  }

  /**
   * Saves an edit of the draft over `expectedRevision`, checked against
   * the profile: the draft as saved, with what it found.
   */
  async edit(workflow: unknown, edit: unknown): Promise<AgentWorkflowDraft> {
    return await this.#build(
      "edit",
      async (by) => {
        await this.#admit();
        return agentDraft(
          await editWorkflowDraft(this.env, by, workflow, edit)
        );
      },
      (draft) => ({
        workflow: named(workflow),
        revision: draft.revision,
        problems: draft.problems.length,
      })
    );
  }

  /**
   * Starts a test run of the draft's checkpoint at an exact revision, its
   * calls answered from `start.fixtures`: never published, calling
   * nothing.
   */
  async startTest(
    workflow: unknown,
    start: unknown
  ): Promise<{ runId: string }> {
    return await this.#build(
      "startTest",
      async (by) => {
        await this.#admit();
        return await startCandidateRun(this.env, by, workflow, start);
      },
      ({ runId }) => ({ workflow: named(workflow), run: runId })
    );
  }

  /** One test run of the workflow, as it is now. */
  async testRun(workflow: unknown, run: unknown): Promise<AgentTestRun> {
    return await this.#build(
      "testRun",
      async (by) => {
        const found = await candidateRunFor(this.env, by, workflow, run);
        return {
          id: found.id,
          draftRevision: found.draftRevision,
          status: found.status,
          createdAt: found.createdAt,
          endedAt: found.endedAt,
          ...(found.output === undefined ? {} : { output: found.output }),
          ...(found.error === undefined ? {} : { error: found.error }),
        };
      },
      (found) => ({ workflow: named(workflow), run: found.id })
    );
  }

  /**
   * Publishes the draft's checkpoint at `publication.revision` as the
   * workflow's next version, over `publication.basedOn`.
   */
  async publish(
    workflow: unknown,
    publication: unknown
  ): Promise<AgentWorkflowVersion> {
    return await this.#build(
      "publish",
      async (by) => {
        await this.#admit();
        const published = await publishWorkflowDraft(
          this.env,
          by,
          workflow,
          publication
        );
        return {
          version: published.version,
          definitionVersion: published.definitionVersion,
          executable: published.build.executable,
          bindings: published.bindings.map(({ alias, kind, contractId }) => ({
            alias,
            kind,
            contractId,
          })),
        };
      },
      (published) => ({
        workflow: named(workflow),
        version: published.version,
      })
    );
  }

  /**
   * Binds version `binding.version` of the workflow to App `binding.app`
   * under `binding.alias`, replacing the alias's binding.
   */
  async bind(
    workflow: unknown,
    binding: unknown
  ): Promise<{ id: string; app: string; alias: string; version: number }> {
    return await this.#build(
      "bind",
      async (by) => {
        await this.#admit();
        const bound = await bindWorkflowToApp(this.env, by, workflow, binding);
        return {
          id: bound.id,
          app: bound.app,
          alias: bound.alias,
          version: bound.version,
        };
      },
      (bound) => ({
        workflow: named(workflow),
        app: bound.app,
        binding: bound.id,
        version: bound.version,
      })
    );
  }

  /**
   * Asks for a permission for the workflow itself (a connection or a
   * store its bindings are served by), as its builders do: it allows
   * nothing until an admin grants it.
   */
  async requestPermission(
    workflow: unknown,
    request: unknown
  ): Promise<{ id: string; status: string }> {
    return await this.#build(
      "requestPermission",
      async (by) => {
        const parsed = workflowResourceIdSchema.safeParse(workflow);
        if (!parsed.success) {
          throw workflowResourceErrors.create("workflow.resource_unavailable");
        }
        // The workflow alone is the subject: never the agent, whatever
        // the code passed.
        const subject = { type: "workflow", workflowId: parsed.data };
        const requested = await requestPermission(
          this.env,
          by,
          typeof request === "object" && request !== null
            ? { ...request, subject }
            : request,
          {
            app: async (app, role) => await appFor(this.env, by, app, role),
            resource: async (ref, needed) => {
              await requireResourceRole(this.env, by, ref, needed);
            },
          },
          async () => {
            await this.#admit();
          }
        );
        return { id: requested.id, status: requested.status };
      },
      (requested) => ({
        workflow: named(workflow),
        permission: requested.id,
      })
    );
  }
}

/** What the model reads of `env.workflowBuild`. */
const workflowBuildDeclaration = `/**
 * Building independent workflows for the person: anything that runs on its
 * own (on a schedule, on an event, for a long time) is a JSON workflow of
 * its own, which an App starts by an alias it binds. Create one, edit its
 * draft (a workflow.json in the grasp-open-workflow/1 profile, and its own
 * modules) until it has no problems, test-run its checkpoint with an
 * answer for every call, publish it, and bind the version to the App. The
 * App declares it in app.ts (\`resource.workflow("alias", { input, output })\`),
 * and its tests start it with \`workflowTest\`. Nothing here grants or
 * approves anything: each call the workflow makes outside itself waits for
 * an admin to approve its binding for that exact version, and the App
 * starts it only once an admin grants the App \`start\` on it (ask with
 * \`env.build.requestPermission\`, \`{ type: "workflow", workflowId }\`). Say so.
 */
workflowBuild: {
  /** Creates a workflow owned by the person; counts with \`env.build.create\`: at most ${maxCreatesPerTurn} a question. */
  create(name: string): Promise<{ id: string; name: string }>;
  /**
   * The draft: its latest text, modules and problems, and its checkpoint,
   * the latest revision that passed (null before any did). Revision 0 is
   * a starting definition nobody saved yet.
   */
  draft(workflow: string): Promise<{
    revision: number;
    source: string;
    modules: Record<string, string>;
    problems: { code: string; message: string; pointer: string; taskId?: string; remedy: string }[];
    checkpoint: { revision: number } | null;
  }>;
  /**
   * Saves the draft over \`expectedRevision\` (the revision you read), with
   * all its modules by path (\`{}\` for none). Refused if anyone saved since:
   * read it again. Fix the problems it answers with and save again.
   */
  edit(workflow: string, edit: { expectedRevision: number; source: string; modules: Record<string, string> }): Promise<{
    revision: number;
    source: string;
    modules: Record<string, string>;
    problems: { code: string; message: string; pointer: string; taskId?: string; remedy: string }[];
    checkpoint: { revision: number } | null;
  }>;
  /**
   * Starts a test run of the checkpoint at \`revision\`: it calls nothing,
   * each binding's call is answered by \`fixtures[alias].output\`, and a
   * call with no answer fails it. Parameters are \`params\`, else their
   * defaults. Follow it with \`testRun\`.
   */
  startTest(workflow: string, start: {
    revision: number;
    input: unknown;
    params?: Record<string, unknown>;
    fixtures: Record<string, { output: unknown }>;
  }): Promise<{ runId: string }>;
  /** A test run as it is now: what it returned once completed, or why it failed. */
  testRun(workflow: string, run: string): Promise<{
    id: string;
    draftRevision: number;
    status: "starting" | "running" | "completed" | "failed" | "cancelled";
    createdAt: string;
    endedAt: string | null;
    output?: unknown;
    error?: { code: string | null; message: string };
  }>;
  /**
   * Publishes the checkpoint at \`revision\` as the next version, over the
   * version it built on (\`basedOn\`: the current one, null before the
   * first). A version never changes; each catalog binding it declares
   * waits for an admin's approval of it.
   */
  publish(workflow: string, publication: { revision: number; basedOn: number | null }): Promise<{
    version: number;
    definitionVersion: string;
    executable: boolean;
    bindings: { alias: string; kind: string; contractId: string | null }[];
  }>;
  /**
   * Binds an exact published version to an App the person builds, under
   * the alias its app.ts declares; replaces that alias's binding.
   */
  bind(workflow: string, binding: { app: string; alias: string; version: number }): Promise<{
    id: string;
    app: string;
    alias: string;
    version: number;
  }>;
  /**
   * Asks for a permission for the workflow itself: a connection or a store
   * an admin can then approve its bindings with, a collection it reads, or
   * \`start\` on a child workflow it binds. It allows nothing until an admin
   * grants it.
   */
  requestPermission(workflow: string, request: {
    object:
      | { type: "connection"; connectionId: string; resource?: string }
      | { type: "store"; storeId: string }
      | { type: "collection"; collectionId: string }
      | { type: "workflow"; workflowId: string };
    actions: string[];
    binding: string;
  }): Promise<{ id: string; status: string }>;
};`;

/** `env.workflowBuild`. */
export const workflowBuildApi: AgentApi = {
  name: "workflowBuild",
  declaration: workflowBuildDeclaration,
  stub: (scope) => exports.WorkflowBuildApi({ props: scope }),
};
