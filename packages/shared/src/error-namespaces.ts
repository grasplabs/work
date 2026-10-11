// The namespaces (first segments) of the platform's error codes, apart and
// with nothing imported, so the SDK's root module (what screens import) can
// refuse an App's error code in one of them without loading every error
// family and Zod with it.
//
// It is not a list to keep by hand: test/error-namespaces.test.ts loads
// every module that defines an error family (it finds them by their
// source) and fails unless this list holds exactly the namespaces their
// codes use, plus the SDK's own definition namespaces below. Core checks
// the live registry as well (`isPlatformCode`, operations.ts).

/**
 * The namespaces of every error family's codes (`defineErrorFamily`),
 * sorted, as the test derives them.
 */
export const familyNamespaces = [
  "agent",
  "app",
  "audit",
  "auth",
  "capability",
  "connect",
  "connection",
  "data",
  "decision",
  "dependency",
  "document",
  "error_report",
  "expression",
  "guest",
  "internal",
  "interview",
  "kickoff",
  "knowledge",
  "knowledge_signal",
  "member",
  "model",
  "notification",
  "onboarding",
  "package",
  "permission",
  "query",
  "request",
  "role",
  "screen",
  "signal",
  "statistics",
  "submission",
  "upload",
  "workflow",
] as const;

/**
 * The namespaces of the codes the SDK and the operation host give their
 * own refusals, which no family defines: a declaration refused (`definition`,
 * `schema`, `function`, `resource`) and how the host answers a call
 * (`operation`, `contract`, `mutation`, `effect`, `safety`).
 */
export const sdkNamespaces = [
  "contract",
  "definition",
  "effect",
  "function",
  "mutation",
  "operation",
  "resource",
  "safety",
  "schema",
] as const;

/** Every namespace an App's own error code can't have. */
export const platformErrorNamespaces: ReadonlySet<string> = new Set<string>([
  ...familyNamespaces,
  ...sdkNamespaces,
]);
