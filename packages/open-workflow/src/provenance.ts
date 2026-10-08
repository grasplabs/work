/**
 * Where the profile comes from, pinned to exact bytes.
 *
 * vendor/open-workflow-1.0.3/ holds the Open Workflow (formerly Serverless
 * Workflow) DSL 1.0.3 schema, schema/workflow.yaml, and the project's
 * Apache-2.0 LICENSE, both byte for byte as published at commit
 * `upstreamCommit` of github.com/open-workflow-specification/specification.
 * The NOTICE beside them records the same.
 *
 * That commit is the one the platform specification pins (13.1), not the
 * v1.0.3 tag (`upstreamTagCommit`): it is 26 commits later on main, still
 * DSL 1.0.3, and only it has the top-level `evaluate` the profile requires,
 * `for.in` inline arrays and `catch.then`.
 *
 * Nothing loads this schema at run time and nothing fetches a schema from
 * anywhere. The profile is a strict subset of it, written out in this
 * package; the profile's tests check every definition the profile accepts
 * against the vendored schema, so the profile can't drift outside upstream
 * unnoticed. Changing any of this is a new profile revision, with its own
 * compatibility fixtures.
 */
export const openWorkflowProvenance = {
  profile: "grasp-open-workflow/1",
  dsl: "1.0.3",
  repository: "https://github.com/open-workflow-specification/specification",
  upstreamCommit: "fe69b1b8090601a1b73555e9bd576a7590a131e1",
  upstreamTag: "v1.0.3",
  upstreamTagCommit: "9b5b1da29e9d4fff2358580241e11aab22704a16",
  license: "Apache-2.0",
  files: {
    /** schema/workflow.yaml at `upstreamCommit`. */
    "workflow.yaml":
      "4de09c2b62c46fcbddaa4942cb84d6539bd28995de4410004118c82cc2030d8f",
    /** LICENSE at `upstreamCommit`. */
    LICENSE: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  },
} as const;
