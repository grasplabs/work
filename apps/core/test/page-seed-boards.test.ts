import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  boardFiles,
  boardOperations,
  boards,
} from "../../../scripts/seed/pages.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { buildPages } from "../src/pages.ts";
import { testApp, writeApp } from "./app-definitions.ts";
import { mockSessionIdp, personApi } from "./page-client.ts";

// The demo company's board pages (scripts/seed/pages.ts), built as a
// draft's pages are: a seed whose page fails its checks stops halfway.

mockSessionIdp();

describe("the seed's board pages", { timeout: 300_000 }, () => {
  it("build without a problem, each over its own table", async () => {
    const builder = await personApi("builder");
    const problems: Record<string, string[]> = {};
    for (const [name, board] of Object.entries(boards)) {
      const [table] = boardOperations(board);
      if (table?.op !== "addTable") {
        throw new Error(`${name} adds no table`);
      }
      const app = testApp(
        {
          name,
          tables: {
            [board.table]: {
              fields: table.fields ?? {},
              indexes: { by_stage: ["stage"] },
              access: { read: "appMembers", write: "appMembers" },
            },
          },
        },
        boardFiles(board)
      );
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const { id } = await builder.api.apps.create({ name });
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await writeApp(builder.api, id, app);
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const drafted = await withDraftReferences(
        env,
        appIdSchema.parse(id),
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await builder.api.drafts.files({ kind: "app", id })
      );
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const built = await buildPages(env, drafted.files, "app-test");
      problems[name] = built.diagnostics.map(
        ({ file, line, rule, message }) => `${file}:${line} ${rule} ${message}`
      );
    }

    expect(problems).toStrictEqual(
      Object.fromEntries(Object.keys(boards).map((name) => [name, []]))
    );
  });
});
