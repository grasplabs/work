import { declaredPermissions, generatedPaths } from "@grasp-os/sdk/host";
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
import {
  appFor,
  findVersion,
  readStored,
  versionFiles,
  versionTree,
} from "./apps.ts";
import { appendAuditEvent } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { requireNotStaff } from "./sharing.ts";
import { exportedWorkflowVersion } from "./workflow-resources.ts";

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
//   the checks a run makes (the release's, its source tree's and its
//   definition's against the manifest, each generated file's, each workflow version's and build's),
//   and refused otherwise.
// - A version repeats, or the package grows past what one answer holds:
//   each version is packaged once under its key and named by it
//   everywhere else, so a version pinned again is only named; at most
//   `definitionPackageMaxWorkflows` are read, and at most
//   `definitionPackageMaxBytes` of text packaged.
// - A package looks complete when it isn't: every binding it can't
//   resolve is listed (`unresolved`), so activation blocks on it.

type PackagedWorkflow = DefinitionPackage["workflows"][string];

/** What packaging one pin came to: the version's key, or why it has none. */
type Packed = { readonly key: string } | { readonly reason: UnresolvedReason };

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

/**
 * The workflow versions the App's pins name, each read once by `by`,
 * packaged under its key with the catalog kinds it binds, and every pin
 * that doesn't resolve. A workflow binds no other: what it binds is the
 * catalog's.
 */
class PackagedVersions {
  readonly packaged: Record<string, PackagedWorkflow> = {};
  readonly unresolved: DefinitionPackage["unresolved"] = [];
  readonly #env: Env;
  readonly #by: Acting;
  readonly #budget: TextBudget;
  /** What each pin read came to, by `<workflow id>@<version>`. */
  readonly #read = new Map<string, Packed>();

  constructor(env: Env, by: Acting, budget: TextBudget) {
    this.#env = env;
    this.#by = by;
    this.#budget = budget;
  }

  /**
   * The key of the version `pin` names, packaged the first time it is
   * named and only named after; null, with an unresolved entry for
   * `alias`, for one that can't be packaged.
   */
  async pack(alias: string, pin: WorkflowPin): Promise<string | null> {
    const id = `${pin.workflowId}@${pin.version}`;
    let packed = this.#read.get(id);
    if (packed === undefined) {
      if (this.#read.size >= definitionPackageMaxWorkflows) {
        throw versionErrors.create("version.export_too_large");
      }
      packed = await this.#packed(pin);
      this.#read.set(id, packed);
    }
    if ("reason" in packed) {
      this.unresolved.push({ alias, reason: packed.reason });
      return null;
    }
    return packed.key;
  }

  async #packed(pin: WorkflowPin): Promise<Packed> {
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
    this.packaged[key] = {
      provenance: {
        manifestHash: found.manifestHash,
        definitionHash: found.definitionHash,
        buildHash: found.buildHash,
        profile: found.profile,
      },
      files,
      bindings: Object.fromEntries(
        found.bindings.map((binding) => [binding.alias, binding.kind])
      ),
      packages:
        found.packages === null
          ? null
          : {
              graphHash: found.packages.graphHash,
              entries: [...found.packages.entries],
              lock: found.packages.lock,
            },
    };
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
  const definition = await readStored(await findVersion(env, app.id, version));
  if (definition.hash !== manifest.definitionHash) {
    throw versionErrors.create("version.artifact_corrupt", {
      path: "definition",
    });
  }
  const budget = textBudget(maxBytesOf(env));
  budget("app", files);
  const registration = canonicalText(release.app);
  // Named as the package names it: it is no file of the App's.
  budget(null, { "app.manifest": registration });
  // What the App is, as data: counted and scanned as the files are.
  budget(null, { "app.definition": definition.text });
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
  // What an admin binds or grants: neither the workflows, which the
  // package carries pinned below, nor the people, which need no binding.
  for (const resource of Object.values(release.app.permissions)) {
    const kind = resource["~permission"];
    if (kind !== "workflows" && kind !== "people") {
      bindings[resource.alias] = kind;
    }
  }
  const versions = new PackagedVersions(env, by, budget);
  const workflows: DefinitionPackage["app"]["workflows"] = {};
  for (const { alias } of declaredPermissions(release.app, "workflows")) {
    const pinned = release.workflows.find(
      (workflow) => workflow.alias === alias
    )?.pinned;
    if (pinned === undefined) {
      versions.unresolved.push({ alias, reason: "unbound" });
      workflows[alias] = null;
    } else {
      // oxlint-disable-next-line no-await-in-loop -- each pin read once, in order
      workflows[alias] = await versions.pack(alias, pinned);
    }
  }
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
        definitionHash: manifest.definitionHash,
        contractHash: manifest.contractHash,
        schemaHash: manifest.schemaHash,
        dependencyLockHash: manifest.dependencyLockHash,
        sdkVersion: manifest.sdkVersion,
        uiVersion: manifest.uiVersion,
        compilerVersion: manifest.compilerVersion,
        generated,
      },
      files,
      definition: z.json().parse(JSON.parse(definition.text)),
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
    workflows: versions.packaged,
    unresolved: versions.unresolved,
  } satisfies DefinitionPackage);
  await appendAuditEvent(env, {
    actor: actorOf(by),
    action: "app.definition.exported",
    target: { type: "app", id: app.id },
    detail: {
      version,
      workflows: Object.keys(versions.packaged).length,
      unresolved: versions.unresolved.length,
    },
  });
  return definitionPackage;
};
