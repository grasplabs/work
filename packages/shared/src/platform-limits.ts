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
   * Workflow attempts running at once in the whole client deployment: the
   * tenant's share of its core (core's workflows/admission.ts).
   */
  workflowClientAttempts: 32,
  /**
   * Workflow attempts running at once for one person: those of the runs
   * that act for them. One run's branches fit.
   */
  workflowPersonAttempts: 8,
  /** Workflow attempts running at once of one App's runs. One run's branches fit. */
  workflowAppAttempts: 8,
  /**
   * Workflow steps waiting at once for a share of the attempts running at
   * once, for one person: past it, a step's attempt is refused, not queued.
   */
  workflowQueuedPerPerson: 64,
  /** Workflow steps waiting at once for a share, of one App's runs. */
  workflowQueuedPerApp: 64,
  /**
   * How long one workflow step waits in all for a share, or for its busy
   * lineage, before it fails (`workflow.queue_timeout`).
   */
  workflowQueuedStepMs: 1 * day,

  /**
   * Independent workflows one person creates, deleted ones included: their
   * names are never released (core's workflow-resources.ts).
   */
  workflowResourcesPerPerson: 200,
  /** Live independent triggers one person has (core's trigger-resources.ts). */
  triggerResourcesPerPerson: 100,

  // Model requests in flight (core's model ledger, model-admission.ts).
  /**
   * Provider requests to models in flight at once in the whole client
   * deployment: the tenant's share of its model gateway.
   */
  modelClientRequests: 16,
  /** Provider requests in flight at once for one person. */
  modelPersonRequests: 4,
  /** Provider requests in flight at once of one App. */
  modelAppRequests: 8,
  /**
   * Model calls waiting at once for a share of the requests in flight, for
   * one person: past it, a call is refused (`model.queued`), not queued.
   */
  modelQueuedPerPerson: 32,
  /** Model calls waiting at once for a share, of one App. */
  modelQueuedPerApp: 64,

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

  // App files (spec 10.7.5). Spec 18.1 sets no figure for them: these are
  // this release's starting ceilings, held by core and the page alike.
  /** One file an App's screen uploads. */
  appFileBytes: 25 * mib,
  /** One chunk of an upload, as the page sends it and core keeps it. */
  appFileChunkBytes: 1 * mib,
  /** A file a screen previews in its frame: larger ones have no preview. */
  appFilePreviewBytes: 4 * mib,
  /**
   * The pixels of an image a screen previews, as its header declares them:
   * a few megabytes can declare an image that decodes to gigabytes, so a
   * larger one has no preview. Room for a phone camera's photo.
   */
  appFilePreviewPixels: 50_000_000,
  /** Uploads one person has open in one App's store at once. */
  appFileOpenUploads: 8,
  /** How long an upload has, from its start, to be finished. */
  appFileUploadMs: 60 * minute,
  /** How long a finished file no record holds is kept before it is deleted. */
  appFileOrphanMs: 1 * day,
  // Storage quotas. Without them a person could publish a file per two
  // requests (about 1.5 GB a minute under the browser request budget) and
  // keep it for the orphan retention, or for good once attached, all on
  // the client's EU bucket. The figures leave room for real work (a few
  // dozen documents waiting to be attached, a few hundred large ones kept)
  // and bound what one person, or one App's store, can hold at once.
  /** Finished files no record holds, one person's in one store at once. */
  appFileUnattachedPerPerson: 50,
  /** Bytes of files (open, finished or attached) one person keeps in a store. */
  appFilePersonBytes: 2 * 1024 * mib,
  /** Bytes of files one App's store keeps, everyone's together. */
  appFileStoreBytes: 20 * 1024 * mib,
  /**
   * Chunk requests one person's screens of an App may send: their own
   * budget, apart from the request budget, enough for a 25 MB file and its
   * resends in a burst, and 300 MB a minute after.
   */
  appFileChunkBurst: 32,
  appFileChunksPerMinute: 300,
  /** How long one download may take to stream, from its first byte. */
  appFileDownloadMs: 2 * minute,
  /**
   * How long a page waits on one chunk's request (1 MB) before it counts
   * as lost and is sent again.
   */
  appFileChunkSendMs: 1 * minute,

  // Builds (core's build-admission.ts).
  /** Build jobs one tenant has building at once: the client's share. */
  tenantBuildJobs: 2,
  /**
   * Build jobs one resource or content key has building at once: for an
   * App's build jobs, the App.
   */
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
