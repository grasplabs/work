/**
 * The definition and files of a demo App: it
 * binds the App's independent workflows under their aliases, holds its
 * board's table and page (scripts/seed/pages.ts), and tests each workflow
 * with an `appTest` suite.
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
import { boardFiles, boardOperations, boards } from "./pages.ts";

/**
 * An App's definition: its board's table, a permission to start each of its
 * workflows, and the workflow it binds under each alias (`workflows`, by
 * alias, once seeded). A workflow that asks a decision declares it as its
 * live version has it, as binding it in a draft writes it
 * (`bindWorkflow`): what a decision is about, and what a person may
 * answer. Core refuses to publish an App that declares what a workflow it
 * binds doesn't have.
 */
export const appDefinition = (
  seed: AppSeed,
  workflows: ReadonlyMap<string, string> = new Map()
): AppDefinition => {
  const board = boards[seed.name];
  let definition = emptyDefinition(seed.name);
  for (const operation of board === undefined ? [] : boardOperations(board)) {
    definition = applyOperation(definition, operation);
  }
  for (const { alias, declared, decision } of seed.workflows) {
    definition = applyOperation(definition, {
      op: "addPermission",
      permission: `permission.workflow(${JSON.stringify(alias)}, { args: ${declared.args}, returns: ${declared.returns} })`,
    });
    const workflowId = workflows.get(alias);
    if (decision === undefined && workflowId === undefined) {
      continue;
    }
    definition = applyOperation(definition, {
      op: "setWorkflowContract",
      alias,
      contract: {
        events: {},
        listens: {},
        decisions:
          decision === undefined
            ? {}
            : {
                [decision.binding]: {
                  value: descriptorFromText(decisionResponse),
                  context: descriptorFromText(decision.input),
                },
              },
      },
      ...(workflowId === undefined ? {} : { bound: { workflowId } }),
    });
  }
  return definition;
};

/**
 * An App's files: its AGENTS.md, the code generated from its definition
 * (`appDefinition`), its board's server functions and page, and an
 * `appTest` suite of each workflow, which says who starts its runs itself.
 */
export const appFiles = (seed: AppSeed): Record<string, string> => {
  const board = boards[seed.name];
  return {
    "AGENTS.md": seed.agents,
    ...definitionSources(appDefinition(seed)),
    ...(board === undefined ? {} : boardFiles(board)),
    ...Object.fromEntries(
      seed.workflows.map(({ alias, tests }) => [
        `tests/${alias}.test.ts`,
        tests,
      ])
    ),
  };
};
