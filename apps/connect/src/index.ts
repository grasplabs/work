import type { OutboxedAuditEvent } from "@grasp-os/shared/audit";
import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import {
  confirmActionSchema,
  connectCallSchema,
  connectErrors,
  declineActionSchema,
  heldOutcomeRequestSchema,
  markTaken,
} from "@grasp-os/shared/connect";
import type {
  Catalog,
  CatalogLogo,
  CatalogTool,
  ConnectorContract,
  ConnectApi,
  ConnectCall,
  ConnectionOwner,
  ConnectionPerson,
  ConnectionSummary,
  ConnectResult,
  Disconnect,
  DisconnectPersonal,
  FinishConnection,
  HeldCall,
  HeldOutcome,
  OutboxedConnectorEvent,
  PendingAction,
  StartConnection,
  ConnectWithKey,
  StartToolkitConnection,
  UnknownOutcome,
  UnknownOutcomeListing,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import type {
  LandscapeConnection,
  LandscapeRead,
} from "@grasp-os/shared/landscape";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  NpmAdvisories,
  NpmMalwareReports,
  NpmMetadata,
} from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";

import { ackAuditEvents, auditCall, takeAuditEvents } from "./audit.ts";
import type { CallOutcome, CallRecord } from "./audit.ts";
import { carryOut, connectionFor, heldOutcome } from "./call.ts";
import type { CallDone, CallProgress } from "./call.ts";
import { catalog, catalogTools } from "./catalog.ts";
import { clock, tickClock } from "./clock.ts";
import {
  finishToolkitFlow,
  startToolkitConnection,
} from "./composio-connections.ts";
import { connectionOwners } from "./connections.ts";
import { connectorContract } from "./contracts.ts";
import { requireDecision } from "./decisions.ts";
import {
  ackConnectorEvents,
  syncEventSources,
  takeConnectorEvents,
} from "./events.ts";
import { landscapeConnections, readLandscape } from "./landscape.ts";
import { catalogLogo } from "./logos.ts";
import {
  npmAdvisories,
  npmMalwareReports,
  npmMetadata,
  npmTarball,
} from "./npm.ts";
import {
  abandonFlow,
  connectWithKey,
  disconnect,
  disconnectPersonal,
  finishConnection,
  listConnections,
  startConnection,
} from "./oauth.ts";
import {
  listAllUnknownOutcomes,
  listUnknownOutcomes,
  refuseResolution,
  resolveOutcome,
  unknownOutcomeFor,
  unresolvedUnder,
} from "./outcomes.ts";
import {
  anyPending,
  auditRefusedDecision,
  callOf,
  decidedCallOf,
  dropForEndedRun,
  dropForBinding,
  dropForEndedRuns,
  dropStaleBinding,
  heldFor,
  declineChatActions,
  heldCall,
  listPendingActions,
  pendingActionFor,
  refuseConfirmation,
  take,
} from "./pending.ts";
import type { HeldAction } from "./pending.ts";

// The egress handler of native connectors' isolates (src/connectors.ts).
export { ConnectorEgress } from "./egress.ts";

/**
 * The keys a capability may be made with: the current, then the previous.
 *
 * Rotating the signing key: set the old one as
 * `CAPABILITY_SIGNING_KEY_PREVIOUS` on connect, then the new one as
 * `CAPABILITY_SIGNING_KEY` on connect and core (core always signs with the
 * current key), then remove the previous one. Optional, so it isn't in
 * `secrets.required`.
 */
const signingKeys = (env: Env): string[] =>
  [env.CAPABILITY_SIGNING_KEY, env.CAPABILITY_SIGNING_KEY_PREVIOUS].filter(
    (key): key is string => typeof key === "string" && key !== ""
  );

/** How a call that threw ended, for the audit log. */
const outcomeOf = (code: string | undefined): CallOutcome => {
  switch (code) {
    case "connect.outcome_unknown": {
      return "unknown";
    }
    case "connect.action_failed":
    case "connect.server_unavailable":
    case undefined: {
      return "failed";
    }
    default: {
      return "refused";
    }
  }
};

/**
 * Records a call that didn't go through. If even that fails, it is logged:
 * the caller learns why its call failed, not why its event did.
 */
const auditFailure = async (env: Env, record: CallRecord): Promise<void> => {
  try {
    await auditCall(env, record);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/** How a call that returned ended, for the audit log. */
const callOutcome = ({
  failed,
  replayed,
  pending,
  reconciled,
}: CallDone): CallOutcome => {
  if (pending !== undefined) {
    return "held";
  }
  // Recovered by finding the effect: the original's answer, not a send.
  if (reconciled === true) {
    return "reconciled";
  }
  if (replayed) {
    return "replayed";
  }
  return failed ? "failed" : "ok";
};

type StatedCall = Omit<ConnectCall, "capability" | "input">;

/** The call as the audit log states it: never its input. */
const statedOf = ({
  input: _input,
  ...stated
}: Omit<ConnectCall, "capability">): StatedCall => stated;

/** An expected error's details, such as a `retryAfterSeconds`, if any. */
const detailsOf = (error: unknown): ErrorPayload["details"] =>
  isExpectedError(error) ? error.details : undefined;

/**
 * `connect.outcome_unknown`, with `details`: a native connector's marked
 * as waiting for its person to resolve it (`awaitsResolution`), so a
 * workflow run waits on it. A Composio tool's error, whose text nobody is
 * shown yet, fails the run's step instead.
 */
const unknownOutcome = (
  progress: CallProgress,
  details?: ErrorPayload["details"]
): Error =>
  connectErrors.create(
    "connect.outcome_unknown",
    progress.native === true ? { ...details, awaitsResolution: true } : details
  );

const codeOf = (error: unknown): string | undefined =>
  connectErrors.codeOf(error) ?? capabilityErrors.codeOf(error);

/**
 * The connector layer. Every external call from agents, Apps and the
 * knowledge indexer passes through here: scoped, approved, logged.
 *
 * Only core reaches it, over its service binding; it has no route and no
 * public address. Even so it trusts no call on its own: each one carries a
 * capability core made for exactly that call, and connect checks it first.
 * Every call goes into the audit log, refused ones too.
 */
export { Clock } from "./clock.ts";

export default class Connect
  extends WorkerEntrypoint<Env>
  implements ConnectApi
{
  // oxlint-disable-next-line class-methods-use-this -- the Worker's fetch handler
  override fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Every minute: the clock's explicit tick (src/clock.ts), which drops
   * OAuth and Composio flows nobody finished, deletes at Composio what
   * earlier tries couldn't, and seals what a rotated key sealed again.
   */
  override async scheduled(controller?: ScheduledController): Promise<void> {
    try {
      await tickClock(
        this.env,
        this.ctx,
        controller?.scheduledTime ?? Date.now()
      );
    } catch (error) {
      log.error("cron.failed", errorFields(error));
    }
  }

  /**
   * Arms connect's clock if nothing has: core's clock asks every minute
   * (core's src/clock.ts), the repair path that starts it on a new
   * deployment and after anything cleared its alarm.
   */
  async ensureClock(): Promise<void> {
    await clock(this.env).ensure();
  }

  // The audit outbox (src/audit.ts). Core's cron trigger takes the events
  // connect recorded, appends them to the audit log, then acknowledges them,
  // with those the log can't take, which connect moves aside.

  async takeAuditEvents(): Promise<OutboxedAuditEvent[]> {
    return await takeAuditEvents(this.env);
  }

  async ackAuditEvents(appended: unknown, rejected?: unknown): Promise<void> {
    await ackAuditEvents(this.env, appended, rejected);
  }

  // Connector events (src/events.ts). Core's cron trigger sends who
  // listens where, then takes the events read, delivers them to workflows,
  // and settles them.

  async syncEventSources(listeners: unknown): Promise<void> {
    await syncEventSources(this.env, listeners);
  }

  async takeConnectorEvents(): Promise<OutboxedConnectorEvent[]> {
    return await takeConnectorEvents(this.env);
  }

  async ackConnectorEvents(ack: unknown): Promise<void> {
    await ackConnectorEvents(this.env, ack);
  }

  // Connecting accounts (src/oauth.ts). Core calls these for a signed-in
  // person, whom it names; none of them returns a token.

  async startConnection(request: StartConnection): Promise<{ url: string }> {
    return await startConnection(this.env, request);
  }

  async finishConnection(
    request: FinishConnection
  ): Promise<{ connectionId: string; returnTo: string }> {
    return (
      (await finishToolkitFlow(this.env, request)) ??
      (await finishConnection(this.env, request))
    );
  }

  async connectWithKey(
    request: ConnectWithKey
  ): Promise<{ connectionId: string }> {
    return await connectWithKey(this.env, request);
  }

  async listConnections(
    person: ConnectionPerson
  ): Promise<ConnectionSummary[]> {
    return await listConnections(this.env, person);
  }

  async connectionOwners(
    connectionIds: readonly string[]
  ): Promise<ConnectionOwner[]> {
    return await connectionOwners(this.env.DB, connectionIds);
  }

  async disconnect(request: Disconnect): Promise<{ revoked: boolean }> {
    return await disconnect(this.env, request);
  }

  async disconnectPersonal(
    request: DisconnectPersonal
  ): Promise<{ disconnected: number }> {
    return await disconnectPersonal(this.env, request);
  }

  async abandonFlow(state: string): Promise<void> {
    await abandonFlow(this.env, state);
  }

  // Connecting a Composio toolkit (src/composio-connections.ts), for an
  // admin who consented; `finishConnection` finishes it.

  async startToolkitConnection(
    request: StartToolkitConnection
  ): Promise<{ url: string }> {
    return await startToolkitConnection(this.env, request);
  }

  // The npm registry (src/npm.ts): a package's metadata, and one
  // version's tarball by its integrity hash, for core to resolve and
  // unpack. Public data; nothing here is a client's.

  // RPC exposes prototype methods only, so these can't be static.
  // oxlint-disable-next-line class-methods-use-this
  async npmMetadata(name: unknown): Promise<NpmMetadata> {
    return await npmMetadata(name);
  }

  // oxlint-disable-next-line class-methods-use-this
  async npmTarball(request: unknown): Promise<Uint8Array> {
    return await npmTarball(request);
  }

  // oxlint-disable-next-line class-methods-use-this
  async npmAdvisories(request: unknown): Promise<NpmAdvisories> {
    return await npmAdvisories(request);
  }

  // oxlint-disable-next-line class-methods-use-this
  async npmMalwareReports(request: unknown): Promise<NpmMalwareReports> {
    return await npmMalwareReports(request);
  }

  // The catalog (src/catalog.ts): what can be connected.

  async catalog(): Promise<Catalog> {
    return await catalog(this.env);
  }

  async catalogTools(request: unknown): Promise<CatalogTool[]> {
    return await catalogTools(this.env, request);
  }

  async catalogLogo(request: unknown): Promise<CatalogLogo | null> {
    return await catalogLogo(this.env, request);
  }

  // The application landscape (src/landscape.ts): for core's sync only.

  async landscapeConnections(): Promise<LandscapeConnection[]> {
    return await landscapeConnections(this.env);
  }

  async readLandscape(request: unknown): Promise<LandscapeRead> {
    return await readLandscape(this.env, request);
  }

  // Generated connector contracts (src/contracts.ts): what an App's
  // connector resource is bound to and checked against.

  async connectorContract(request: unknown): Promise<ConnectorContract> {
    return await connectorContract(this.env, request);
  }

  // Held actions (src/pending.ts). Core names the person from their
  // session; only they see and decide what waits for them.

  async listPendingActions(person: ConnectionPerson): Promise<PendingAction[]> {
    return await listPendingActions(this.env, person);
  }

  async refuseConfirmation(request: unknown): Promise<void> {
    await refuseConfirmation(this.env, request);
  }

  async pendingAction(request: unknown): Promise<PendingAction | null> {
    return await pendingActionFor(this.env, request);
  }

  async heldCall(request: unknown): Promise<HeldCall> {
    return await heldCall(this.env, request);
  }

  /**
   * How a held call ended, for a caller with core's capability for that
   * call, checked as `call` checks one. Recorded as a call is, refused
   * ones too: what it hands over as a repeat's answer (`replayed`), with
   * what that read; still waiting as `held`; declined, or not ended well,
   * as refused or failed with why.
   */
  async heldOutcome(request: unknown): Promise<HeldOutcome> {
    const parsed = heldOutcomeRequestSchema.safeParse(request);
    if (!parsed.success) {
      await auditFailure(this.env, {
        outcome: "refused",
        reason: "connect.invalid",
      });
      throw connectErrors.create("connect.invalid");
    }
    const { capability, ...call } = parsed.data;
    let claims: CapabilityClaims | undefined;
    let read: Awaited<ReturnType<typeof heldOutcome>>;
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      requireDecision(claims);
      read = await heldOutcome(this.env, claims);
    } catch (error) {
      const reason = codeOf(error);
      await auditFailure(this.env, {
        call,
        claims,
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
      });
      throw error;
    }
    const { outcome, pendingActionId } = read;
    const ended = { call, claims, sideEffect: true, pendingActionId };
    if (outcome.state === "done") {
      await auditCall(this.env, {
        ...ended,
        outcome: "replayed",
        replayed: true,
        provenance: outcome.result.provenance,
      });
    } else if (outcome.state === "waiting") {
      await auditCall(this.env, { ...ended, outcome: "held" });
    } else {
      const reason =
        outcome.state === "declined" ? "connect.declined" : outcome.reason;
      await auditCall(this.env, {
        ...ended,
        // A tool's own error is an answer, handed over as a repeat gets it.
        outcome:
          reason === "connect.action_failed" ? "replayed" : outcomeOf(reason),
        reason,
        // How it ended, read again: no send of its own.
        replayed: true,
      });
    }
    return outcome;
  }

  async dropForEndedRun(request: unknown): Promise<void> {
    await dropForEndedRun(this.env, request);
  }

  async dropForEndedRuns(request: unknown): Promise<void> {
    await dropForEndedRuns(this.env, request);
  }

  async dropForBinding(request: unknown): Promise<void> {
    await dropForBinding(this.env, request);
  }

  async dropStaleBinding(request: unknown): Promise<void> {
    await dropStaleBinding(this.env, request);
  }

  async anyPending(request: unknown): Promise<boolean> {
    return (
      (await anyPending(this.env, request)) ||
      (await unresolvedUnder(this.env, request))
    );
  }

  // Calls of unknown outcome (src/outcomes.ts). Core names the person from
  // their session; only they see and resolve what acted for them. An
  // organization's own admins list everyone's, without what was sent.

  async listUnknownOutcomes(
    person: ConnectionPerson,
    before?: string
  ): Promise<UnknownOutcome[]> {
    return await listUnknownOutcomes(this.env, person, before);
  }

  async listAllUnknownOutcomes(
    admin: ConnectionPerson,
    before?: string
  ): Promise<UnknownOutcomeListing[]> {
    return await listAllUnknownOutcomes(this.env, admin, before);
  }

  async unknownOutcome(request: unknown): Promise<UnknownOutcome | null> {
    return await unknownOutcomeFor(this.env, request);
  }

  async resolveOutcome(request: unknown): Promise<void> {
    await resolveOutcome(this.env, signingKeys(this.env), request);
  }

  async refuseResolution(request: unknown): Promise<void> {
    await refuseResolution(this.env, request);
  }

  async declineChatActions(request: unknown): Promise<number> {
    return await declineChatActions(this.env, request);
  }

  async declineAction(request: unknown): Promise<void> {
    const parsed = declineActionSchema.safeParse(request);
    if (!parsed.success) {
      throw connectErrors.create("connect.invalid");
    }
    const { person, id } = parsed.data;
    await take(
      this.env,
      person,
      await heldFor(this.env, person, id, "decline"),
      "decline"
    );
  }

  /**
   * Runs a held action its person confirmed: the stored call, exactly, on
   * the normal path, once. Only with the capability core signed for
   * confirming this action for this person, from their session, once it
   * checked the permission and the context again; and only while the input
   * is the one they were shown.
   *
   * What can still refuse it is checked before it is taken, so a refusal
   * leaves it waiting and is recorded as refused, not confirmed: the
   * capability, the input, and the connection (active, the person's to
   * use, the same account). The call path checks them all
   * again once it is taken, and those checks are the ones that count.
   */
  async confirmAction(request: unknown): Promise<ConnectResult> {
    const parsed = confirmActionSchema.safeParse(request);
    if (!parsed.success) {
      throw connectErrors.create("connect.invalid");
    }
    const { capability, person, id, inputHash } = parsed.data;
    const held = await heldFor(this.env, person, id, "confirm");
    const call = callOf(held);
    let claims: CapabilityClaims | undefined;
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      requireDecision(claims, {
        decision: { kind: "confirm", pendingActionId: held.id },
        person,
        call: decidedCallOf(held),
      });
      if (inputHash !== held.inputHash) {
        throw connectErrors.create("connect.pending_changed");
      }
      await connectionFor(this.env, claims, call.connectionId, held);
    } catch (error) {
      await auditRefusedDecision(
        this.env,
        person,
        "confirm",
        id,
        codeOf(error) ?? "internal",
        held,
        claims?.restricted
      );
      throw error;
    }
    await take(this.env, person, held, "confirm", claims.restricted);
    try {
      return await this.#carryOutAudited(call, claims, held);
    } catch (error) {
      // Taken, and failed: said so, so core tells the action's chat. What
      // went unexpectedly wrong is logged here, and goes as a failure.
      if (!isExpectedError(error)) {
        log.error("connect.confirmed_action_failed", errorFields(error));
      }
      throw markTaken(error);
    }
  }

  async call(request: unknown): Promise<ConnectResult> {
    const parsed = connectCallSchema.safeParse(request);
    if (!parsed.success) {
      await auditFailure(this.env, {
        outcome: "refused",
        reason: "connect.invalid",
      });
      throw connectErrors.create("connect.invalid");
    }
    const { capability, ...call } = parsed.data;
    let claims: CapabilityClaims;
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      // A decision's capability decides its call through `confirmAction`
      // or `resolveOutcome`, never anything here.
      requireDecision(claims);
    } catch (error) {
      const reason = codeOf(error);
      await auditFailure(this.env, {
        call: statedOf(call),
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
      });
      throw error;
    }
    return await this.#carryOutAudited(call, claims);
  }

  /**
   * Carries out a call whose capability is verified, or the held action
   * `held` its person confirmed, and records it, refused ones too.
   */
  async #carryOutAudited(
    call: Omit<ConnectCall, "capability">,
    claims: CapabilityClaims,
    held?: HeldAction
  ): Promise<ConnectResult> {
    const stated = statedOf(call);
    let done: CallDone;
    const progress: CallProgress = {};
    try {
      done = await carryOut(this.env, claims, call, progress, held);
    } catch (error) {
      let reason = codeOf(error);
      // Once the key was claimed the call may have gone out: an error that
      // is none of connect's own answers (spending or freeing the key
      // failed, say) leaves its outcome unknown, never a plain failure.
      const lost = progress.claimed === true && reason === undefined;
      if (lost) {
        log.error("connect.call_after_claim_failed", errorFields(error));
        reason = "connect.outcome_unknown";
      }
      await auditFailure(this.env, {
        call: stated,
        claims,
        // A repeat refused as its earlier call ended is of a side effect.
        sideEffect: progress.replayed === true ? true : progress.sideEffect,
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
        replayed: progress.replayed,
        recovery: progress.recovery,
        pendingActionId: held?.id,
      });
      throw reason === "connect.outcome_unknown"
        ? unknownOutcome(progress, lost ? undefined : detailsOf(error))
        : error;
    }
    // Nothing is returned, or stored for a repeat, that the audit log
    // doesn't have: a side effect's answer is stored with its events. If
    // that fails, the call happened but went unrecorded: its key is spent,
    // and it is recorded, as far as possible, with an unknown outcome.
    const record: CallRecord = {
      call: stated,
      claims,
      sideEffect: done.sideEffect,
      outcome: callOutcome(done),
      reason: done.failed ? "connect.action_failed" : undefined,
      replayed: done.replayed,
      recovery: done.recovery,
      provenance: done.result.provenance,
      pendingActionId: done.pending?.id ?? held?.id,
    };
    try {
      await auditCall(
        this.env,
        record,
        done.commit === undefined ? [] : [done.commit]
      );
    } catch (error) {
      log.error("audit.record_failed", errorFields(error));
      await done.spend?.().catch((spendError: unknown) => {
        log.error("idempotency.spend_failed", errorFields(spendError));
      });
      await auditFailure(this.env, {
        ...record,
        outcome: "unknown",
        reason: "connect.outcome_unknown",
      });
      // Sent, unrecorded: as any lost answer, a native one waits for its
      // person to resolve it.
      throw unknownOutcome(progress);
    }
    if (done.failed) {
      throw connectErrors.create("connect.action_failed", {
        output: done.result.output,
      });
    }
    if (done.pending === undefined) {
      return done.result;
    }
    // A run's step can't carry on with an answer that says "held": it ends
    // as held, and core waits for the person's decision before running it
    // again under the same key (workflows/host.ts), which then finds the
    // answer, or `connect.declined`.
    if (claims.authority.mode === "workflow") {
      throw connectErrors.create("connect.held", {
        pendingActionId: done.pending.id,
      });
    }
    return { ...done.result, pending: done.pending };
  }
}
