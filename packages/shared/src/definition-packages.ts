import { z } from "zod";

import { graspLockSchema, packageEntrySchema } from "./packages.ts";
import { catalogBindingKinds } from "./workflow-resources.ts";

// A definition package: an App's current sealed release and
// the exact workflow versions it binds, as portable source another
// deployment can build and activate again. What it may carry is this
// schema and nothing else: every object is strict, so a field core
// didn't list here fails the export instead of travelling with it. No
// platform-held secret has a field here: no connection, credential,
// approval, catalog target, parameter value, store, member, record or
// audit data; bindings are their aliases and kinds, which the destination
// binds anew. What builders wrote into source is theirs, scanned for
// known secret formats before it leaves (definition-export.ts). A
// workflow version's approved npm packages travel as their graph and the
// entries its modules import, never as an approval: the destination asks
// for and approves them again before anything it publishes seals them.

/**
 * The format of a definition package. A package of another format is
 * refused, to be exported again, rather than read as this one: the
 * schema is strict, so another format's shape would read as no package.
 */
export const definitionPackageFormatVersion = 5;

/** The most workflow versions one package holds. */
export const definitionPackageMaxWorkflows = 64;

/** The most bytes of text one package holds (16 MiB). */
export const definitionPackageMaxBytes = 16 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/**
 * A workflow version's key in a package: `workspace/<name>/<version>`, the
 * contract key definitions bind it by, its definition's semantic version.
 */
const workflowKeySchema = z.string().min(1).max(256);

/** Text files by path. */
const filesSchema = z.record(z.string().min(1).max(512), z.string());

/** The permission kinds an App declares, by `~permission`. */
export const appBindingKinds = [
  "ai",
  "connections",
  "brain",
  "grasp",
  "guests",
  "files",
  "links",
] as const;

/**
 * Why a binding a package names isn't in it, so the destination can't
 * activate it until someone binds it:
 *
 * - `unbound`: the App's alias was bound to no workflow when it sealed;
 * - `missing`: the workflow, or the version pinned, is gone;
 * - `forbidden`: whoever exported doesn't build the workflow.
 */
export const unresolvedReasons = ["unbound", "missing", "forbidden"] as const;
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
      /** The SHA-256 of `definition`'s text, as the release names it. */
      definitionHash: sha256Schema,
      contractHash: sha256Schema,
      schemaHash: sha256Schema,
      dependencyLockHash: sha256Schema,
      sdkVersion: z.string().min(1).max(128),
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
     * The version's App definition (@grasp-os/sdk's definition.ts), which
     * its config and schema were generated from: its tables, with their
     * stable IDs, access and permissions, as data. Its text hashes to
     * `definitionHash`. A developer's project needs none of it, and none
     * of it is code; a destination that imports the App takes it whole.
     */
    definition: z.json(),
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
        /** The version's manifest hash. */
        manifestHash: sha256Schema,
        /**
         * The SHA-256 of its grasp-workflow/2 definition as published,
         * which stays with the version: the code was generated from it.
         */
        definitionHash: sha256Schema,
        /** The build's identity. */
        buildHash: sha256Schema,
        profile: z.string().min(1).max(128),
      }),
      /**
       * The TypeScript generated from its definition and its own modules,
       * as published. A sensitive parameter has no value in either: the
       * format keeps none in the document.
       */
      files: filesSchema,
      /** Each catalog contract it binds, by alias: its kind. */
      bindings: z.record(aliasSchema, z.enum(catalogBindingKinds)),
      /**
       * The approved npm packages its modules import (GRA-665), null when
       * it seals none: the graph's hash, the entries the modules import,
       * and the graph's lock (`grasp.lock.json`), from which the
       * destination asks for the same exact versions and a standalone
       * project pins them. Never an approval: the
       * destination approves the graph for its own workflow before
       * anything it publishes seals it.
       */
      packages: z
        .strictObject({
          graphHash: sha256Schema,
          entries: z.array(packageEntrySchema).min(1).max(256),
          lock: graspLockSchema,
        })
        .nullable(),
    })
  ),
  /** Every workflow the App names that the package doesn't resolve. */
  unresolved: z.array(
    z.strictObject({
      alias: aliasSchema,
      reason: z.enum(unresolvedReasons),
    })
  ),
});
export type DefinitionPackage = z.infer<typeof definitionPackageSchema>;
