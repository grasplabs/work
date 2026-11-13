import type {
  GuestChat,
  GuestInvitation,
  GuestInvite,
  GuestTranscript,
} from "@grasp-os/shared/guests";
import type { HttpContract } from "@grasp-os/shared/http-contract";

import type { BrainPack, BrainRecall } from "./brain-recall.ts";
import type { ContractAction, HttpRequestInit } from "./connector-contracts.ts";
import type { GraspFunctions } from "./grasp-functions.ts";
import type { MemberName } from "./member-names.ts";
import type {
  BrainOperation,
  BrainPermission,
  ConnectionPermission,
  GuestsOperation,
  GuestsPermission,
} from "./permission-types.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, ObjectInput } from "./value-types.ts";

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

/**
 * What `ctx.connections.<alias>` is: each declared action as a member of
 * its own (`MemberName`), taking that action's arguments and answering
 * its answer, as the contract's catalog entry types them
 * (`ConnectorCatalog`; any JSON for a Composio tool). Connect checks both
 * against the contract the binding serves. An action the permission
 * doesn't declare isn't a member.
 */
export type ConnectionClient<
  Contract extends string,
  Actions extends readonly string[],
> = {
  readonly [Action in Actions[number] as MemberName<Action>]: (
    args: ContractAction<Contract, Action>["input"]
  ) => Promise<ContractAction<Contract, Action>["output"]>;
};

/** The methods an HTTP connection's declared `Actions` allow. */
type HttpMethodOf<Actions extends readonly string[]> =
  | ("get" extends Actions[number] ? "GET" | "HEAD" : never)
  | ("send" extends Actions[number]
      ? "POST" | "PUT" | "PATCH" | "DELETE"
      : never);

/**
 * What `ctx.connections.<alias>` is for an HTTP connection: `fetch`, a
 * request as the web's `fetch` makes one, to a path of the connection's
 * own origin, answered as a `Response`. A GET or HEAD (the default) is
 * the declaration's `get`; any other method its `send`, which the host
 * may hold for the person to confirm (`permission.awaiting_confirmation`).
 * Only the methods its declared actions allow type-check: without `get`,
 * the method is required.
 */
export interface HttpClient<Actions extends readonly string[]> {
  readonly fetch: "get" extends Actions[number]
    ? (
        path: string,
        init?: HttpRequestInit<HttpMethodOf<Actions>>
      ) => Promise<Response>
    : (
        path: string,
        init: HttpRequestInit<HttpMethodOf<Actions>> & {
          readonly method: HttpMethodOf<Actions>;
        }
      ) => Promise<Response>;
}

/** What `ctx.brain` is, by its operations. */
export type BrainClient<Operations extends readonly BrainOperation[]> =
  "recall" extends Operations[number]
    ? {
        /**
         * What the person the call acts for may read that answers
         * `request.question`, within its budget: the same pack a
         * workflow's step and a chat's code get.
         */
        readonly recall: (request: BrainRecall) => Promise<BrainPack>;
      }
    : unknown;

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

/** The paths of the platform's functions: `<namespace>.<function>`. */
type GraspPath = Extract<keyof GraspFunctions, string>;

/** The namespace of path `Path`: what comes before its first `.`. */
type GraspNamespace<Path> = Path extends `${infer Namespace}.${string}`
  ? Namespace
  : never;

/**
 * What `ctx.grasp` is: each of the platform's functions as a member of
 * its namespace, `statistics.read` as `ctx.grasp.statistics.read(args)`,
 * taking its arguments and answering its return.
 */
export type GraspClient = {
  readonly [Namespace in GraspNamespace<GraspPath>]: {
    readonly [
      Path in GraspPath as Path extends `${Namespace}.${infer Name}`
        ? Name
        : never
    ]: (
      args: ObjectInput<GraspFunctions[Path]["args"]>
    ) => Promise<Infer<GraspFunctions[Path]["returns"]>>;
  };
};

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
