/**
 * Keeps the e2e job's Playwright image on the catalog's `@playwright/test`.
 * The image carries the browsers of its own Playwright release, and a test
 * runner of another release looks for browser builds the image doesn't
 * have, so the two must name the same version. Renovate moves them in one
 * pull request (.github/renovate.json5); this catches a hand edit of one.
 */
import { readFileSync } from "node:fs";

import { parse } from "yaml";

const workflowPath = ".github/workflows/ci.yml";
const imagePattern =
  /^mcr\.microsoft\.com\/playwright:v(?<version>[^-\s]+)-noble$/u;

const workspace: unknown = parse(readFileSync("pnpm-workspace.yaml", "utf-8"));
const workflow: unknown = parse(readFileSync(workflowPath, "utf-8"));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;

const catalogVersion = field(field(workspace, "catalog"), "@playwright/test");
const e2eContainer = field(field(field(workflow, "jobs"), "e2e"), "container");
const image = field(e2eContainer, "image") ?? e2eContainer;
const imageVersion =
  typeof image === "string" ? imagePattern.exec(image)?.groups?.version : null;

if (typeof catalogVersion !== "string") {
  console.error(
    "pnpm-workspace.yaml's catalog pins no version of @playwright/test."
  );
  process.exit(1);
}
if (imageVersion === undefined || imageVersion === null) {
  console.error(
    `The e2e job in ${workflowPath} must run in mcr.microsoft.com/playwright:v${catalogVersion}-noble; it names ${JSON.stringify(image ?? null)}.`
  );
  process.exit(1);
}
if (imageVersion !== catalogVersion) {
  console.error(
    `The e2e job's Playwright image is v${imageVersion}, but the catalog pins @playwright/test ${catalogVersion}. Change both together: mcr.microsoft.com/playwright:v${catalogVersion}-noble.`
  );
  process.exit(1);
}
