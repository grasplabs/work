// What core reads from its env besides wrangler.jsonc's bindings, which
// `wrangler types` can't see: deployment config the console sets per
// deployment, and switches local dev, tests and on-prem pass. Every one is
// optional: core works, or fails closed, without it. Merged into the
// interface worker-configuration.d.ts generates, which both `Env` and
// `cloudflare:workers`' `env` extend.
interface __BaseEnv_Env {
  /** Sign-in (src/auth/config.ts): JSON, parsed with `deploymentConfig`. */
  SIGN_IN?: unknown;
  ENTRA_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The model gateway (src/models.ts): JSON. */
  MODEL_GATEWAY?: unknown;
  /** Memory files' size limits, in tokens (src/knowledge/memory-files.ts): JSON. */
  MEMORY_LIMITS?: unknown;
  /**
   * Lower limits on an App's npm packages than the defaults
   * (`packageLimits` in @grasp-os/shared/packages): JSON, partial.
   */
  PACKAGE_LIMITS?: unknown;
  /**
   * The change that made this version (src/platform-updates.ts): JSON,
   * `{by, what, release, at}`, set by the console on every version it
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
   * perMinute` (src/app.ts, `claimStatisticMinute`).
   */
  STATISTICS_POINT_LIMITS?: string;
  /**
   * Tests only: lower bounds on an App's statistics reads, `perCall/
   * perMinute` (src/app.ts, `claimStatisticMinute`).
   */
  STATISTICS_READ_LIMITS?: string;
  /** The router secret before the current one, while rotating (src/router-secret.ts). */
  ROUTER_SECRET_PREVIOUS?: string;
  /** Local dev only (src/router-secret.ts). */
  DEV_SKIP_ROUTER_SECRET?: string;
  /** Local dev and e2e only: a stand-in for Entra (src/auth/config.ts). */
  DEV_IDP_ORIGIN?: string;
}
