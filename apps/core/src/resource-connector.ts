import type { HeldBinding } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { ConnectionId, PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import type { PermissionObject } from "@grasp-os/shared/permissions";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { signedCall } from "./bindings.ts";
import { readContractSchema } from "./connector-contracts.ts";
import type { ReadSchema } from "./connector-contracts.ts";
import { permissions } from "./db/core/schema.ts";
import type { ResourceContext } from "./operations.ts";
import {
  isProviderUnreachable,
  providerUnreachable,
  unchecked,
} from "./resource-adapter.ts";
import type {
  BindingCaller,
  ContractAsks,
  DeclarationOf,
  ResourceAdapter,
} from "./resource-adapter.ts";

// A connector resource (spec 12, 32.3): the declared actions of a
// generated connector contract, on one of the App's own connection
// permissions, through connect. Every request:
//
// - is checked against the contract's argument descriptor before connect
//   sees it, and sends the normalized arguments;
// - goes through `signedCall`, so the permission is checked again (active,
//   allowing exactly this tool, and for an action that changes things, a
//   version an admin approved) and connect gets a capability for this one
//   call, carrying the App's restricted mode and the invocation's
//   deadline; the person's own connection stays theirs alone (connect);
// - carries the host's derived idempotency key, so the same call made
//   again replays connect's stored answer instead of a second effect, and
//   an outcome connect couldn't confirm stays `effect.outcome_unknown`;
// - is held by connect for the person when it has a side effect and the
//   person is there (or the App read restricted data): App code gets
//   `resource.awaiting_confirmation`, and the same call made again finds
//   the same held action, or its answer once the person confirmed it;
// - has its answer checked against the contract's return descriptor, and
//   must already be in its normalized form.
//
// No token, capability or connection detail ever reaches App code.

type ConnectionObject = Extract<PermissionObject, { type: "connection" }>;

/** One of the App's connection permissions, as a binding reads it. */
interface ConnectionGrant {
  readonly permissionId: PermissionId;
  readonly connection: ConnectionObject;
  readonly actions: readonly string[];
}

const actionsSchema = z.array(z.string());

/**
 * The App's own active permission `permissionId` on a connection, not a
 * chat's; undefined for any other.
 */
const connectionGrant = async (
  env: Env,
  app: string,
  permissionId: PermissionId
): Promise<ConnectionGrant | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      connectionId: permissions.objectId,
      resource: permissions.resource,
      actions: permissions.actions,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, permissionId),
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, "connection"),
        eq(permissions.status, "active"),
        isNull(permissions.chatId)
      )
    )
    .get();
  if (row === undefined) {
    return undefined;
  }
  const actions = actionsSchema.safeParse(JSON.parse(row.actions));
  return actions.success
    ? {
        permissionId: permissionIdSchema.parse(permissionId),
        connection: {
          type: "connection",
          connectionId: connectionIdSchema.parse(row.connectionId),
          ...(row.resource === null ? {} : { resource: row.resource }),
        },
        actions: actions.data,
      }
    : undefined;
};

/** One declared action, as its contract describes it now. */
interface BoundAction {
  readonly raw: ConnectorContractAction;
  readonly args: ReadSchema;
  readonly returns: ReadSchema;
}

/** What connect says a connection serves of `contract`, if it serves it. */
const contractOf = async (
  env: Env,
  contract: string,
  connectionId: ConnectionId
): Promise<ConnectorContract | undefined> => {
  try {
    const served: ConnectorContract = await env.CONNECT.connectorContract({
      contract,
      connectionId,
    });
    return served;
  } catch (error) {
    const code = connectErrors.codeOf(error);
    // A Composio server that can't be reached to list the contract:
    // nothing is checked against a contract no one could read, and nothing
    // is known to have changed, so this request alone is refused.
    if (code === "connect.server_unavailable") {
      throw providerUnreachable();
    }
    // A contract ID connect can't read names no connector of its own.
    if (code !== "connect.contract_not_found" && code !== "connect.invalid") {
      throw error;
    }
  }
  return undefined;
};

/**
 * Each action `declaration` lists, as the contract describes it now, if
 * the contract has it, its schemas can be read, and the grant allows its
 * tool; undefined if any of them can't be bound.
 */
const boundActions = (
  declaration: DeclarationOf<"connector">,
  served: Readonly<Record<string, ConnectorContractAction>>,
  grant: ConnectionGrant
): Map<string, BoundAction> | undefined => {
  const bound = new Map<string, BoundAction>();
  for (const name of declaration.actions) {
    const raw = Object.hasOwn(served, name) ? served[name] : undefined;
    const args = raw === undefined ? undefined : readContractSchema(raw.input);
    const returns =
      raw === undefined ? undefined : readContractSchema(raw.output);
    if (
      raw === undefined ||
      args === undefined ||
      returns === undefined ||
      !grant.actions.includes(raw.tool)
    ) {
      return undefined;
    }
    bound.set(name, { raw, args, returns });
  }
  return bound;
};

/** One of the App's active connection permissions, as its row reads. */
export interface ConnectionGrantRow {
  readonly id: string;
  readonly objectId: string;
  readonly resource: string | null;
  readonly actions: string;
}

/** `row` as a binding reads it; undefined when its actions don't read. */
const grantOf = (row: ConnectionGrantRow): ConnectionGrant | undefined => {
  const actions = actionsSchema.safeParse(JSON.parse(row.actions));
  const permissionId = permissionIdSchema.safeParse(row.id);
  const connectionId = connectionIdSchema.safeParse(row.objectId);
  return actions.success && permissionId.success && connectionId.success
    ? {
        permissionId: permissionId.data,
        connection: {
          type: "connection",
          connectionId: connectionId.data,
          ...(row.resource === null ? {} : { resource: row.resource }),
        },
        actions: actions.data,
      }
    : undefined;
};

/**
 * What a connection serves of `contract`, for a review: `unchecked` when
 * its provider can't be reached (a Composio server that is down), so one
 * outage marks only what depends on that connection, and never fails the
 * whole review. A request still refuses it (`contractOf`).
 */
const reviewedContractOf = async (
  env: Env,
  contract: string,
  connectionId: ConnectionId
): Promise<ConnectorContract | undefined | typeof unchecked> => {
  try {
    return await contractOf(env, contract, connectionId);
  } catch (error) {
    if (isProviderUnreachable(error)) {
      return unchecked;
    }
    throw error;
  }
};

/**
 * Asks connect what connections serve, for one review of an App's
 * resources: each connection's contract at most once, however many
 * declarations or permissions name it, and at most `limit` asks in all.
 * `truncated` says whether the limit left something unasked. A connection
 * whose provider can't be reached is `unchecked` (`reviewedContractOf`).
 */
export const contractReader = (env: Env, limit: number) => {
  const asked = new Map<
    string,
    Promise<ConnectorContract | undefined | typeof unchecked>
  >();
  let truncated = false;
  const asks: ContractAsks = {
    contractOf: async (connectionId, contract) => {
      const key = JSON.stringify([connectionId, contract]);
      let served = asked.get(key);
      if (served === undefined) {
        if (asked.size >= limit) {
          truncated = true;
          return unchecked;
        }
        served = reviewedContractOf(env, contract, connectionId);
        asked.set(key, served);
      }
      return await served;
    },
  };
  return {
    /** For the adapter's bind, within the same review. */
    asks,
    /**
     * Whether `row`, already read as one of the App's active connection
     * permissions, binds `declaration` exactly as the adapter would: its
     * connection serves the declared contract and the permission allows
     * the tool of every declared action. Undefined when the limit left it
     * unasked.
     */
    serves: async (
      row: ConnectionGrantRow,
      declaration: DeclarationOf<"connector">
    ): Promise<boolean | undefined> => {
      const grant = grantOf(row);
      if (grant === undefined) {
        return false;
      }
      const contract = await asks.contractOf(
        grant.connection.connectionId,
        declaration.contract
      );
      if (contract === unchecked) {
        return undefined;
      }
      return (
        contract !== undefined &&
        boundActions(declaration, contract.actions, grant) !== undefined
      );
    },
    /** Whether the limit left something unasked. */
    truncated: (): boolean => truncated,
  };
};

export type ContractReader = ReturnType<typeof contractReader>;

/**
 * `value` as `read` normalizes it, if it fits the descriptor and every
 * constraint of the contract's JSON Schema, and, when `exact`, is already
 * in that form; undefined otherwise.
 */
const checked = (
  read: ReadSchema,
  value: unknown,
  exact: boolean
): Json | undefined => {
  const result = read.schema["~standard"].validate(value);
  if ("then" in result || result.issues !== undefined) {
    return undefined;
  }
  const normalized = jsonOf(result.value);
  const given = jsonOf(value);
  if (
    normalized === undefined ||
    !read.accepts(normalized) ||
    (exact &&
      (given === undefined ||
        canonicalJson(normalized) !== canonicalJson(given)))
  ) {
    return undefined;
  }
  return normalized;
};

/** What a refusal of connect's means to App code, from an allow-list. */
const refusalOf = (error: unknown): unknown => {
  const code = connectErrors.codeOf(error);
  if (
    code === "connect.connection_not_found" ||
    code === "connect.connection_inactive" ||
    code === "connect.not_owner" ||
    code === "connect.action_not_found"
  ) {
    return operationErrors.create("resource.unavailable");
  }
  if (code === "connect.declined") {
    return operationErrors.create("resource.declined");
  }
  if (code === "connect.idempotency_conflict") {
    return operationErrors.create("resource.idempotency_conflict");
  }
  return error;
};

/** One request of a connector resource, through connect. */
const callAction = async (
  env: Env,
  caller: BindingCaller,
  grant: ConnectionGrant,
  actions: ReadonlyMap<string, BoundAction>,
  args: readonly Json[],
  context: ResourceContext,
  pin: HeldBinding
): Promise<Json> => {
  const [name, input] = args;
  const action = typeof name === "string" ? actions.get(name) : undefined;
  if (action === undefined) {
    throw operationErrors.create("resource.not_allowed");
  }
  const sent = checked(action.args, input, false);
  if (sent === undefined) {
    throw operationErrors.create("resource.invalid_args");
  }
  let answered: Awaited<ReturnType<Env["CONNECT"]["call"]>>;
  try {
    const { capability, scope } = await signedCall(
      env,
      {
        authority: caller.authority,
        context: caller.context,
        connection: grant.connection,
        permissionId: grant.permissionId,
        notAfter: context.deadline,
        binding: pin,
      },
      { action: action.raw.tool, idempotencyKey: context.idempotencyKey }
    );
    answered = await env.CONNECT.call({ capability, ...scope, input: sent });
  } catch (error) {
    throw refusalOf(error);
  }
  if (answered.pending !== undefined) {
    throw operationErrors.create("resource.awaiting_confirmation");
  }
  caller.sources.noteConnection(
    grant.connection.connectionId,
    answered.provenance
  );
  let output: unknown;
  try {
    output = JSON.parse(answered.output);
  } catch {
    throw operationErrors.create("contract.invalid_resource_result");
  }
  const answer = checked(action.returns, output, true);
  if (answer === undefined) {
    throw operationErrors.create("contract.invalid_resource_result");
  }
  return answer;
};

/** The fingerprint of the declared actions only, as served now. */
const fingerprintOf = async (
  contract: string,
  actions: ReadonlyMap<string, BoundAction>
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      contract,
      // A change to another action of the family is no drift of this
      // binding's contract.
      actions: Object.fromEntries(
        [...actions].map(([name, { raw }]) => [name, { ...raw }])
      ),
    })
  );

export const connectorAdapter: ResourceAdapter<"connector"> = {
  bind: async (env, app, declaration, target, asks) => {
    const grant = await connectionGrant(env, app, target.permissionId);
    const { connectionId } = grant?.connection ?? {};
    // A review shares and bounds what it asks connect; a request asks live.
    const answered =
      connectionId === undefined
        ? undefined
        : await (asks === undefined
            ? contractOf(env, declaration.contract, connectionId)
            : asks.contractOf(connectionId, declaration.contract));
    if (answered === unchecked) {
      return unchecked;
    }
    const served = answered;
    const actions =
      grant === undefined || served === undefined
        ? undefined
        : boundActions(declaration, served.actions, grant);
    const fingerprint =
      actions === undefined
        ? undefined
        : await fingerprintOf(declaration.contract, actions);
    return grant === undefined ||
      actions === undefined ||
      fingerprint === undefined
      ? undefined
      : {
          contractId: declaration.contract,
          fingerprint,
          tools: [...actions.values()].map(({ raw }) => raw.tool),
          call: async (caller, { args }, context, pin) =>
            await callAction(env, caller, grant, actions, args, context, pin),
        };
  },
};
