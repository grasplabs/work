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
  "contract",
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
  "mutation",
  "notification",
  "onboarding",
  "operation",
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
 * The namespaces of the codes the SDK gives its own refusals and those the
 * host reserves, which no family defines: a declaration refused
 * (`definition`, `schema`, `function`, `resource`) and the outcomes of an
 * external effect and of a safety check (`effect`, `safety`).
 */
export const sdkNamespaces = [
  "definition",
  "effect",
  "function",
  "resource",
  "safety",
  "schema",
] as const;

/** Every namespace an App's own error code can't have. */
export const platformErrorNamespaces: ReadonlySet<string> = new Set<string>([
  ...familyNamespaces,
  ...sdkNamespaces,
]);
