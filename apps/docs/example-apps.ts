/**
 * The example Apps, as pages of the docs: the built-in blueprints that
 * are written to be copied (apps/core/blueprints/), one page each under
 * `content/examples/`, with every file of the App in full. Generated on
 * every build (build.ts), as the API reference is, so a page is always
 * the App the release installs and its tests build, never a copy that
 * drifts. People read them at /docs/examples, and the agent with
 * `readDocs` (the guide /guides/examples points to them).
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

/** Where the built-in blueprints are. */
export const blueprintsDir = path.join(
  import.meta.dirname,
  "../core/blueprints"
);

/** Where their pages go: generated, never committed. */
export const examplesContent = path.join(
  import.meta.dirname,
  "content/examples"
);

/** The blueprints that are examples, by ID, in the sidebar's order. */
export const exampleApps = [
  "kanban-board",
  "crm",
  "approvals",
  "dashboard",
] as const;

const manifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

/** The language a code block of `file` is tagged with. */
const languageOf = (file: string): string => {
  const extension = path.extname(file).slice(1);
  if (!["ts", "tsx", "json"].includes(extension)) {
    throw new Error(`An example's file ${file} isn't TypeScript or JSON.`);
  }
  return extension;
};

/** Where a file stands on its page: what the App is, then its server, then its pages. */
const placeOf = (file: string): number => {
  const order = [
    "grasp.config.ts",
    "server/schema.ts",
    "server/",
    "src/routes/",
    "src/",
  ];
  const at = order.findIndex((prefix) =>
    prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix
  );
  return at === -1 ? order.length : at;
};

/** Every file under `dir`, by its path from it, with `/` between names. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/")
    );

/** The page of the example `id`, number `order` in the sidebar. */
export const examplePage = (
  id: string,
  order: number,
  dir: string = blueprintsDir
): string => {
  const folder = path.join(dir, id);
  const { name, description } = manifestSchema.parse(
    JSON.parse(readFileSync(path.join(folder, "blueprint.json"), "utf-8"))
  );
  const files = path.join(folder, "files");
  const sections = filesIn(files)
    .toSorted((a, b) => placeOf(a) - placeOf(b) || a.localeCompare(b))
    .map((file) => {
      const text = readFileSync(path.join(files, file), "utf-8").trimEnd();
      if (text.includes("```")) {
        throw new Error(`The example ${id}'s ${file} holds a code fence.`);
      }
      return `## ${file}\n\n\`\`\`${languageOf(file)} ${file}\n${text}\n\`\`\``;
    });
  return [
    "---",
    `title: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "sidebar:",
    `  order: ${order}`,
    "---",
    "",
    `${description} Every file of the App is below, as Grasp installs it: the \`grasp.config.ts\` and \`server/schema.ts\` generated from its definition, its server functions in \`server/\`, and its Pages in \`src/\`.`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
};

/** Writes the example pages into `out`, in place of any written before. */
export const writeExamples = (
  out: string = examplesContent,
  dir: string = blueprintsDir
): void => {
  rmSync(out, { force: true, recursive: true });
  mkdirSync(out, { recursive: true });
  for (const [index, id] of exampleApps.entries()) {
    writeFileSync(path.join(out, `${id}.md`), examplePage(id, index + 1, dir));
  }
};
