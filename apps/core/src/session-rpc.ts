import type { Identity, SessionApi } from "@grasp-os/shared/rpc";

import { AppsRpc } from "./apps-rpc.ts";
import { AuditRpc } from "./audit-rpc.ts";
import { BrainRpc } from "./brain-rpc.ts";
import { ChannelAccountsRpc } from "./channels/accounts.ts";
import { ChatsRpc } from "./chats-rpc.ts";
import { ConnectionsRpc } from "./connections.ts";
import { DashboardRpc } from "./dashboard-rpc.ts";
import { DecisionsRpc } from "./decisions/rpc.ts";
import { DependenciesRpc } from "./dependencies/rpc.ts";
import { EmailPreferencesRpc } from "./email-preferences-rpc.ts";
import { MemoryRpc } from "./knowledge/memory-rpc.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import { KnowledgeSignalsRpc } from "./knowledge/signals-rpc.ts";
import { UploadsRpc } from "./knowledge/uploads-rpc.ts";
import { LandscapeRpc } from "./landscape.ts";
import { MembersRpc } from "./members.ts";
import { ModelsRpc } from "./models-rpc.ts";
import { NotificationsRpc } from "./notifications.ts";
import { OnboardingGateRpc } from "./onboarding/gate-rpc.ts";
import { OnboardingRpc } from "./onboarding/rpc.ts";
import { OnboardingStaffRpc } from "./onboarding/staff-rpc.ts";
import { OrgSettingsRpc } from "./org-settings.ts";
import { OrganizationRpc } from "./organization.ts";
import { SessionsRpc } from "./own-sessions.ts";
import { PendingActionsRpc } from "./pending-actions.ts";
import { PermissionsRpc } from "./permissions-rpc.ts";
import { PoliciesRpc } from "./policies.ts";
import { ResourceBindingsRpc } from "./resource-bindings-rpc.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { ScreenSubmissionsRpc } from "./screen-submissions.ts";
import { ScreenTrustRpc } from "./screen-trust-rpc.ts";
import { ScreensRpc } from "./screens-rpc.ts";
import { fullAccess, withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { SignalsRpc } from "./signals-rpc.ts";
import { staffAudited } from "./staff-audit.ts";
import { StephenRequestsRpc } from "./stephen-requests.ts";
import { StoresRpc } from "./stores-rpc.ts";
import { TemplatesRpc } from "./templates-rpc.ts";
import { UnknownOutcomesRpc } from "./unknown-outcomes.ts";
import { WaitingRpc } from "./waiting-rpc.ts";
import { WorkflowResourcesRpc } from "./workflow-resources-rpc.ts";
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
export class SessionRpc extends CoreRpcTarget implements SessionApi {
  readonly #check: SessionCheck;
  readonly #apps: AppsRpc;
  readonly #knowledge: KnowledgeRpc;
  readonly #brain: BrainRpc;
  readonly #knowledgeSignals: KnowledgeSignalsRpc;
  readonly #memory: MemoryRpc;
  readonly #uploads: UploadsRpc;
  readonly #permissions: PermissionsRpc;
  readonly #resourceBindings: ResourceBindingsRpc;
  readonly #templates: TemplatesRpc;
  readonly #connections: ConnectionsRpc;
  readonly #landscape: LandscapeRpc;
  readonly #policies: PoliciesRpc;
  readonly #workflows: WorkflowsRpc;
  readonly #workflowResources: WorkflowResourcesRpc;
  readonly #decisions: DecisionsRpc;
  readonly #dependencies: DependenciesRpc;
  readonly #screens: ScreensRpc;
  readonly #screenTrust: ScreenTrustRpc;
  readonly #members: MembersRpc;
  readonly #organization: OrganizationRpc;
  readonly #orgSettings: OrgSettingsRpc;
  readonly #stephenRequests: StephenRequestsRpc;
  readonly #audit: AuditRpc;
  readonly #models: ModelsRpc;
  readonly #stores: StoresRpc;
  readonly #pendingActions: PendingActionsRpc;
  readonly #unknownOutcomes: UnknownOutcomesRpc;
  readonly #screenSubmissions: ScreenSubmissionsRpc;
  readonly #signals: SignalsRpc;
  readonly #chats: ChatsRpc;
  readonly #dashboard: DashboardRpc;
  readonly #emailPreferences: EmailPreferencesRpc;
  readonly #sessions: SessionsRpc;
  readonly #channelAccounts: ChannelAccountsRpc;
  readonly #notifications: NotificationsRpc;
  readonly #waiting: WaitingRpc;
  readonly #onboarding: OnboardingRpc;
  readonly #onboardingStaff: OnboardingStaffRpc;
  readonly #onboardingGate: OnboardingGateRpc;

  /** `sessionId`: the session the connection is signed in with. */
  constructor(env: Env, connectionCheck: SessionCheck, sessionId: string) {
    super();
    // Every view and action of Grasp's staff, on every namespace, is in
    // the client's audit log (staff-audit.ts): the one check they all ask.
    const check = staffAudited(env, connectionCheck);
    this.#check = check;
    // Everything but the onboarding refuses staff who reach the onboarding alone.
    const full = fullAccess(check);
    this.#apps = new AppsRpc(env, full);
    this.#knowledge = new KnowledgeRpc(env, full);
    this.#brain = new BrainRpc(env, full);
    this.#knowledgeSignals = new KnowledgeSignalsRpc(env, full);
    this.#memory = new MemoryRpc(env, full);
    this.#uploads = new UploadsRpc(env, full);
    this.#permissions = new PermissionsRpc(env, full);
    this.#resourceBindings = new ResourceBindingsRpc(env, full);
    this.#templates = new TemplatesRpc(env, full);
    this.#connections = new ConnectionsRpc(env, full);
    this.#landscape = new LandscapeRpc(env, full);
    this.#policies = new PoliciesRpc(env, full);
    this.#workflows = new WorkflowsRpc(env, full);
    this.#workflowResources = new WorkflowResourcesRpc(env, full);
    this.#decisions = new DecisionsRpc(env, full);
    this.#dependencies = new DependenciesRpc(env, full);
    this.#screens = new ScreensRpc(env, full);
    this.#screenTrust = new ScreenTrustRpc(env, full);
    this.#members = new MembersRpc(env, full);
    this.#organization = new OrganizationRpc(env, full);
    this.#orgSettings = new OrgSettingsRpc(env, full);
    this.#stephenRequests = new StephenRequestsRpc(env, full);
    this.#audit = new AuditRpc(env, full);
    this.#models = new ModelsRpc(env, full);
    this.#stores = new StoresRpc(env, full);
    this.#pendingActions = new PendingActionsRpc(env, full);
    this.#unknownOutcomes = new UnknownOutcomesRpc(env, full);
    this.#screenSubmissions = new ScreenSubmissionsRpc(env, full);
    this.#signals = new SignalsRpc(env, full);
    this.#chats = new ChatsRpc(env, full);
    this.#emailPreferences = new EmailPreferencesRpc(env, full);
    this.#sessions = new SessionsRpc(env, full, sessionId);
    this.#channelAccounts = new ChannelAccountsRpc(env, full);
    this.#notifications = new NotificationsRpc(env, full);
    // Read from and acting through the namespaces above, with their checks.
    this.#waiting = new WaitingRpc(full, {
      pendingActions: this.#pendingActions,
      unknownOutcomes: this.#unknownOutcomes,
      permissions: this.#permissions,
      dependencies: this.#dependencies,
      screenTrust: this.#screenTrust,
      apps: this.#apps,
      notifications: this.#notifications,
      connections: this.#connections,
      decisions: this.#decisions,
      chats: this.#chats,
      lifecycles: this.#workflowResources.lifecycle,
    });
    this.#onboarding = new OnboardingRpc(env, check);
    this.#onboardingStaff = new OnboardingStaffRpc(env, check);
    this.#onboardingGate = new OnboardingGateRpc(env, check);
    // Its report read through the namespaces above, with their checks.
    this.#dashboard = new DashboardRpc(env, full, {
      onboarding: this.#onboarding,
      workflows: this.#workflows,
      signals: this.#signals,
      knowledgeSignals: this.#knowledgeSignals,
      apps: this.#apps,
    });
  }

  get sessions(): SessionsRpc {
    return this.#sessions;
  }

  get channelAccounts(): ChannelAccountsRpc {
    return this.#channelAccounts;
  }

  get notifications(): NotificationsRpc {
    return this.#notifications;
  }

  get waiting(): WaitingRpc {
    return this.#waiting;
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

  get dashboard(): DashboardRpc {
    return this.#dashboard;
  }

  get emailPreferences(): EmailPreferencesRpc {
    return this.#emailPreferences;
  }

  get apps(): AppsRpc {
    return this.#apps;
  }

  get knowledge(): KnowledgeRpc {
    return this.#knowledge;
  }

  get brain(): BrainRpc {
    return this.#brain;
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

  get resourceBindings(): ResourceBindingsRpc {
    return this.#resourceBindings;
  }

  get templates(): TemplatesRpc {
    return this.#templates;
  }

  get connections(): ConnectionsRpc {
    return this.#connections;
  }

  get landscape(): LandscapeRpc {
    return this.#landscape;
  }

  get policies(): PoliciesRpc {
    return this.#policies;
  }

  get workflows(): WorkflowsRpc {
    return this.#workflows;
  }

  get workflowResources(): WorkflowResourcesRpc {
    return this.#workflowResources;
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

  get organization(): OrganizationRpc {
    return this.#organization;
  }

  get orgSettings(): OrgSettingsRpc {
    return this.#orgSettings;
  }

  get stephenRequests(): StephenRequestsRpc {
    return this.#stephenRequests;
  }

  get audit(): AuditRpc {
    return this.#audit;
  }

  get models(): ModelsRpc {
    return this.#models;
  }

  get stores(): StoresRpc {
    return this.#stores;
  }

  get pendingActions(): PendingActionsRpc {
    return this.#pendingActions;
  }

  get unknownOutcomes(): UnknownOutcomesRpc {
    return this.#unknownOutcomes;
  }

  get screenSubmissions(): ScreenSubmissionsRpc {
    return this.#screenSubmissions;
  }

  get signals(): SignalsRpc {
    return this.#signals;
  }

  async whoami(): Promise<Identity> {
    return await withPerson(this.#check, (identity) => identity);
  }
}
