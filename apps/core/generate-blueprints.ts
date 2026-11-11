/**
 * Writes what Grasp generates among each built-in blueprint's files
 * (blueprints/<id>/files/), as every save of an App writes it
 * (`withGeneratedCode`, src/app-definition.ts): `grasp.config.ts` and
 * `server/schema.ts` from its definition.json, and `server/_generated/`
 * from them and its server code. Committed, so the repo checks each
 * built-in's server code against the very modules an App's build reads
 * (each built-in's tsconfig.json). Core's `typegen` runs it, and CI
 * refuses them when they are stale. The install writes them again from
 * the same sources, so a copy holds exactly these.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  definitionSources,
  generatedServerSources,
  readDefinition,
} from "@grasp-os/runtime/definition";

import { blueprintsDir, filesIn } from "./build-blueprints.ts";

/** Writes the generated files of the built-in in `folder`, and only them. */
const generateBlueprint = (folder: string): void => {
  const filesDir = path.join(folder, "files");
  const definition = readDefinition(
    JSON.parse(readFileSync(path.join(folder, "definition.json"), "utf-8"))
  );
  const files = { ...filesIn(filesDir), ...definitionSources(definition) };
  const generated = {
    ...definitionSources(definition),
    ...generatedServerSources(files, definition),
  };
  rmSync(path.join(filesDir, "server/_generated"), {
    recursive: true,
    force: true,
  });
  for (const [file, source] of Object.entries(generated)) {
    const where = path.join(filesDir, file);
    mkdirSync(path.dirname(where), { recursive: true });
    writeFileSync(where, source);
  }
};

const folders = readdirSync(blueprintsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => path.join(blueprintsDir, name));
for (const folder of folders) {
  generateBlueprint(folder);
}
console.info(`Generated the code of ${folders.length} built-in blueprint(s)`);
