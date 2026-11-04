import { generatedPaths } from "@grasp-os/sdk/host";
import type { WorkflowPin } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import {
  definitionPackageFormatVersion,
  definitionPackageMaxBytes,
  definitionPackageMaxWorkflows,
  definitionPackageSchema,
} from "@grasp-os/shared/definition-packages";
import type {
  DefinitionPackage,
  UnresolvedReason,
} from "@grasp-os/shared/definition-packages";
import { canonicalText } from "@grasp-os/shared/json";
import { holdsKnownCredential } from "@grasp-os/shared/redact";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import { appFor, versionFiles, versionTree } from "./apps.ts";
import { appendAuditEvent } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { requireNotStaff } from "./sharing.ts";
import { exportedWorkflowVersion } from "./workflow-resources.ts";
import type { ExportedBinding } from "./workflow-resources.ts";

// Exporting an App's definition (GRA-363): its current sealed release and
// the exact workflow versions it binds, as a package of portable source
// (`@grasp-os/shared/definition-packages`) another deployment builds and
// activates again. Threat model, and how each is closed:
//
// - Secrets travel with it. No platform-held secret can: the package is
//   built field by field from what its schema allows, and parsed against
//   that strict schema before it leaves, so nothing unlisted can, and
//   nothing that holds one is read: no connection, permission or approval
//   (a binding is its alias and kind), no parameter value, no record,
//   member, guest, run, decision or audit row. A workflow travels as the
//   TypeScript generated from it and its own modules, never its
//   definition, and a sensitive parameter has no value in either: the
//   format keeps none in the document. The sealed generated files, which name this
//   deployment's resources, are only their hashes. What builders wrote
//   into source is scanned for known secret formats, and the export is
//   refused, naming the file, if one turns up: a scan, not a guarantee.
//   The App's registration as sealed (`app.manifest`) and what its
//   references type of each packaged workflow (`app.workflowContracts`:
//   events, listens and decisions, never a pin, and none for a workflow
//   the package doesn't carry) are no files, but are counted and scanned
//   as files are.
// - A workflow version's approved packages are lost, so its modules'
//   bare imports resolve nowhere, or travel as if approved: the version
//   carries what it seals (`packages`), the graph's hash, the entries its
//   modules import and the graph's lock, every exact version and
//   integrity, without this deployment's build pins, its approval or its
//   artifact. Nothing at the destination trusts it: a publication there
//   seals only a graph approved for its own workflow, asked for and
//   approved anew from the lock's exact versions. The record counts
//   against the byte budget and is scanned like every file.
// - Someone exports what they can't read: only the App's builders (its
//   admins among them), never Grasp staff; and only workflows they build,
//   as for a workflow's source. A workflow they don't is listed as
//   unresolved under the alias that names it, never by its name.
// - An export goes unrecorded: it is in the audit log before anything is
//   answered, or it fails.
// - What is exported isn't what was sealed: every part is read back with
//   the checks a run makes (the release's, its source tree's against the
//   manifest, each generated file's, each workflow version's and build's),
//   and refused otherwise.
// - The graph of workflows never ends, or repeats, or the package grows
//   past what one answer holds: each version is packaged once under its
//   key and named by it everywhere else, so a version reached again is
//   only named; at most `definitionPackageMaxWorkflows` are read, and at
//   most `definitionPackageMaxBytes` of text packaged.
// - A package looks complete when it isn't: every binding it can't
//   resolve is listed (`unresolved`), so activation blocks on it.

type PackagedWorkflow = DefinitionPackage["workflows"][string];

/** What following one pin came to: the version's key, or why it has none. */
type Followed =
  | { readonly key: string }
  | { readonly reason: UnresolvedReason };

/** How many bytes of text an export packages at most (`env` may lower it). */
const maxBytesOf = (env: Env): number => {
  const set = Number(env.DEFINITION_EXPORT_MAX_BYTES);
  return Number.isInteger(set) && set > 0 && set < definitionPackageMaxBytes
    ? set
    : definitionPackageMaxBytes;
};

const encoder = new TextEncoder();

/**
 * Counts the text files an export packages against its byte budget, and
 * scans each for known secret formats, as it is added: past `max` bytes,
 * `version.export_too_large`; a file holding a known credential format,
 * `version.export_secret_found` naming the file (under `prefix`, if any), never
 * what matched. Answers the files added.
 */
type TextBudget = (
  prefix: string | null,
  files: Readonly<Record<string, string>>
) => Readonly<Record<string, string>>;

const textBudget = (max: number): TextBudget => {
  let bytes = 0;
  return (prefix, files) => {
    for (const [path, text] of Object.entries(files)) {
      bytes +=
        encoder.encode(path).byteLength + encoder.encode(text).byteLength;
      if (bytes > max) {
        throw versionErrors.create("version.export_too_large");
      }
      if (holdsKnownCredential(text)) {
        throw versionErrors.create("version.export_secret_found", {
          path: prefix === null ? path : `${prefix}/${path}`,
        });
      }
    }
    return files;
  };
};

/** A version found and keyed, its bindings still to follow. */
interface Pending {
  readonly key: string;
  readonly entry: Omit<PackagedWorkflow, "workflows" | "bindings">;
  readonly bindings: readonly ExportedBinding[];
}

/**
 * The workflow versions reached from the App's pins, each read once by
 * `by` and keyed, and every binding that doesn't resolve.
 */
class WorkflowGraph {
  readonly packaged: Record<string, PackagedWorkflow> = {};
  readonly unresolved: DefinitionPackage["unresolved"] = [];
  readonly #env: Env;
  readonly #by: Acting;
  readonly #budget: TextBudget;
  /** What each pin read came to, by `<workflow id>@<version>`. */
  readonly #followed = new Map<string, Followed>();
  readonly #pending: Pending[] = [];

  constructor(env: Env, by: Acting, budget: TextBudget) {
    this.#env = env;
    this.#by = by;
    this.#budget = budget;
  }

  /**
   * The key of the version `pin` names, read the first time it is named
   * and only named after; null, with an unresolved entry for `alias` at
   * `at`, for one that can't be packaged.
   */
  async follow(
    at: string,
    alias: string,
    pin: WorkflowPin
  ): Promise<string | null> {
    const id = `${pin.workflowId}@${pin.version}`;
    let followed = this.#followed.get(id);
    if (followed === undefined) {
      if (this.#followed.size >= definitionPackageMaxWorkflows) {
        throw versionErrors.create("version.export_too_large");
      }
      followed = await this.#read(pin);
      this.#followed.set(id, followed);
    }
    if ("reason" in followed) {
      this.unresolved.push({ at, alias, reason: followed.reason });
      return null;
    }
    return followed.key;
  }

  /** Packages every version found, following its own pins, until none is left. */
  async finish(): Promise<void> {
    for (
      let next = this.#pending.shift();
      next !== undefined;
      next = this.#pending.shift()
    ) {
      const workflows: PackagedWorkflow["workflows"] = {};
      const bindings: PackagedWorkflow["bindings"] = {};
      for (const binding of next.bindings) {
        if (binding.kind === "workflow") {
          // One after the other: each pin is read once, the first time.
          // oxlint-disable-next-line no-await-in-loop -- see above
          workflows[binding.alias] = await this.follow(
            next.key,
            binding.alias,
            {
              workflowId: binding.workflowId,
              version: binding.version,
            }
          );
        } else {
          bindings[binding.alias] = binding.kind;
        }
      }
      this.packaged[next.key] = { ...next.entry, workflows, bindings };
    }
  }

  async #read(pin: WorkflowPin): Promise<Followed> {
    const found = await exportedWorkflowVersion(
      this.#env,
      this.#by,
      pin.workflowId,
      pin.version
    );
    if (found.status !== "found") {
      return { reason: found.status };
    }
    const key = `${workflowNamespace}/${found.name}/${found.definitionVersion}`;
    const files = this.#budget(`workflows/${key}`, found.files);
    // Named as the package names it: it is no file of the version's.
    if (found.packages !== null) {
      this.#budget(`workflows/${key}`, {
        packages: canonicalText(found.packages),
      });
    }
    this.#pending.push({
      key,
      entry: {
        provenance: {
          manifestHash: found.manifestHash,
          definitionHash: found.definitionHash,
          buildHash: found.buildHash,
          profile: found.profile,
        },
        files,
        packages:
          found.packages === null
            ? null
            : {
                graphHash: found.packages.graphHash,
                entries: [...found.packages.entries],
                lock: found.packages.lock,
              },
      },
      bindings: found.bindings,
    });
    return { key };
  }
}

/** The paths of the code a seal generates, as its artifacts name them. */
const generatedNames: ReadonlySet<string> = new Set(
  Object.values(generatedPaths)
);

/**
 * The definition package of the App `input` names, for `by`, who must
 * build it and isn't Grasp staff: its current version's sealed release,
 * every artifact checked, and the workflow versions it binds as its seal
 * pinned them, those `by` builds. Audited before it is answered.
 */
export const exportAppDefinition = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<DefinitionPackage> => {
  requireNotStaff(by);
  const app = await appFor(env, by, input, "builder");
  const version = app.currentVersion;
  if (version === null) {
    throw appErrors.create("app.version_not_found");
  }
  const release = await loadRelease(env, app.id, version);
  const { manifest } = release;
  const files = await versionFiles(env, app.id, version);
  const { tree } = await versionTree(new Map(Object.entries(files)));
  if (tree !== manifest.sourceTreeHash) {
    throw versionErrors.create("version.artifact_corrupt", { path: "source" });
  }
  const budget = textBudget(maxBytesOf(env));
  budget("app", files);
  const registration = canonicalText(release.app);
  // Named as the package names it: it is no file of the App's.
  budget(null, { "app.manifest": registration });
  // Only their hashes: they name this deployment's resources, the
  // workflows' it may not read among them, and the destination generates
  // its own.
  const generated: DefinitionPackage["app"]["provenance"]["generated"] = {};
  for (const entry of manifest.artifacts) {
    if (generatedNames.has(entry.path)) {
      generated[entry.path] = entry.sha256;
    }
  }
  const bindings: DefinitionPackage["app"]["bindings"] = {};
  for (const resource of [
    ...Object.values(release.app.resources),
    ...Object.values(release.app.browserResources),
  ]) {
    bindings[resource.alias] = resource["~resource"];
  }
  const graph = new WorkflowGraph(env, by, budget);
  const workflows: DefinitionPackage["app"]["workflows"] = {};
  for (const alias of Object.keys(release.app.workflows).toSorted()) {
    const pinned = release.workflows.find(
      (workflow) => workflow.alias === alias
    )?.pinned;
    if (pinned === undefined) {
      graph.unresolved.push({ at: "app", alias, reason: "unbound" });
      workflows[alias] = null;
    } else {
      // oxlint-disable-next-line no-await-in-loop -- each pin read once, in order
      workflows[alias] = await graph.follow("app", alias, pinned);
    }
  }
  await graph.finish();
  // What the App's references type of each packaged workflow, as sealed;
  // never its pin, nor anything of one the package doesn't carry.
  const workflowContracts: DefinitionPackage["app"]["workflowContracts"] = {};
  for (const sealed of release.workflows) {
    if (typeof workflows[sealed.alias] === "string") {
      workflowContracts[sealed.alias] = {
        events: Object.fromEntries(
          Object.entries(sealed.events).map(([name, event]) => [
            name,
            { type: event.type, data: z.json().parse(event.data) },
          ])
        ),
        listens: Object.fromEntries(
          Object.entries(sealed.listens).map(([task, events]) => [
            task,
            [...events],
          ])
        ),
        decisions: Object.fromEntries(
          Object.entries(sealed.decisions).map(([name, decision]) => [
            name,
            {
              value: z.json().parse(decision.value),
              context: z.json().parse(decision.context),
            },
          ])
        ),
      };
    }
  }
  // Counted and scanned like every file: their descriptors come from
  // catalog contracts, which the files above don't hold.
  budget(null, { "app.workflowContracts": canonicalText(workflowContracts) });
  const { store } = release;
  const definitionPackage = definitionPackageSchema.parse({
    formatVersion: definitionPackageFormatVersion,
    app: {
      version,
      provenance: {
        manifestHash: release.manifestHash,
        sourceTreeHash: manifest.sourceTreeHash,
        contractHash: manifest.contractHash,
        schemaHash: manifest.schemaHash,
        dependencyLockHash: manifest.dependencyLockHash,
        sdkVersion: manifest.sdkVersion,
        sdkProtocolVersion: manifest.sdkProtocolVersion,
        uiVersion: manifest.uiVersion,
        compilerVersion: manifest.compilerVersion,
        generated,
      },
      files,
      manifest: registration,
      store:
        store === null
          ? null
          : {
              alias: store.alias,
              schemaVersion: store.schemaVersion,
              schemaHash: store.schemaHash,
              operationManifestHash: store.operationManifestHash,
            },
      bindings,
      workflows,
      workflowContracts,
    },
    workflows: graph.packaged,
    unresolved: graph.unresolved,
  } satisfies DefinitionPackage);
  await appendAuditEvent(env, {
    actor: actorOf(by),
    action: "app.definition.exported",
    target: { type: "app", id: app.id },
    detail: {
      version,
      workflows: Object.keys(graph.packaged).length,
      unresolved: graph.unresolved.length,
    },
  });
  return definitionPackage;
};
