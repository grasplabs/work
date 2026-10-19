import { z } from "zod";

import { exactVersionPattern } from "./dependencies.ts";
import {
  catalogBindingKinds,
  workflowNameSchema,
  workflowNamespace,
} from "./workflow-resources.ts";

// A definition package: an App's current sealed release and
// the exact workflow versions it binds, as portable source another
// deployment can build and activate again. What it may carry is this
// schema and nothing else: every object is strict, so a field core
// didn't list here fails the export instead of travelling with it. No
// platform-held secret has a field here: no connection, credential,
// approval, catalog target, parameter value, store, member, record or
// audit data; bindings are their aliases and kinds, which the destination
// binds anew. What builders wrote into source is theirs, scanned for
// known secret formats before it leaves (definition-export.ts).

/** The format of a definition package. */
export const definitionPackageFormatVersion = 1;

/** The most workflow versions one package holds. */
export const definitionPackageMaxWorkflows = 64;

/** The most bytes of text one package holds (16 MiB). */
export const definitionPackageMaxBytes = 16 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

const workflowKeyPattern =
  /^(?<namespace>[^/]+)\/(?<name>[^/]+)\/(?<version>[^/]+)$/u;

/**
 * The name and version a workflow version's key names
 * (`workflowKeySchema`), or undefined when it isn't one.
 */
export const workflowKeyParts = (
  key: string
): { name: string; version: string } | undefined => {
  const groups = workflowKeyPattern.exec(key)?.groups;
  if (
    groups?.namespace !== workflowNamespace ||
    groups.name === undefined ||
    groups.version === undefined ||
    !workflowNameSchema.safeParse(groups.name).success ||
    // A workflow's version as its publication allows it, of any length the
    // key holds: never the npm length cap `exactVersionSchema` adds.
    !exactVersionPattern.test(groups.version)
  ) {
    return undefined;
  }
  return { name: groups.name, version: groups.version };
};

/**
 * A workflow version's key in a package: `workspace/<name>/<version>`, the
 * contract key definitions bind it by, its definition's semantic version.
 */
const workflowKeySchema = z
  .string()
  .max(256)
  .refine((key) => workflowKeyParts(key) !== undefined, {
    message: "A workflow's key: workspace/<name>/<version>",
  });

/** Text files by path. */
const filesSchema = z.record(z.string().min(1).max(512), z.string());

/** The resource kinds an App declares, by `~resource`. */
export const appBindingKinds = [
  "model",
  "connector",
  "knowledge",
  "template",
  "store",
  "statistics",
  "guests",
  "app",
  "files",
  "links",
] as const;

/**
 * Why a binding a package names isn't in it, so the destination can't
 * activate it until someone binds it:
 *
 * - `unbound`: the App's alias was bound to no workflow when it sealed;
 * - `missing`: the workflow, or the version pinned, is gone;
 * - `forbidden`: whoever exported doesn't build the workflow;
 * - `not_executable`: the version pinned has no build to run;
 * - `sensitive_constraint`: the version's sensitive parameter pins its
 *   value in its schema, or nearly (`const`, `enum`, `pattern`, bounds
 *   that leave one value or length), which would give it away.
 */
export const unresolvedReasons = [
  "unbound",
  "missing",
  "forbidden",
  "not_executable",
  "sensitive_constraint",
] as const;
export type UnresolvedReason = (typeof unresolvedReasons)[number];

export const definitionPackageSchema = z.strictObject({
  formatVersion: z.literal(definitionPackageFormatVersion),
  app: z.strictObject({
    /** The App's version the release sealed. */
    version: z.int().min(1),
    /** What the release's manifest says of it, by hash and version. */
    provenance: z.strictObject({
      manifestHash: sha256Schema,
      sourceTreeHash: sha256Schema,
      contractHash: sha256Schema,
      schemaHash: sha256Schema,
      dependencyLockHash: sha256Schema,
      sdkVersion: z.string().min(1).max(128),
      sdkProtocolVersion: z.int(),
      uiVersion: z.string().min(1).max(128),
      compilerVersion: z.string().min(1).max(128),
      /**
       * Each file the seal generated, by path: its SHA-256 only. The
       * destination generates its own, for its own IDs and bindings.
       */
      generated: z.record(z.string().min(1).max(512), sha256Schema),
    }),
    /** The version's source tree, which hashes to `sourceTreeHash`. */
    files: filesSchema,
    /**
     * The App's registration as the host read and sealed it, canonical
     * text, which the SDK reads back strictly (`readAppManifest`): what
     * a destination generates the App's references from, with its own
     * identity, without running the App's code. Derived from its source
     * alone: no ID of this deployment. Never trusted: an import seals the
     * App again from its source, and takes nothing from this but what a
     * developer's project generates for its own build.
     */
    manifest: z.string().min(1),
    /** The store contract the release was sealed against, without the store. */
    store: z
      .strictObject({
        alias: aliasSchema,
        schemaVersion: z.int().min(1),
        schemaHash: sha256Schema,
        operationManifestHash: sha256Schema,
      })
      .nullable(),
    /** Each resource the App declares, by alias: its kind. */
    bindings: z.record(aliasSchema, z.enum(appBindingKinds)),
    /** Each workflow the App declares, by alias: its version's key, if packaged. */
    workflows: z.record(aliasSchema, workflowKeySchema.nullable()),
    /**
     * For each workflow alias whose version is packaged, what the seal
     * resolved of it beyond its declaration (the events its binding
     * admits, its listen tasks and its decisions, by their descriptors),
     * which the App's generated references type: never the version it
     * pinned, and nothing of a workflow the package doesn't carry.
     */
    workflowContracts: z.record(
      aliasSchema,
      z.strictObject({
        events: z.record(
          z.string(),
          z.strictObject({ type: z.string(), data: z.json() })
        ),
        listens: z.record(z.string(), z.array(z.string())),
        decisions: z.record(
          z.string(),
          z.strictObject({ value: z.json(), context: z.json() })
        ),
      })
    ),
  }),
  /** Each workflow version reached from the App, once, by key. */
  workflows: z.record(
    workflowKeySchema,
    z.strictObject({
      provenance: z.strictObject({
        /**
         * The version's manifest hash, null when anything was withheld:
         * it hashes what was published, which would let a holder test
         * guesses at what was withheld.
         */
        manifestHash: sha256Schema.nullable(),
        /** The SHA-256 of `workflow.json` as exported. */
        definitionHash: sha256Schema,
        evaluatorHash: sha256Schema,
        /** The build's identity, null when anything was withheld, as above. */
        buildHash: sha256Schema.nullable(),
        profile: z.string().min(1).max(128),
      }),
      /**
       * `workflow.json` (its sensitive parameters' defaults withheld), the
       * TypeScript generated from it and its own modules, as published.
       */
      files: filesSchema,
      /** The parameters whose defaults `workflow.json` no longer carries. */
      withheldDefaults: z.array(z.string().min(1).max(128)),
      /**
       * The sensitive parameters whose bounds (minimum, maximum, length,
       * items) `workflow.json` no longer carries: the destination's own
       * to set again.
       */
      withheldConstraints: z.array(z.string().min(1).max(128)),
      /** Each workflow it binds, by alias: that version's key, if packaged. */
      workflows: z.record(aliasSchema, workflowKeySchema.nullable()),
      /** Each catalog contract it binds, by alias: its kind. */
      bindings: z.record(aliasSchema, z.enum(catalogBindingKinds)),
    })
  ),
  /** Every binding named above that the package doesn't resolve. */
  unresolved: z.array(
    z.strictObject({
      /** `app`, or the key of the workflow version that names it. */
      at: z.string().min(1).max(256),
      alias: aliasSchema,
      reason: z.enum(unresolvedReasons),
    })
  ),
});
export type DefinitionPackage = z.infer<typeof definitionPackageSchema>;
