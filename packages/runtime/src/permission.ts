import { isPlainObject } from "@grasp-os/shared/json";
import { isEventType, sealedBuildLimits } from "@grasp-os/shared/sealed-builds";

import type {
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";
import type {
  ConnectorAction,
  ConnectorContract,
} from "./connector-contracts.ts";
import { namePattern } from "./declaration.ts";
import type { FilesOperation } from "./file-link-references.ts";
import { graspFunctions } from "./grasp-functions.ts";
import {
  brainOperations,
  checkedAlias,
  checkedConfig,
  checkedContract,
  checkedActions,
  checkedList,
  checkedOrigins,
  declared,
  declaredForBrowser,
  declaredWorkflow,
  filesOperations,
  guestsOperations,
  known,
  refuse,
} from "./permission-checks.ts";
import { permissionAliases } from "./permission-types.ts";
import type {
  AiConfig,
  AiPermission,
  BrainConfig,
  BrainOperation,
  BrainPermission,
  ConnectionConfig,
  ConnectionPermission,
  FilesPermission,
  GraspPermission,
  GuestsOperation,
  GuestsPermission,
  LinksPermission,
  WorkflowConfig,
  WorkflowPermission,
} from "./permission-types.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, InferInput } from "./value-types.ts";
import { v } from "./values.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";

// `permission`: how an App says what it can reach outside itself,
// as an admin thinks of it. Eight permissions, each listed under
// its own key of the App's `permissions` (app.ts):
//
// - `ai`: answers from the workspace's model (`ctx.ai.generate`);
// - `connections`: some actions of a connection, through connect
//   (`ctx.connections.<alias>`);
// - `brain`: recalling from the Brain, as the person each call acts for
//   may read it (`ctx.brain.recall`);
// - `workflows`: independent workflows the App starts
//   (`ctx.workflows.<alias>.start`);
// - `grasp`: the platform's own read-only functions, such as its
//   statistics (`permission.grasp`, `ctx.grasp`). An App never calls
//   another App: Apps that belong together are one App, and a workflow
//   moves data between Apps;
// - `people`: the organization's members (`ctx.people`), a flag on the
//   App's `permissions`, never a declaration;
// - `files`: what the App's pages may do with files;
// - `guests`: guest chats (`ctx.guests`).
//
// and `links`, the exact origins the App's pages may link to, which
// grants no network access at all.
//
// A declaration is a requirement, never a grant: it names an adapter
// contract and an alias, and the host binds it to an approved target,
// under the App's grants, or refuses. It holds no ID, key or token, and
// building one reaches nothing. The App's permissions are the only list:
// any of its functions may use what they declare, as its kind allows
// (server.ts), and the host checks every call against them. Only an
// action reaches the network; a mutation stages starts of the App's
// workflows for after it commits; a query reaches nothing.

/** `record`, a workflow permission's `what`: an object of at most `max`. */
const checkedRecord = (
  record: unknown,
  what: string,
  max: number
): [string, unknown][] => {
  if (record === undefined) {
    return [];
  }
  if (!isPlainObject(record)) {
    return refuse(`A workflow's \`${what}\` is an object.`);
  }
  const entries = Object.entries(record);
  if (entries.length > max) {
    return refuse(`A workflow declares at most ${max} ${what}.`);
  }
  return entries;
};

/** An event's or a decision's alias in its workflow: a plain name. */
const checkedName = (name: string): string =>
  namePattern.test(name)
    ? name
    : refuse(
        `\`${name}\` isn't an event's or a decision's alias: a letter, then letters, digits or underscores, at most 64.`
      );

/** A workflow permission's `events`, as data. */
const checkedEvents = (events: unknown): Record<string, BoundWorkflowEvent> =>
  Object.fromEntries(
    checkedRecord(events, "events", workflowReferenceLimits.events).map(
      ([alias, event]) => {
        const config = checkedConfig(event, ["type", "data"]);
        const { type } = config;
        if (typeof type !== "string" || !isEventType(type)) {
          return refuse(
            `Event \`${alias}\`'s type is 1 to ${sealedBuildLimits.eventTypeLength} characters on one line, with no control character and no space at either end.`
          );
        }
        return [
          checkedName(alias),
          { type, data: structuredClone(descriptorOf(config.data)) },
        ];
      }
    )
  );

/** A workflow permission's `decisions`, as data. */
const checkedDecisions = (
  decisions: unknown
): Record<string, BoundWorkflowDecision> =>
  Object.fromEntries(
    checkedRecord(
      decisions,
      "decisions",
      workflowReferenceLimits.decisions
    ).map(([alias, decision]) => {
      const config = checkedConfig(decision, ["value", "context"]);
      return [
        checkedName(alias),
        {
          value: structuredClone(descriptorOf(config.value)),
          context: structuredClone(descriptorOf(config.context)),
        },
      ];
    })
  );

/**
 * A workflow permission's `listens`, as data: each task's path with the
 * events of `events` it listens for, each once, in name order.
 */
const checkedListens = (
  listens: unknown,
  events: Readonly<Record<string, BoundWorkflowEvent>>
): Record<string, string[]> =>
  Object.fromEntries(
    checkedRecord(listens, "listen tasks", workflowReferenceLimits.listens).map(
      ([task, aliases]) => {
        if (
          task.length === 0 ||
          task.length > workflowReferenceLimits.taskPathLength ||
          !Array.isArray(aliases) ||
          aliases.length === 0 ||
          aliases.some(
            (alias) =>
              typeof alias !== "string" || !Object.hasOwn(events, alias)
          ) ||
          new Set(aliases).size !== aliases.length
        ) {
          return refuse(
            `Listen task \`${task.slice(0, 64)}\` listens for events the workflow declares, each once.`
          );
        }
        const listed: readonly string[] = aliases;
        return [task, listed.toSorted()];
      }
    )
  );

/**
 * Permission declarations. Each answers a frozen declaration
 * to list under its key of the App's `permissions`; the host binds it.
 */
export const permission = Object.freeze({
  /**
   * Answers from the workspace's model, each at most `maxOutputTokens`
   * long. An App holds one (`ctx.ai`).
   */
  ai: (config: AiConfig): AiPermission => {
    const checked = checkedConfig(config, ["maxOutputTokens"]);
    const { maxOutputTokens } = checked;
    if (
      typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 100_000
    ) {
      return refuse("`maxOutputTokens` is a whole number, 1 to 100 000.");
    }
    // SAFETY: built from what was checked, as `AiPermission` holds it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "ai",
      alias: permissionAliases.ai,
      maxOutputTokens,
    }) as AiPermission;
  },
  /** Some of a connection's actions, by its contract (`ctx.connections.<alias>`). */
  connection: <
    const Alias extends string,
    const Contract extends ConnectorContract,
    const Actions extends readonly [
      ConnectorAction<Contract>,
      ...ConnectorAction<Contract>[],
    ],
  >(
    alias: Alias,
    config: ConnectionConfig<Contract, Actions>
  ): ConnectionPermission<Alias, Contract, Actions> => {
    const checked = checkedConfig(config, ["contract", "actions"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "connections",
      alias: checkedAlias(alias),
      contract: checkedContract(checked.contract),
      actions: checkedActions(checked.actions),
    }) as ConnectionPermission<Alias, Contract, Actions>;
  },
  /**
   * The Brain, as the person each call acts for may read it, never more:
   * `operations: ["recall"]` (`ctx.brain.recall`). An App holds one.
   */
  brain: <
    const Operations extends readonly [BrainOperation, ...BrainOperation[]],
  >(
    config: BrainConfig<Operations>
  ): BrainPermission<Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: lists holding exactly the names given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "brain",
      alias: permissionAliases.brain,
      operations: known(
        checkedList(checked.operations, "operations", brainOperations),
        brainOperations
      ),
    }) as BrainPermission<Operations>;
  },
  /**
   * An independent workflow the App starts with `args`, a completed run
   * returning `returns`: listed
   * in the App's `permissions.workflows`, started by its actions and
   * staged by its mutations. Only ever what
   * the App's builders bind under the alias, started through the App's
   * own permission; never the engine.
   */
  workflow: <
    const Alias extends string,
    Args extends AnySchema,
    Returns extends AnySchema,
  >(
    alias: Alias,
    config: WorkflowConfig<Args, Returns>
  ): WorkflowPermission<Alias, InferInput<Args>, Infer<Returns>> => {
    const checked = checkedConfig(config, [
      "args",
      "returns",
      "events",
      "listens",
      "decisions",
    ]);
    const args = descriptorOf(checked.args);
    const returns = descriptorOf(checked.returns);
    // A start left without args takes the schema's default; args that may
    // be absent with none would be no JSON for the run to start with.
    if (args.presence === "optional") {
      refuse(
        "A workflow's args are required or have a default, never only optional."
      );
    }
    const events = checkedEvents(checked.events);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given and the schemas' descriptors.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredWorkflow({
      "~permission": "workflows",
      alias: checkedAlias(alias),
      // The descriptors, as data: what the host checks a start against.
      args: structuredClone(args),
      returns: structuredClone(returns),
      events,
      listens: checkedListens(checked.listens, events),
      decisions: checkedDecisions(checked.decisions),
    }) as WorkflowPermission<Alias, InferInput<Args>, Infer<Returns>>;
  },
  /**
   * The platform's own read-only functions (`graspFunctions`), such as the
   * runs of Apps' workflows. An App holds one (`ctx.grasp`); an admin
   * binds it to the platform's statistics permission they grant the App.
   */
  grasp: (): GraspPermission =>
    // SAFETY: built from the platform's own functions, each with the
    // descriptors of its arguments and return, as `GraspPermission` holds
    // them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    declared({
      "~permission": "grasp",
      alias: permissionAliases.grasp,
      functions: Object.fromEntries(
        Object.entries(graspFunctions).map(
          ([path, { kind, args, returns }]) => [
            path,
            {
              kind,
              args: structuredClone(descriptorOf(v.object(args))),
              returns: structuredClone(descriptorOf(returns)),
            },
          ]
        )
      ),
    }) as GraspPermission,
  /**
   * Guest chats, under a permission an admin binds: inviting a guest for
   * the person the call acts for, and listing, reading back and revoking
   * the App's chats. An App holds one (`ctx.guests`).
   */
  guests: <
    const Operations extends readonly [GuestsOperation, ...GuestsOperation[]],
  >(config: {
    readonly operations: Operations;
  }): GuestsPermission<Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the operations given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "guests",
      alias: permissionAliases.guests,
      operations: known(
        checkedList(checked.operations, "operations", guestsOperations),
        guestsOperations
      ),
    }) as GuestsPermission<Operations>;
  },
  /**
   * What the App's pages may do with files through the host: upload,
   * read, attach, delete. Never a function's.
   */
  files: <
    const Operations extends readonly [FilesOperation, ...FilesOperation[]],
  >(config: {
    readonly operations: Operations;
  }): FilesPermission<Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the operations given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~permission": "files",
      alias: permissionAliases.files,
      operations: known(
        checkedList(checked.operations, "operations", filesOperations),
        filesOperations
      ),
    }) as FilesPermission<Operations>;
  },
  /**
   * The exact HTTPS origins the App's pages may link to. It grants no
   * network access: a page still has none.
   */
  links: <const Origins extends readonly [string, ...string[]]>(config: {
    readonly origins: Origins;
  }): LinksPermission<Origins> => {
    const checked = checkedConfig(config, ["origins"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the origins given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~permission": "links",
      alias: permissionAliases.links,
      origins: checkedOrigins(checked.origins),
    }) as LinksPermission<Origins>;
  },
});
