/**
 * Embeds the built-in blueprints into dist/blueprints.js, which core
 * imports as `#blueprints` (src/blueprints.d.ts) and installs once per
 * release (src/builtins.ts), with no network access. Core's build runs it.
 * Core's tests embed their fixtures too, into a module of their own
 * (`testBlueprintsModule`, which vite.config.ts makes `#blueprints` for
 * them), so a deploy after a test run can't ship a test's built-in.
 *
 * Each built-in is a folder under apps/core/blueprints/, named by its id,
 * which never changes: renaming the folder makes another blueprint. In it:
 *
 * - `blueprint.json`: `{ "name": …, "description": … }`, as for any App,
 *   and optionally `"collections"`: the collections it keeps documents in,
 *   as `[{ "id": …, "name": …, "description": … }]`, which the install
 *   creates if they aren't there yet (`declaredCollectionSchema`); and
 *   `"permissions"`: what each App created from it asks for, as
 *   `[{ "object": { "type": "collection", "collectionId": … }, "actions":
 *   […], "binding": … }]`, each a request an admin grants on the copy,
 *   and each for one of its collections; `"contracts"`: the catalog
 *   contracts its workflows bind, as an admin publishes them
 *   (`catalogContractSchema`), which the install publishes if their keys
 *   aren't taken; and `"workflows"`: the independent workflows each App
 *   created from it gets, as `[{ "alias": …, "binding": …, "definition":
 *   "workflows/<alias>.json" }]`, each a grasp-open-workflow/1 definition
 *   in the folder (not in `files/`: it is no file of the App), which the
 *   copy binds under its alias and asks to start under its binding name;
 * - `files/`: the App's files, by path, written against `@grasp-os/sdk`
 *   like any App's.
 *
 * Each is checked here as the install would check it, so a bad one fails
 * the build rather than the install: its ID, its manifest (its
 * collections, and its permissions as any request's are checked, each
 * for a collection it declares), and its
 * files as any App's write checks them (paths, no hidden files, each
 * file's size and their number), and their total size as any version's.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { appLimits } from "@grasp-os/shared/app-limits";
import { fileChangesSchema, fromBlueprintSchema } from "@grasp-os/shared/apps";
import { declaredCollectionSchema } from "@grasp-os/shared/knowledge";
import {
  blueprintWorkflowSchema,
  declaredPermissionSchema,
} from "@grasp-os/shared/permissions";
import { catalogContractSchema } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import type { BuiltinBlueprint } from "#blueprints";

/** Where the built-ins that ship with each release are. */
export const blueprintsDir = path.join(import.meta.dirname, "blueprints");

/** The module core imports as `#blueprints`. */
export const blueprintsModule = path.join(
  import.meta.dirname,
  "dist/blueprints.js"
);

/** The module core's tests import as `#blueprints`, fixtures included. */
export const testBlueprintsModule = path.join(
  import.meta.dirname,
  "dist/test-blueprints.js"
);

/** Most permissions one built-in declares: each is one install statement. */
export const declaredMaxPermissions = 16;

/** Most collections one built-in declares. */
export const declaredMaxCollections = 4;

/**
 * Most workflows one built-in ships: each is a workflow its creator
 * creates and publishes as the copy is made, under their own quota.
 */
export const declaredMaxWorkflows = 4;

/** Most catalog contracts one built-in ships. */
export const declaredMaxContracts = 8;

/** A workflow as `blueprint.json` names it: its definition by its path. */
const declaredWorkflowSchema = blueprintWorkflowSchema.extend({
  definition: z.string().regex(/^workflows\/[a-z][a-z0-9]*\.json$/u),
});

/**
 * A `blueprint.json`: the App's name and description, as for any App,
 * the collections it declares, and what each copy asks for, each binding
 * name once, as an App's permissions have them, and each for a
 * collection it declares.
 */
const manifestSchema = fromBlueprintSchema
  .extend({
    collections: z
      .array(declaredCollectionSchema)
      .max(declaredMaxCollections)
      .refine(
        (collections) =>
          new Set(collections.map(({ id }) => id)).size === collections.length,
        { message: "Each collection once" }
      )
      .default([]),
    permissions: z
      .array(declaredPermissionSchema)
      .max(declaredMaxPermissions)
      .refine(
        (permissions) =>
          new Set(permissions.map(({ binding }) => binding)).size ===
          permissions.length,
        { message: "Each binding name once" }
      )
      .default([]),
    contracts: z
      .array(catalogContractSchema)
      .max(declaredMaxContracts)
      .refine(
        (contracts) =>
          new Set(contracts.map(({ key }) => key)).size === contracts.length,
        { message: "Each key once" }
      )
      .default([]),
    workflows: z
      .array(declaredWorkflowSchema)
      .max(declaredMaxWorkflows)
      .refine(
        (workflows) =>
          new Set(workflows.map(({ alias }) => alias)).size ===
          workflows.length,
        { message: "Each alias once" }
      )
      .default([]),
  })
  .refine(
    // A copy's permissions, its workflows' included, each under a name of
    // its own, as an App's permissions have them.
    ({ permissions, workflows }) => {
      const names = [...permissions, ...workflows].map(
        ({ binding }) => binding
      );
      return new Set(names).size === names.length;
    },
    { path: ["workflows"], message: "Each binding name once" }
  )
  .refine(
    ({ collections, permissions }) =>
      permissions.every(
        ({ object }) =>
          object.type !== "collection" ||
          collections.some(({ id }) => id === object.collectionId)
      ),
    {
      path: ["permissions"],
      message: "Each for a collection the blueprint declares",
    }
  );

/** A folder name that is safe in an ID, a URL and an audit event. */
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Every file under `dir`, by its path from `dir`, with `/` between names. */
const filesIn = (dir: string): Record<string, string> => {
  const paths = readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => statSync(path.join(dir, file)).isFile())
    .map((file) => file.split(path.sep).join("/"))
    .toSorted();
  return Object.fromEntries(
    paths.map((file) => [file, readFileSync(path.join(dir, file), "utf-8")])
  );
};

/** The built-ins in `dir`, one per folder, checked. */
const blueprintsIn = (dir: string): BuiltinBlueprint[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const folder = path.join(dir, name);
      const where = `Built-in blueprint ${folder}`;
      if (!idSchema.safeParse(name).success) {
        throw new Error(`${where}: name the folder in lowercase-kebab-case`);
      }
      const manifest = manifestSchema.safeParse(
        JSON.parse(readFileSync(path.join(folder, "blueprint.json"), "utf-8"))
      );
      if (!manifest.success) {
        throw new Error(`${where}: blueprint.json ${manifest.error.message}`);
      }
      const filesDir = path.join(folder, "files");
      if (!existsSync(filesDir)) {
        throw new Error(`${where}: has no files/`);
      }
      const files = filesIn(filesDir);
      const checked = fileChangesSchema.safeParse(files);
      if (!checked.success) {
        throw new Error(`${where}: files/ ${checked.error.message}`);
      }
      const length = Object.values(files).reduce(
        (total, text) => total + text.length,
        0
      );
      if (length > appLimits.totalLength) {
        throw new Error(
          `${where}: files/ holds ${length} characters, over an App's ${appLimits.totalLength}`
        );
      }
      const workflows = manifest.data.workflows.map((workflow) => {
        const file = path.join(folder, workflow.definition);
        if (!existsSync(file)) {
          throw new Error(`${where}: has no ${workflow.definition}`);
        }
        const definition = readFileSync(file, "utf-8");
        // Checked as an install stores it, so the copy can publish it.
        const shipped = blueprintWorkflowSchema.safeParse({
          ...workflow,
          definition,
        });
        if (!shipped.success) {
          throw new Error(
            `${where}: ${workflow.definition} ${shipped.error.message}`
          );
        }
        try {
          JSON.parse(definition);
        } catch {
          throw new Error(`${where}: ${workflow.definition} isn't JSON`);
        }
        return shipped.data;
      });
      return { id: name, ...manifest.data, workflows, files };
    });

/**
 * Writes the built-ins in `dirs` into `out`, in id order, or refuses when
 * two share an id. Leaves an unchanged module as it is, so its time stays
 * the same.
 */
export const writeBlueprints = (
  dirs: readonly string[],
  out: string = blueprintsModule
): number => {
  const blueprints = dirs
    .flatMap(blueprintsIn)
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));
  const ids = blueprints.map(({ id }) => id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) {
    throw new Error(`Two built-in blueprints are named ${repeated}`);
  }
  const text = `export default ${JSON.stringify(blueprints)};\n`;
  const unchanged = existsSync(out) && readFileSync(out, "utf-8") === text;
  if (!unchanged) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  return blueprints.length;
};

if (import.meta.main) {
  const count = writeBlueprints([blueprintsDir]);
  console.info(`Embedded ${count} built-in blueprint(s)`);
}
