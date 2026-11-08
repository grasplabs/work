import type {
  MemoryPack,
  SkillRead,
  SkillSelection,
  SkillsReadInput,
  SkillsSelectInput,
} from "@grasp-os/brain/contract";
import type {
  GuestChat,
  GuestInvitation,
  GuestInvite,
  GuestTranscript,
} from "@grasp-os/shared/guests";
import type { ResourceRecallInput } from "@grasp-os/shared/knowledge";

import type {
  ContractAction,
  HttpContract,
  HttpRequestInit,
} from "./connector-contracts.ts";
import type { GraspFunctions } from "./grasp-functions.ts";
import type {
  BrainOperation,
  BrainPermission,
  ConnectionPermission,
  GuestsOperation,
  GuestsPermission,
} from "./permission-types.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, ObjectInput, ValueShape } from "./value-types.ts";

/** One search result from the Brain: a title and an excerpt of it. */
export interface BrainHit {
  title: string;
  excerpt: string;
}

/** A document read from the Brain. */
export interface BrainDocument {
  title: string;
  text: string;
}

/** What `ctx.ai` is. */
export interface AiClient {
  /**
   * One answer to `prompt`, within the permission's token bound and the
   * App's budget: text, or a value of `output` when given, which the
   * model is told the shape of and the host checks the answer against.
   */
  readonly generate: <
    Output extends AnySchema | undefined = undefined,
  >(request: {
    readonly prompt: string;
    readonly instructions?: string;
    readonly output?: Output;
  }) => Promise<
    Output extends ValueSchema<unknown, unknown> ? Infer<Output> : string
  >;
}

/** A catalog action's arguments. */
type InputOf<Entry> = Entry extends { readonly input: infer Input }
  ? Input
  : never;

/**
 * A call's arguments: each action of `Action` paired with its own
 * arguments, so an action that may be either of two needs arguments that
 * fit whichever it is, never just one of them.
 */
type CallArgs<Contract, Action> = Action extends string
  ? [action: Action, args: InputOf<ContractAction<Contract, Action>>]
  : never;

/**
 * What `ctx.connections.<alias>` is: its calls typed by the contract's
 * catalog entry (`ConnectorCatalog`).
 */
export interface ConnectionClient<
  Contract extends string,
  Actions extends readonly string[],
> {
  /**
   * One of the declared actions, with its arguments, through connect: its
   * answer, or any of theirs when the action may be several. Both are
   * checked against the contract the binding serves.
   */
  readonly call: <Action extends Actions[number]>(
    ...call: CallArgs<Contract, Action>
  ) => Promise<ContractAction<Contract, Action>["output"]>;
}

/**
 * What `ctx.connections.<alias>` is for an HTTP connection: `call`, and
 * `fetch`, a request as the web's `fetch` makes one, to a path of the
 * connection's own origin, answered as a `Response`. A GET or HEAD is the
 * declaration's `get`; any other method its `send`, which the host may hold
 * for the person to confirm (`resource.awaiting_confirmation`).
 */
export interface HttpClient<
  Actions extends readonly string[],
> extends ConnectionClient<HttpContract, Actions> {
  readonly fetch: (path: string, init?: HttpRequestInit) => Promise<Response>;
}

/** What `ctx.brain` is, by its operations. */
export type BrainClient<Operations extends readonly BrainOperation[]> =
  ("search" extends Operations[number]
    ? {
        /**
         * The best matches for `text` in the declared collections: 1 to
         * `knowledgeSearchMaxLength` (500) code units, the Brain's own
         * limit; a longer text is refused as `contract.invalid_args`.
         */
        readonly search: (request: {
          readonly text: string;
          readonly limit?: number;
        }) => Promise<BrainHit[]>;
      }
    : unknown) &
    ("read" extends Operations[number]
      ? {
          /** One document of the declared collections, by its ID. */
          readonly read: (request: {
            readonly id: string;
          }) => Promise<BrainDocument>;
        }
      : unknown) &
    ("recall" extends Operations[number]
      ? {
          /**
           * The Brain's evidence for `query` from the declared collections,
           * or those `collections` names of them, as far as the person may
           * read each: a bounded memory pack, each item cited at its exact
           * version. Needs the Brain's permission too.
           */
          readonly recall: (
            request: ResourceRecallInput
          ) => Promise<MemoryPack>;
        }
      : unknown) &
    ("skillsSelect" extends Operations[number]
      ? {
          /**
           * The skill of the declared collections the person may read
           * that applies to `request.task`, pinned at the version read,
           * or an explicit no-skill result. Keep the pin for the task.
           * Needs the Brain's permission too.
           */
          readonly skillsSelect: (
            request: SkillsSelectInput
          ) => Promise<SkillSelection>;
        }
      : unknown) &
    ("skillsRead" extends Operations[number]
      ? {
          /**
           * A skill of the declared collections at exactly the version a
           * selection pinned, while the person may read it: its text is
           * data. Needs the Brain's permission too.
           */
          readonly skillsRead: (request: SkillsReadInput) => Promise<SkillRead>;
        }
      : unknown);

/** What `ctx.guests` is, by its operations. */
export type GuestsClient<Operations extends readonly GuestsOperation[]> =
  ("invite" extends Operations[number]
    ? {
        /**
         * Invites a guest, for the person the call acts for: only a
         * person's own call, never a workflow run's. The answer holds the
         * link, shown once.
         */
        readonly invite: (invite: GuestInvite) => Promise<GuestInvitation>;
      }
    : unknown) &
    ("list" extends Operations[number]
      ? {
          /** The App's guest chats: the open ones first, newest first. */
          readonly list: () => Promise<GuestChat[]>;
        }
      : unknown) &
    ("read" extends Operations[number]
      ? {
          /** A guest chat of the App, with what was written: untrusted text. */
          readonly read: (id: string) => Promise<GuestTranscript>;
        }
      : unknown) &
    ("revoke" extends Operations[number]
      ? {
          /** Stops a guest chat's link for good. */
          readonly revoke: (id: string) => Promise<GuestChat>;
        }
      : unknown);

/**
 * A call's arguments: each path of `Path` paired with its own arguments,
 * so a path that may be either of two needs arguments that fit whichever
 * it is, never just one of them.
 */
type FunctionCallArgs<
  Functions extends Readonly<
    Record<string, { readonly args: ValueShape; readonly returns: AnySchema }>
  >,
  Path,
> =
  Path extends Extract<keyof Functions, string>
    ? [path: Path, args: ObjectInput<Functions[Path]["args"]>]
    : never;

/**
 * What `ctx.grasp` is: each of the platform's functions by its path, with
 * its arguments, answering its return.
 */
export interface GraspClient {
  readonly call: <Path extends Extract<keyof GraspFunctions, string>>(
    ...call: FunctionCallArgs<GraspFunctions, Path>
  ) => Promise<Infer<GraspFunctions[Path]["returns"]>>;
}

/** What `ctx.connections.<alias>` is for `Permission`. */
export type ConnectionClientOf<Permission> =
  Permission extends ConnectionPermission<string, infer Contract, infer Actions>
    ? Contract extends HttpContract
      ? HttpClient<Actions>
      : ConnectionClient<Contract, Actions>
    : never;

/** What `ctx.brain` is for `Permission`. */
export type BrainClientOf<Permission> =
  Permission extends BrainPermission<infer Operations>
    ? BrainClient<Operations>
    : never;

/** What `ctx.guests` is for `Permission`. */
export type GuestsClientOf<Permission> =
  Permission extends GuestsPermission<infer Operations>
    ? GuestsClient<Operations>
    : never;
