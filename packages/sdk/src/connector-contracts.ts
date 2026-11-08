import type { ConnectorCatalog } from "./connector-catalog.gen.ts";
import type { JsonValue } from "./value-descriptor.ts";

/**
 * A Composio connection's generated contract, `composio.<toolkit>@1`: the
 * tools its admin allowed, each an action named by its tool, such as
 * `HUBSPOT_LIST_CONTACTS`. Composio changes its toolkits without a release
 * of Grasp, so they aren't in the release's catalog and their calls aren't
 * typed (`ComposioCall`): the host checks each one, both ways, against the
 * contract the binding pinned when an admin approved it.
 */
export type ComposioContract = `composio.${string}@1`;

/**
 * An outside API an admin approved as an HTTP connection (GRA-1478): its
 * one origin, the paths and methods it allows, and its credential, which
 * connect adds and nobody else sees. Its actions are `get` (a read: GET or
 * HEAD) and `send` (POST, PUT, PATCH or DELETE, a change a person confirms
 * where they are there); its client also has `fetch`, which picks the
 * action by the method. The same as `httpContract` in
 * `@grasp-os/shared/http-connections`.
 */
export type HttpContract = "http.request@1";

/** An HTTP connection's contract, for `permission.connection`. */
export const httpContract: HttpContract = "http.request@1";

/** The headers a request sets: never its credential, which connect adds. */
type HttpHeaders = Readonly<Record<string, string>>;

/** What an HTTP connection's request answers: never redirected off it. */
export interface HttpAnswer {
  readonly status: number;
  readonly headers: HttpHeaders;
  /** The response's text: at most 512 KiB. */
  readonly body: string;
}

/** An HTTP connection's actions, as `call` takes them. */
interface HttpActions {
  readonly get: {
    readonly input: {
      readonly method?: "GET" | "HEAD";
      /** The path and query, starting with `/`, under an allowed prefix. */
      readonly path: string;
      readonly headers?: HttpHeaders;
    };
    readonly output: HttpAnswer;
  };
  readonly send: {
    readonly input: {
      readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly headers?: HttpHeaders;
      /** At most 48 KiB of text, such as `JSON.stringify(value)`. */
      readonly body?: string;
    };
    readonly output: HttpAnswer;
  };
}

/** What `fetch` of an HTTP connection's client takes besides its path. */
export interface HttpRequestInit {
  readonly method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: HttpHeaders;
  readonly body?: string;
}

/**
 * A generated connector contract (spec 12): a native connector's tools of
 * one family, such as `microsoft-365.mail@1`, from this release's catalog;
 * a Composio toolkit's (`ComposioContract`); or an HTTP connection's
 * (`HttpContract`).
 */
export type ConnectorContract =
  | Extract<keyof ConnectorCatalog, string>
  | ComposioContract
  | HttpContract;

/**
 * The actions of connector contract `Contract`, by name: any name for a
 * Composio contract, whose tools only its binding knows.
 */
export type ConnectorAction<Contract extends ConnectorContract> =
  Contract extends keyof ConnectorCatalog
    ? Extract<keyof ConnectorCatalog[Contract], string>
    : Contract extends HttpContract
      ? keyof HttpActions
      : string;

/**
 * A Composio action's arguments and answer: any JSON object in, any JSON
 * value back, both checked by the host against the pinned contract. A tool
 * that declares no output schema answers its text, as a string.
 */
export interface ComposioCall {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly output: JsonValue;
}

/**
 * Action `Action` of contract `Contract`: its `input`, the arguments a
 * call passes, and its `output`, the answer it gets back.
 */
export type ContractAction<Contract, Action> =
  Contract extends keyof ConnectorCatalog
    ? Action extends keyof ConnectorCatalog[Contract]
      ? ConnectorCatalog[Contract][Action]
      : never
    : Contract extends HttpContract
      ? Action extends keyof HttpActions
        ? HttpActions[Action]
        : never
      : Contract extends ComposioContract
        ? ComposioCall
        : never;
