/**
 * Checks every wrangler config in the repo against the rules in
 * `wrangler-config-rules.ts` (request URLs out of Workers Logs, no preview
 * URLs, JSONC only), so a new Worker can't miss them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  platformNameErrors,
  sharedRateLimitIds,
  wranglerConfigErrors,
} from "./wrangler-config-rules.ts";

const configs = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*wrangler.json",
    "*wrangler.jsonc",
    "*wrangler.toml",
  ],
  { encoding: "utf-8" }
)
  .split("\n")
  .filter(Boolean);

const errors = configs.flatMap((file) =>
  wranglerConfigErrors(file, readFileSync(file, "utf-8"))
);

const texts = configs.map((file) => ({
  file,
  text: readFileSync(file, "utf-8"),
}));
const names = [
  ...texts.flatMap(({ file, text }) => platformNameErrors(file, text)),
  ...sharedRateLimitIds(texts).map(
    (id) =>
      `Rate limit namespace ${id} is used twice: each stage needs its own.`
  ),
];
if (names.length > 0) {
  console.error(
    `Platform Workers name their resources as @grasp-os/shared/names does:\n${names.map((line) => `  ${line}`).join("\n")}`
  );
  process.exit(1);
}

if (errors.length > 0) {
  console.error(
    `Workers must keep request URLs out of Workers Logs (threat model R17) and serve no preview URLs:\n${errors.map((line) => `  ${line}`).join("\n")}`
  );
  process.exit(1);
}
