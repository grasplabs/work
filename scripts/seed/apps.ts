/**
 * The files of a demo domain's App (core's App of the current layout): it
 * binds the domain's independent workflows under their aliases, holds its
 * screen, and tests each workflow with a `workflowTest` suite.
 */
import type { EngineSeed } from "./engines.ts";

/**
 * An engine's App files, of the current layout: its AGENTS.md, an App with
 * no tables that binds each of its workflows under its alias, the
 * domain's screen, and a `workflowTest` suite of each workflow on one
 * fixture: `desk` starts the runs, and `decider` answers what they ask.
 */
export const engineFiles = (
  seed: EngineSeed,
  screens: Readonly<Record<string, string>>
): Record<string, string> => {
  const declared = seed.workflows
    .map(
      ({ alias, declared: { input, output } }) =>
        `export const ${alias} = resource.workflow(${JSON.stringify(alias)}, {\n  input: ${input},\n  output: ${output},\n});\n`
    )
    .join("\n");
  const screenList = Object.keys(screens).map((path) => {
    // An identifier, as a screen's name is: `finance-cockpit` → `financeCockpit`.
    const name = path
      .replace(/^screens\/(?<name>.+)\.tsx$/u, "$<name>")
      .replaceAll(/-(?<letter>[a-z])/gu, (_, letter: string) =>
        letter.toUpperCase()
      );
    return `{ name: ${JSON.stringify(name)}, path: "/", source: ${JSON.stringify(path)} }`;
  });
  const fixture = {
    principals: { desk: { role: "user" }, decider: { role: "user" } },
    workflows: Object.fromEntries(
      seed.workflows.flatMap(({ alias, decision }) =>
        decision === undefined
          ? []
          : [
              [
                alias,
                {
                  params: { [decision.param]: "decider" },
                  deciders: { [decision.binding]: ["decider"] },
                },
              ],
            ]
      )
    ),
  };
  return {
    "AGENTS.md": seed.agents,
    "schema.ts": `import { defineSchema } from "@grasp-os/sdk";\n\nexport default defineSchema({});\n`,
    "app.ts": `import { app, resource, v } from "@grasp-os/sdk";\n\nimport schema from "./schema.ts";\n\n${declared}\nexport default app({\n  name: ${JSON.stringify(seed.name)},\n  schema,\n  access: { tables: {} },\n  operations: {},\n  screens: [${screenList.join(", ")}],\n  uses: [${seed.workflows.map(({ alias }) => alias).join(", ")}],\n});\n`,
    ...screens,
    ...Object.fromEntries(
      seed.workflows.map(({ alias, tests }) => [
        `tests/${alias}.test.ts`,
        tests,
      ])
    ),
    ...(seed.workflows.length === 0
      ? {}
      : {
          "tests/fixtures/desk.json": `${JSON.stringify(fixture, null, 2)}\n`,
        }),
  };
};
