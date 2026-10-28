// What core reads from its env besides wrangler.jsonc's bindings, which
// `wrangler types` can't see: deployment config the admin sets per
// deployment, and switches local dev, tests and on-prem pass. Every one is
// optional: core works, or fails closed, without it. Merged into the
// interface worker-configuration.d.ts generates, which both `Env` and
// `cloudflare:workers`' `env` extend.
interface __BaseEnv_Env {
  /** Sign-in (src/auth/config.ts): JSON, parsed with `deploymentConfig`. */
  SIGN_IN?: unknown;
  ENTRA_CLIENT_SECRET?: string;
  /**
   * The client's Teams bot: its Microsoft app id, the audience of every
   * request Teams sends it (src/channels/teams.ts). Unset, every request
   * from Teams is refused.
   */
  TEAMS_BOT_ID?: string;
  /**
   * The client's Slack app's signing secret, a Worker secret: every request
   * Slack sends the app is signed with it (src/channels/slack.ts). Unset,
   * Slack's door answers 404.
   */
  SLACK_SIGNING_SECRET?: string;
  /**
   * The client's WhatsApp Business number (src/channels/whatsapp.ts): the
   * Meta app's secret every webhook is signed with, a Worker secret; the
   * Cloud API's id of the number; and the token Meta's subscription check
   * must name. Until all three are set, WhatsApp's door answers 404.
   */
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  /**
   * The secret the client's Telegram bot's webhook was registered with, a
   * Worker secret: Telegram sends it with every update
   * (src/channels/telegram.ts). Unset, Telegram's door answers 404.
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * Stephen's own Gmail mailbox, which people email, and the Pub/Sub push
   * that tells its door of new mail (src/channels/gmail.ts): the push's
   * audience, the service account it pushes as, its subscription and the
   * topic the mailbox's watch publishes to. Until the first four are set,
   * Gmail's door answers 404. The mailbox's token is connect's.
   */
  GMAIL_MAILBOX?: string;
  GMAIL_PUBSUB_AUDIENCE?: string;
  GMAIL_PUBSUB_SERVICE_ACCOUNT?: string;
  GMAIL_PUBSUB_SUBSCRIPTION?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The model gateway (src/models.ts): JSON. */
  MODEL_GATEWAY?: unknown;
  /**
   * The deployment's AI Gateway token, a Worker secret: the
   * `cf-aig-authorization` an authenticated gateway asks for, which voice
   * requests carry (src/models.ts). Never logged, never sent to the
   * browser. Without it they carry the AI binding's placeholder.
   */
  AI_GATEWAY_TOKEN?: string;
  /** Memory files' size limits, in tokens (src/knowledge/memory-files.ts): JSON. */
  MEMORY_LIMITS?: unknown;
  /**
   * Lower limits on an App's npm packages than the defaults
   * (`packageLimits` in @grasp-os/shared/packages): JSON, partial.
   */
  PACKAGE_LIMITS?: unknown;
  /**
   * The change that made this version (src/platform-updates.ts): JSON,
   * `{by, what, release, at}`, set by the admin on every version it
   * deploys.
   */
  PLATFORM_CHANGE?: unknown;
  /** Days the audit log keeps events before archiving (src/audit-log.ts, `retainAuditLog`). */
  AUDIT_RETENTION_DAYS?: unknown;
  /** Days archived audit events are kept before they're purged (src/audit-log.ts). */
  AUDIT_ARCHIVE_RETENTION_DAYS?: unknown;
  /** Days an ended workflow run keeps its details (src/workflows/retention.ts). */
  RUN_RETENTION_DAYS?: unknown;
  /** The domain the deployment receives mail at (src/workflows/overview.ts). */
  INBOUND_MAIL_DOMAIN?: unknown;
  /** Who core's mail is from (src/mail.ts): JSON, `{name, address}`. */
  MAIL_FROM?: unknown;
  /**
   * The limits the operator lowered, with the policy's generation
   * (`quotaLimitsSchema` in @grasp-os/shared/quota-policy;
   * src/workflows/quotas.ts).
   */
  QUOTA_LIMITS?: unknown;
  /**
   * `cloudflare` where core runs on Cloudflare's runtime, which enforces
   * Code Mode's CPU limit; anything else, unset included, is taken as a
   * runtime that doesn't (src/code-mode.ts). Tests, local development and
   * on-prem say `workerd`.
   */
  RUNTIME_PROFILE?: string;
  /**
   * The client this deployment is, as the admin deploys it: what core
   * answers the admin's provisioning probe with (src/provision-probe.ts).
   * Unset in local development and on-prem.
   */
  CLIENT_ID?: string;
  /**
   * On-prem only: the sandbox supervisor (scripts/workerd-sandbox.ts), as an
   * external service, where untrusted isolates run in workerd processes of
   * their own with a deadline (src/sandboxed.ts). Plain workerd enforces no
   * CPU limit. Unbound, core loads them itself only on Cloudflare, or where
   * `SANDBOX_IN_PROCESS` says so; anywhere else it refuses.
   */
  SANDBOX_HOST?: Fetcher;
  /**
   * Tests only: a shorter deadline for a sandboxed call (src/sandboxed.ts),
   * and for an extraction, a screen build and a package build on the
   * sandbox host (src/knowledge/extract.ts, src/platform-sandbox.ts).
   */
  SANDBOX_DEADLINE_MS?: string;
  /**
   * `unbounded` where core may run untrusted isolates itself without
   * `SANDBOX_HOST` off Cloudflare, accepting that nothing bounds their CPU:
   * tests and local development only, never on-prem (src/sandboxed.ts).
   * No isolate core loads prints anything (@grasp-os/shared/quiet-loader):
   * what a draft's preview writes goes to its tail's report, recorded in
   * the isolate rather than printed (GRA-919), and an App's v1 server has
   * no tail here. That holds as long as the process isn't served
   * `--verbose`, which core can't detect: an operator who sets this
   * doesn't serve core so (GRA-939).
   */
  SANDBOX_IN_PROCESS?: string;
  /** `none` where Durable Objects have no jurisdiction (src/durable-objects.ts). */
  DURABLE_OBJECT_JURISDICTION?: string;
  /**
   * Tests only: a shorter bound on one load of a workflow build, before it
   * is taken for abandoned (src/workflow-builds.ts).
   */
  WORKFLOW_BUILD_READ_MS?: string;
  /**
   * Tests only: a shorter wait between a run's checks of a held side
   * effect (src/workflows/host.ts).
   */
  WORKFLOW_OFF_WAIT_MS?: string;
  /**
   * Tests only: a shorter deadline for a run waiting on an unknown outcome
   * its person hasn't resolved (src/workflows/host.ts).
   */
  WORKFLOW_UNKNOWN_HOLD_MS?: string;
  /**
   * Tests only: a shorter budget for the time one activation of a run
   * spends outside its steps (src/workflows/between-steps.ts).
   */
  WORKFLOW_BETWEEN_STEPS_MS?: string;
  /**
   * Tests only: the delay before every step's retry, in place of the one
   * its config says (src/workflows/dispatcher.ts).
   */
  WORKFLOW_RETRY_DELAY_MS?: string;
  /**
   * Tests only: the UTC month model budgets count in, such as `2031-01`
   * (src/model-budgets.ts).
   */
  MODEL_BUDGET_MONTH?: string;
  /**
   * Tests only: the UTC day a model binding's daily cap counts in, such as
   * `2031-01-02` (src/model-budgets.ts).
   */
  MODEL_BUDGET_DAY?: string;
  /**
   * Tests only: fewer connector events one cron run delivers
   * (src/workflows/connector-events.ts).
   */
  CONNECTOR_EVENTS_PER_RUN?: string;
  /** Tests only: a shorter wall-clock limit for one code run (src/code-mode.ts). */
  CODE_RUN_TIMEOUT_MS?: string;
  /** Tests only: a shorter limit for one call into an App (src/app.ts). */
  APP_CALL_TIMEOUT_MS?: string;
  /**
   * Tests only: shorter limits on an App's tests, in milliseconds,
   * `test/suite/run/cleanup` (src/app-tests.ts): never longer than the
   * defaults.
   */
  APP_TEST_LIMITS_MS?: string;
  /** Tests only: a shorter bound on one build of a save (src/save-builds.ts). */
  BUILD_WAIT_MS?: string;
  /** Tests only: a shorter bound on one load of a draft's preview (src/preview-updates.ts). */
  PREVIEW_LOAD_MS?: string;
  /**
   * Tests only: a shorter bound on one load of a release, before it is
   * taken for abandoned (src/app-releases.ts).
   */
  RELEASE_READ_MS?: string;
  /**
   * Tests only: lowers how many bytes of text a definition export packages
   * (src/definition-export.ts); never raises it.
   */
  DEFINITION_EXPORT_MAX_BYTES?: string;
  /**
   * Tests only: lower bounds on an App's statistics points, `perCall/
   * perMinute` (src/app.ts, `claimStatistic`).
   */
  STATISTICS_POINT_LIMITS?: string;
  /**
   * Tests only: lower bounds on an App's statistics reads, `perCall/
   * perMinute` (src/app.ts, `claimStatistic`).
   */
  STATISTICS_READ_LIMITS?: string;
  /** The router secret before the current one, while rotating (src/router-secret.ts). */
  ROUTER_SECRET_PREVIOUS?: string;
  /** Local dev only (src/router-secret.ts). */
  DEV_SKIP_ROUTER_SECRET?: string;
  /** Local dev and e2e only: a stand-in for Entra (src/auth/config.ts). */
  DEV_IDP_ORIGIN?: string;
}
