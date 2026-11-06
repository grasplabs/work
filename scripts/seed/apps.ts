/**
 * The files of a demo domain's App (core's App of the current layout): it
 * binds the domain's independent workflows under their aliases, holds its
 * screen, and tests each workflow with a `workflowTest` suite.
 */
import {
  applyOperation,
  definitionPath,
  definitionSources,
  definitionText,
  emptyDefinition,
} from "@grasp-os/sdk/host";

import type { EngineSeed } from "./engines.ts";

/**
 * An engine's App files, of the current layout: its AGENTS.md, its
 * definition (no tables, a permission to start each of its workflows,
 * which it binds under its alias) and the code generated from it, the
 * domain's screen, and a `workflowTest` suite of each workflow on one
 * fixture: `desk` starts the runs, and `decider` answers what they ask.
 */
export const engineFiles = (
  seed: EngineSeed,
  screens: Readonly<Record<string, string>>
): Record<string, string> => {
  let definition = emptyDefinition(seed.name);
  for (const { alias, declared } of seed.workflows) {
    definition = applyOperation(definition, {
      op: "addPermission",
      permission: `permission.workflow(${JSON.stringify(alias)}, { input: ${declared.input}, output: ${declared.output} })`,
    });
  }
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
    [definitionPath]: definitionText(definition),
    ...definitionSources(definition),
    ...(screenList.length === 0
      ? {}
      : {
          "screens.ts": `export default {\n  screens: [${screenList.join(", ")}],\n};\n`,
        }),
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
