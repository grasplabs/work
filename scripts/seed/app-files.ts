/**
 * The definition and files of a demo App: it
 * binds the App's independent workflows under their aliases, holds its
 * page, and tests each workflow with an `appTest` suite.
 */
import {
  applyOperation,
  definitionSources,
  emptyDefinition,
} from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import { descriptorFromText } from "@grasp-os/runtime/host";

import { decisionResponse } from "./apps.ts";
import type { AppSeed } from "./apps.ts";

/**
 * An App's definition: no tables, a permission to start each of its
 * workflows, which it binds under its alias. A workflow that asks a
 * decision declares it as the version bound has it, as binding it in a
 * draft writes it (`bindWorkflow`): what a decision is about, and what a
 * person may answer. Core refuses to bind a version whose contract
 * differs from what the App's current version declares.
 */
export const appDefinition = (seed: AppSeed): AppDefinition => {
  let definition = emptyDefinition(seed.name);
  for (const { alias, declared, decision } of seed.workflows) {
    definition = applyOperation(definition, {
      op: "addPermission",
      permission: `permission.workflow(${JSON.stringify(alias)}, { args: ${declared.args}, returns: ${declared.returns} })`,
    });
    if (decision !== undefined) {
      definition = applyOperation(definition, {
        op: "setWorkflowContract",
        alias,
        contract: {
          events: {},
          listens: {},
          decisions: {
            [decision.binding]: {
              value: descriptorFromText(decisionResponse),
              context: descriptorFromText(decision.input),
            },
          },
        },
      });
    }
  }
  return definition;
};

/**
 * An App's files: its AGENTS.md, the code generated from its definition
 * (`appDefinition`), the App's page, and an `appTest` suite of each
 * workflow, which says who starts its runs itself.
 */
export const appFiles = (
  seed: AppSeed,
  pages: Readonly<Record<string, string>>
): Record<string, string> => ({
  "AGENTS.md": seed.agents,
  ...definitionSources(appDefinition(seed)),
  ...pages,
  ...Object.fromEntries(
    seed.workflows.map(({ alias, tests }) => [`tests/${alias}.test.ts`, tests])
  ),
});
