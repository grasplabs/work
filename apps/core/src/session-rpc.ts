import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { AppsRpc } from "./apps-rpc.ts";
import { AuditRpc } from "./audit-rpc.ts";
import { ChatsRpc } from "./chats-rpc.ts";
import { ConnectionsRpc } from "./connections.ts";
import { DecisionsRpc } from "./decisions/rpc.ts";
import { DependenciesRpc } from "./dependencies/rpc.ts";
import { MemoryRpc } from "./knowledge/memory-rpc.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import { KnowledgeSignalsRpc } from "./knowledge/signals-rpc.ts";
import { UploadsRpc } from "./knowledge/uploads-rpc.ts";
import { MembersRpc } from "./members.ts";
import { ModelsRpc } from "./models-rpc.ts";
import { NotificationsRpc } from "./notifications.ts";
import { OnboardingGateRpc } from "./onboarding/gate-rpc.ts";
import { OnboardingRpc } from "./onboarding/rpc.ts";
import { OnboardingStaffRpc } from "./onboarding/staff-rpc.ts";
import { PendingActionsRpc } from "./pending-actions.ts";
import { PermissionsRpc } from "./permissions-rpc.ts";
import { ScreenTrustRpc } from "./screen-trust-rpc.ts";
import { ScreensRpc } from "./screens-rpc.ts";
import { fullAccess, withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { SignalsRpc } from "./signals-rpc.ts";
import { WorkflowsRpc } from "./workflows/rpc.ts";

/**
 * What a signed-in person reaches over `/rpc`. Every API here has the same
 * form: an RpcTarget built once per session with core's env and a session
 * check, holding no identity. Each method runs through `withPerson`, which
 * checks the session first and hands over the identity that check returned,
 * so a method can't reach the person without the check, or use one kept
 * from an earlier call. Each namespace is created once and handed out as
 * the same object every time. There's no base
 * class: an RpcTarget's methods, protected ones too, can be called over
 * RPC, so each keeps its env and check in private fields.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #check: SessionCheck;
  readonly #apps: AppsRpc;
  readonly #knowledge: KnowledgeRpc;
  readonly #knowledgeSignals: KnowledgeSignalsRpc;
  readonly #memory: MemoryRpc;
  readonly #uploads: UploadsRpc;
  readonly #permissions: PermissionsRpc;
  readonly #connections: ConnectionsRpc;
  readonly #workflows: WorkflowsRpc;
  readonly #decisions: DecisionsRpc;
  readonly #dependencies: DependenciesRpc;
  readonly #screens: ScreensRpc;
  readonly #screenTrust: ScreenTrustRpc;
  readonly #members: MembersRpc;
  readonly #audit: AuditRpc;
  readonly #models: ModelsRpc;
  readonly #pendingActions: PendingActionsRpc;
  readonly #signals: SignalsRpc;
  readonly #chats: ChatsRpc;
  readonly #notifications: NotificationsRpc;
  readonly #onboarding: OnboardingRpc;
  readonly #onboardingStaff: OnboardingStaffRpc;
  readonly #onboardingGate: OnboardingGateRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#check = check;
    // Everything but the onboarding refuses staff who reach the onboarding alone.
    const full = fullAccess(check);
    this.#apps = new AppsRpc(env, full);
    this.#knowledge = new KnowledgeRpc(env, full);
    this.#knowledgeSignals = new KnowledgeSignalsRpc(env, full);
    this.#memory = new MemoryRpc(env, full);
    this.#uploads = new UploadsRpc(env, full);
    this.#permissions = new PermissionsRpc(env, full);
    this.#connections = new ConnectionsRpc(env, full);
    this.#workflows = new WorkflowsRpc(env, full);
    this.#decisions = new DecisionsRpc(env, full);
    this.#dependencies = new DependenciesRpc(env, full);
    this.#screens = new ScreensRpc(env, full);
    this.#screenTrust = new ScreenTrustRpc(env, full);
    this.#members = new MembersRpc(env, full);
    this.#audit = new AuditRpc(env, full);
    this.#models = new ModelsRpc(env, full);
    this.#pendingActions = new PendingActionsRpc(env, full);
    this.#signals = new SignalsRpc(env, full);
    this.#chats = new ChatsRpc(env, full);
    this.#notifications = new NotificationsRpc(env, full);
    this.#onboarding = new OnboardingRpc(env, check);
    this.#onboardingStaff = new OnboardingStaffRpc(env, check);
    this.#onboardingGate = new OnboardingGateRpc(env, check);
  }

  get notifications(): NotificationsRpc {
    return this.#notifications;
  }

  get onboarding(): OnboardingRpc {
    return this.#onboarding;
  }

  get onboardingStaff(): OnboardingStaffRpc {
    return this.#onboardingStaff;
  }

  get onboardingGate(): OnboardingGateRpc {
    return this.#onboardingGate;
  }

  get chats(): ChatsRpc {
    return this.#chats;
  }

  get apps(): AppsRpc {
    return this.#apps;
  }

  get knowledge(): KnowledgeRpc {
    return this.#knowledge;
  }

  get knowledgeSignals(): KnowledgeSignalsRpc {
    return this.#knowledgeSignals;
  }

  get memory(): MemoryRpc {
    return this.#memory;
  }

  get uploads(): UploadsRpc {
    return this.#uploads;
  }

  get permissions(): PermissionsRpc {
    return this.#permissions;
  }

  get connections(): ConnectionsRpc {
    return this.#connections;
  }

  get workflows(): WorkflowsRpc {
    return this.#workflows;
  }

  get decisions(): DecisionsRpc {
    return this.#decisions;
  }

  get dependencies(): DependenciesRpc {
    return this.#dependencies;
  }

  get screens(): ScreensRpc {
    return this.#screens;
  }

  get screenTrust(): ScreenTrustRpc {
    return this.#screenTrust;
  }

  get members(): MembersRpc {
    return this.#members;
  }

  get audit(): AuditRpc {
    return this.#audit;
  }

  get models(): ModelsRpc {
    return this.#models;
  }

  get pendingActions(): PendingActionsRpc {
    return this.#pendingActions;
  }

  get signals(): SignalsRpc {
    return this.#signals;
  }

  async whoami(): Promise<Identity> {
    return await withPerson(this.#check, (identity) => identity);
  }
}
