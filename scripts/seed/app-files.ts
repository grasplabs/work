/**
 * The definition and files of a demo App: it
 * binds the App's independent workflows under their aliases, holds its
 * page, and tests each workflow with a `workflowTest` suite.
 */
import {
  applyOperation,
  definitionSources,
  emptyDefinition,
} from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";

import type { AppSeed } from "./apps.ts";

/**
 * An App's definition: no tables, a permission to start each of its
 * workflows, which it binds under its alias.
 */
export const appDefinition = (seed: AppSeed): AppDefinition => {
  let definition = emptyDefinition(seed.name);
  for (const { alias, declared } of seed.workflows) {
    definition = applyOperation(definition, {
      op: "addPermission",
      permission: `permission.workflow(${JSON.stringify(alias)}, { args: ${declared.args}, returns: ${declared.returns} })`,
    });
  }
  return definition;
};

/**
 * An App's files: its AGENTS.md, the code generated from its definition
 * (`appDefinition`), the App's page, and a `workflowTest` suite of each
 * workflow on one fixture: `desk` starts the runs, and `decider` answers
 * what they ask.
 */
export const appFiles = (
  seed: AppSeed,
  pages: Readonly<Record<string, string>>
): Record<string, string> => {
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
    ...definitionSources(appDefinition(seed)),
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
