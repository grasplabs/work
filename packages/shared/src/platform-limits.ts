// The platform's starting limits (spec 18.1), in one trusted module: every
// boundary's default, each in the unit its name says. A count of characters
// is never applied as a count of bytes, nor a wall time as CPU time.
//
// These are the ceilings of this release. A deployment's operator may set
// lower ones for the limits core reads through its quota policy
// (`QUOTA_LIMITS`, quota-policy.ts), never higher: raising a ceiling takes
// capacity and security evidence, and so a release that changes it here.
// What an App, a workflow or any other resource declares is held to them
// too: a declaration may only be stricter.
//
// Free of dependencies, like app-limits.ts and operation-limits.ts, which
// take their values from here: the screen compiler's isolate and the SDK's
// root module import those, and can't bring Zod along.

const kib = 1024;
const mib = 1024 * kib;
const second = 1000;
const minute = 60 * second;
const day = 24 * 60 * minute;

export const platformLimits = {
  // Authoring source.
  /** Files in one App. */
  authoringFiles: 200,
  /** Characters in one of an App's files. */
  authoringFileCharacters: 200_000,
  /** Characters in all of an App's files together. */
  authoringTotalCharacters: 1_000_000,
  /** Segments in one of an App's paths. */
  authoringPathDepth: 8,

  // Wire budgets, each as UTF-8 JSON.
  /** One public operation's input. */
  operationInputBytes: 128 * kib,
  /** One public operation's output: larger data is paginated. */
  operationOutputBytes: 256 * kib,
  /** One workflow step's input or result: larger data goes by file reference. */
  stepPayloadBytes: 1 * mib,
  /** One persisted row. */
  persistedRowBytes: 128 * kib,

  // Time.
  /** Each stage of a screen's start: its bootstrap, then its mount. */
  screenStageMs: 10 * second,
  /** One server invocation's CPU time. */
  serverInvocationCpuMs: 10 * second,
  /** One server invocation's wall time. */
  serverInvocationWallMs: 60 * second,
  /** One compiler task's CPU time. */
  compilerTaskCpuMs: 20 * second,
  /** One workflow attempt's CPU time. */
  workflowAttemptCpuMs: 30 * second,
  /** One workflow attempt's active wall time, by default. */
  workflowAttemptWallMs: 60 * second,

  // Workflows.
  /** Logical steps one run takes. */
  workflowSteps: 1000,
  /** Attempts at one step, its first included: a hard ceiling. */
  workflowAttemptsPerStep: 5,
  /** Branches of one run running at once. */
  workflowBranches: 8,
  /** Items of one collection a run fans out over. */
  workflowCollectionItems: 1000,
  /** Levels of a run lineage, its root the first. */
  workflowNestingLevels: 8,
  /** Runs started under a lineage's root, at any depth, in its whole life. */
  workflowDescendantRuns: 100,
  /** Active execution of a run lineage, its attempts' wall time: sleeps and waits excluded. */
  workflowActiveMs: 30 * minute,
  /** A run lineage's age, from its root's start: its deadline and retention agree. */
  workflowAgeMs: 365 * day,

  /**
   * Independent workflows one person creates, deleted ones included: their
   * names are never released (core's workflow-resources.ts).
   */
  workflowResourcesPerPerson: 200,

  // Calls a run lineage makes.
  /** Provider requests of one run lineage, retries included. */
  lineageModelRequests: 100,
  /** Host calls of one run lineage. */
  lineageHostCalls: 10_000,
  /** Host calls of one server invocation. */
  invocationHostCalls: 100,

  // Browser operations, per person and App; subscriptions apart.
  /** Requests a minute. */
  browserRequestsPerMinute: 120,
  /** Requests in a burst. */
  browserRequestBurst: 20,

  // Builds.
  /** Build jobs one tenant has running at once. */
  tenantBuildJobs: 2,
  /** Build jobs one resource or content key has running at once. */
  keyBuildJobs: 1,

  // Dependencies.
  /** Resolved packages in one dependency graph. */
  dependencyPackages: 500,
  /** Depth of one dependency graph. */
  dependencyDepth: 32,
  /** One package's archive, compressed. */
  dependencyArchiveBytes: 16 * mib,
  /** One package's archive, extracted. */
  dependencyExtractedBytes: 64 * mib,
  /** A whole dependency graph, extracted. */
  dependencyGraphBytes: 128 * mib,

  // Produced artifacts.
  /** Everything one resource's builds produce. */
  artifactBytes: 32 * mib,
  /** A browser entry, gzipped, lazy specialist chunks apart. */
  browserEntryGzipBytes: 1 * mib,

  // Code Mode.
  /** Characters of one execution's source. */
  codeModeSourceCharacters: 200_000,
  /** One execution's CPU time. */
  codeModeCpuMs: 10 * second,
  /** One execution's wall time. */
  codeModeWallMs: 30 * second,
  /** Host calls of one execution. */
  codeModeHostCalls: 100,
  /** One execution's result, logs, progress and error together. */
  codeModeOutputBytes: 64 * kib,

  // Repair sessions.
  /** Repair passes of one session. */
  repairPasses: 4,
  /** Model escalations of one session. */
  repairEscalations: 1,
  /** One session's active work in all. */
  repairActiveMs: 10 * minute,

  // Previews.
  /** Updates of one preview session in flight. */
  previewUpdatesInFlight: 1,
  /** Replaceable latest checkpoints of one preview session pending. */
  previewUpdatesPending: 1,
  /** Accepted revisions before a preview's modules are reset. */
  previewResetRevisions: 64,
  /** App JS and CSS loaded in all before a preview's modules are reset. */
  previewResetBytes: 32 * mib,
} as const;

export type PlatformLimit = keyof typeof platformLimits;
