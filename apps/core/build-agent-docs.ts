/**
 * Embeds the SDK docs' guides, as the agent reads them
 * (apps/docs/agent-guides.ts), into dist/agent-docs.js, which core
 * imports as `#agent-docs` (src/agent-docs.d.ts) for the chat's agent's
 * system prompt (src/agent-docs.ts). Core's build runs it, and its tests'
 * setup, so the agent always reads the guides of the release it runs:
 * nothing is copied by hand, and nothing can be stale.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agentGuides } from "../docs/agent-guides.ts";

/** The module core imports as `#agent-docs`. */
export const agentDocsModule = path.join(
  import.meta.dirname,
  "dist/agent-docs.js"
);

/**
 * Writes the guides into `out`, leaving an unchanged module as it is, so
 * its time stays the same.
 */
export const writeAgentDocs = (out: string = agentDocsModule): void => {
  const text = `export default ${JSON.stringify(agentGuides())};\n`;
  if (existsSync(out) && readFileSync(out, "utf-8") === text) {
    return;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
};

if (import.meta.main) {
  writeAgentDocs();
  console.info("Embedded the SDK docs' guides for the agent");
}
