import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  checked,
  everyStep,
} from "../../../packages/workflow-schema/test/fixtures.ts";
import { buildWorkflows } from "../src/screens.ts";

// grasp-workflow/1's generated code, held to the compiler's own type
// check against the SDK's real declarations (compiler `buildWorkflows`),
// as an App workflow is: the generator's output is the host's own, so a
// type error in it is the generator's, and nothing it generates may fail
// the check a build holds it to.

/** Every fixture the generator is tested on, by name. */
const fixtures = { everyStep };

describe("grasp-workflow/1's generated code", () => {
  it("type-checks against the SDK, for every fixture", async () => {
    const diagnostics = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtures).map(
          async ([name, fixture]): Promise<[string, string[]]> => {
            const { source } = generateWorkflow(
              checked(fixture()),
              "generated"
            );
            const build = await buildWorkflows(
              env,
              { "workflows/generated.ts": source },
              "workflow-schema-builds",
              {}
            );
            return [
              name,
              build.ok
                ? []
                : build.diagnostics.map(
                    ({ rule, line, message }) => `${rule} ${line}: ${message}`
                  ),
            ];
          }
        )
      )
    );
    expect(diagnostics).toStrictEqual(
      Object.fromEntries(Object.keys(fixtures).map((name) => [name, []]))
    );
  });
});
