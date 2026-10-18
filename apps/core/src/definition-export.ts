import { generatedPaths } from "@grasp-os/sdk/host";
import type { WorkflowPin } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import {
  definitionPackageFormatVersion,
  definitionPackageMaxWorkflows,
  definitionPackageSchema,
} from "@grasp-os/shared/definition-packages";
import type {
  DefinitionPackage,
  UnresolvedReason,
} from "@grasp-os/shared/definition-packages";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";

import { loadRelease, releaseArtifactText } from "./app-releases.ts";
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
// - Secrets travel with it: the package is built field by field from what
//   its schema allows, and parsed against that strict schema before it
//   leaves, so nothing unlisted can. Nothing that holds a secret is read:
//   no connection, permission or approval (a binding is its alias and
//   kind), no parameter value, no record, member, guest, run, decision or
//   audit row. A workflow's sensitive parameters' defaults, which its
//   definition holds, are withheld (`withheldDefaults`); one whose schema
//   pins a value (`const`, `enum`) isn't packaged at all.
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
// - The graph of workflows never ends, or repeats: each version is
//   packaged once under its key and named by it everywhere else, so a
//   version reached again is only named; at most
//   `definitionPackageMaxWorkflows` are read.
// - A package looks complete when it isn't: every binding it can't
//   resolve is listed (`unresolved`), so activation blocks on it.

/** A JSON object, as parsed. */
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every node of the data schema `node`, itself first, as the profile reads
 * them (open-workflow's data-schema.ts): properties, items, anyOf members
 * and additional properties.
 */
const schemaNodes = (node: unknown, into: JsonObject[] = []): JsonObject[] => {
  if (!isObject(node)) {
    return into;
  }
  into.push(node);
  if (isObject(node.properties)) {
    for (const child of Object.values(node.properties)) {
      schemaNodes(child, into);
    }
  }
  schemaNodes(node.items, into);
  if (Array.isArray(node.anyOf)) {
    for (const member of node.anyOf) {
      schemaNodes(member, into);
    }
  }
  schemaNodes(node.additionalProperties, into);
  return into;
};

/** A definition with its sensitive defaults withheld, and whose they were. */
interface Withheld {
  readonly text: string;
  readonly withheld: string[];
}

/**
 * `definition` without a default for any parameter that is sensitive,
 * every one that doesn't say `sensitive: false`, as the profile treats
 * them: the parameter's own default and any in its schema go, and a
 * parameter that had its own is required instead. `sensitive_constraint`
 * for a sensitive parameter whose schema pins a value (`const`, `enum`),
 * which no package carries. Untouched, as published, when nothing is
 * withheld.
 */
const withholdDefaults = (
  definition: string
): Withheld | "sensitive_constraint" => {
  const parsed: unknown = JSON.parse(definition);
  const grasp =
    isObject(parsed) &&
    isObject(parsed.document) &&
    isObject(parsed.document.metadata) &&
    isObject(parsed.document.metadata.grasp)
      ? parsed.document.metadata.grasp
      : undefined;
  const params = isObject(grasp?.params) ? grasp.params : {};
  const withheld: string[] = [];
  for (const [name, param] of Object.entries(params)) {
    if (!isObject(param) || param.sensitive === false) {
      continue;
    }
    const nodes = schemaNodes(param.schema);
    if (
      nodes.some(
        (node) => Object.hasOwn(node, "const") || Object.hasOwn(node, "enum")
      )
    ) {
      return "sensitive_constraint";
    }
    const ownDefault = Object.hasOwn(param, "default");
    const withDefault = nodes.filter((node) => Object.hasOwn(node, "default"));
    if (ownDefault || withDefault.length > 0) {
      if (ownDefault) {
        Reflect.deleteProperty(param, "default");
        param.required = true;
      }
      for (const node of withDefault) {
        Reflect.deleteProperty(node, "default");
      }
      withheld.push(name);
    }
  }
  return withheld.length === 0
    ? { text: definition, withheld }
    : { text: JSON.stringify(parsed, null, 2), withheld };
};

type PackagedWorkflow = DefinitionPackage["workflows"][string];

/** What following one pin came to: the version's key, or why it has none. */
type Followed =
  | { readonly key: string }
  | { readonly reason: UnresolvedReason };

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
  /** What each pin read came to, by `<workflow id>@<version>`. */
  readonly #followed = new Map<string, Followed>();
  readonly #pending: Pending[] = [];

  constructor(env: Env, by: Acting) {
    this.#env = env;
    this.#by = by;
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
    const definition = withholdDefaults(found.definition);
    if (definition === "sensitive_constraint") {
      return { reason: definition };
    }
    const key = `${workflowNamespace}/${found.name}/${found.definitionVersion}`;
    this.#pending.push({
      key,
      entry: {
        provenance: {
          manifestHash: found.manifestHash,
          definitionHash: found.definitionHash,
          evaluatorHash: found.evaluatorHash,
          buildHash: found.buildHash,
          profile: found.profile,
        },
        files: { ...found.files, "workflow.json": definition.text },
        withheldDefaults: definition.withheld,
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
  const generated: DefinitionPackage["app"]["generated"] = {};
  for (const entry of manifest.artifacts) {
    if (generatedNames.has(entry.path)) {
      generated[entry.path] = {
        sha256: entry.sha256,
        // One after the other: a release generates a few.
        // oxlint-disable-next-line no-await-in-loop -- see above
        text: await releaseArtifactText(env, entry),
      };
    }
  }
  const bindings: DefinitionPackage["app"]["bindings"] = {};
  for (const resource of [
    ...Object.values(release.app.resources),
    ...Object.values(release.app.browserResources),
  ]) {
    bindings[resource.alias] = resource["~resource"];
  }
  const graph = new WorkflowGraph(env, by);
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
      },
      files,
      generated,
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
