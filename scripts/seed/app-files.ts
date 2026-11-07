/**
 * The files of a demo App: it
 * binds the App's independent workflows under their aliases, holds its
 * page, and tests each workflow with a `workflowTest` suite.
 */
import {
  applyOperation,
  definitionPath,
  definitionSources,
  definitionText,
  emptyDefinition,
} from "@grasp-os/sdk/definition";

import type { AppSeed } from "./apps.ts";

/**
 * An App's files: its AGENTS.md, its
 * definition (no tables, a permission to start each of its workflows,
 * which it binds under its alias) and the code generated from it, the
 * App's page, and a `workflowTest` suite of each workflow on one
 * fixture: `desk` starts the runs, and `decider` answers what they ask.
 */
export const appFiles = (
  seed: AppSeed,
  pages: Readonly<Record<string, string>>
): Record<string, string> => {
  let definition = emptyDefinition(seed.name);
  for (const { alias, declared } of seed.workflows) {
    definition = applyOperation(definition, {
      op: "addPermission",
      permission: `permission.workflow(${JSON.stringify(alias)}, { input: ${declared.input}, output: ${declared.output} })`,
    });
  }
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
    ...pages,
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
