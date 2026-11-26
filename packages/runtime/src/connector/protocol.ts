// What a connector's isolate and connect agree on besides the manifest:
// the `_meta` keys of a call and its result, the JSON-RPC methods of a
// sync, the egress's own answers, and how a route's path template matches
// a request. Plain values, with no schema: every connector bundles this
// and evaluates it each time an isolate loads, once per call, so it
// imports nothing. The manifest's schemas, which only connect and its build
// read, are in manifest.ts.

/**
 * Tool `_meta` key: the name of the one input property that selects the
 * resource (a mailbox, a calendar) a call of the tool acts on.
 */
export const resourceMetaKey = "grasp-os/resource";

/** Result `_meta` key: the IDs of the resources the call read. */
export const provenanceMetaKey = "grasp-os/provenance";

/**
 * Result `_meta` key: `true` on an error result (`isError`) says the tool
 * did nothing at all, so trying again can't do anything twice: its
 * provider rate limited it, say, before it sent any write. A connector
 * sets it with `new ToolError(message, { notPerformed: true })`. Connect
 * then frees the call's idempotency key and answers
 * `connect.server_unavailable`, which a workflow step retries; one whose
 * code is `throttled` and names its `retryAfterSeconds` (as
 * `providerFetch` always does) pauses the connection for that long first,
 * so every other call waits with it. Without it
 * (or `outcomeUnknownMetaKey`), a tool's error is final: the action
 * failed, and its answer is kept for the key.
 *
 * Connect takes this only from native connectors, whose code is ours and
 * reviewed. A Composio or other remote server setting it is ignored: its
 * tools are code we don't review, and a tool that acted and then claimed
 * it hadn't would get its side effect run twice. Nor does connect take a
 * remote server's HTTP 429 as "nothing done": a server of its own making
 * may send one for its provider's 429 after a first write.
 */
export const notPerformedMetaKey = "grasp-os/not-performed";

/**
 * Result `_meta` key: `true` on an error result (`isError`) says the tool
 * can't tell whether its write took effect: the request may have reached
 * the provider, and its answer was lost or can't be read (a dropped
 * connection, a server error, a timeout, an answer the tool can't parse
 * after a write the provider took). A connector sets it with
 * `new ToolError(message, { outcomeUnknown: true })`; `providerFetch` does
 * for every such answer to a write, and the kit for any error a writing
 * tool didn't foresee. Connect then answers `connect.outcome_unknown` and
 * spends the call's idempotency key, as for a call whose answer it lost
 * itself: the call is never sent again under that key, and its error is
 * never kept as the answer, which a caller could take for "nothing was
 * done" (spec 14.3, 44).
 *
 * Connect takes this from any server: believing it can only stop a repeat,
 * never cause one.
 */
export const outcomeUnknownMetaKey = "grasp-os/outcome-unknown";

/**
 * Call `_meta` key (`tools/call` params): the call's effect key, 64
 * lowercase hex characters, which connect derives from the call's whole
 * idempotency scope (who, for whom, which connection, action, resource and
 * key) and sends to native connectors only, for a side effect. It is the
 * same for every attempt of one call and differs between calls, so a tool
 * may give it to its provider (an idempotency key, a tag on what it makes)
 * and find the effect by it later (`findMetaKey`). It never holds the
 * caller's own key, which App code chooses.
 */
export const effectKeyMetaKey = "grasp-os/effect-key";

/**
 * Call `_meta` key: `true` asks the tool to look its effect up by the
 * effect key instead of carrying the call out (an action whose recovery is
 * `find`). It answers the effect's result if it happened; an error saying
 * it isn't there (`effectAbsentMetaKey`) if it certainly didn't; any other
 * error if it can't tell.
 */
export const findMetaKey = "grasp-os/find";

/**
 * Result `_meta` key: `true` on a lookup's error result says the call's
 * effect certainly isn't there (its `find` returned null), so connect may
 * send the call. Only this says so: a lookup that failed, however it
 * failed (a 429 says the GET did nothing, not that the effect is absent),
 * leaves the call unknown.
 */
export const effectAbsentMetaKey = "grasp-os/effect-absent";

/** An effect key, as connect derives it: a SHA-256, in lowercase hex. */
export const effectKeyPattern = /^[0-9a-f]{64}$/u;

/**
 * Call `_meta` key: the stamp core recorded for a workflow run's mail
 * (32 lowercase hex characters), which connect sends to native connectors
 * only, for a side effect. A mail tool puts it on the message it sends or
 * drafts as {@link stampHeader}, so a copy that reaches a watched mailbox
 * names the run that sent it (core's workflows/mail-stamps.ts). App code
 * never chooses it: core makes it, outside the call's input.
 */
export const stampMetaKey = "grasp-os/stamp";

/** A stamp, as core makes it: 16 random bytes, in lowercase hex. */
export const stampPattern = /^[0-9a-f]{32}$/u;

/**
 * Call `_meta` key: `true` says the call is a held side effect its person
 * confirmed, on a card that showed them its exact input; connect sends it
 * to native connectors only, and only then. A tool may do with such a call
 * what no call may do unseen: write a formula a person typed, say. App and
 * agent code never sets it: it isn't part of a call's input.
 */
export const confirmedMetaKey = "grasp-os/confirmed";

/**
 * Result `_meta` key: what a successful write changed, as
 * `{ before, after }` (JSON values of the tool's own shape, such as a row's
 * cells), for the audit record of old and new values. Connect keeps it
 * with the call's answer and records its hash in the call's audit event;
 * it takes it from native connectors only.
 */
export const changeMetaKey = "grasp-os/change";

/** Largest change a result may report, in bytes of JSON. */
export const maxChangeBytes = 256 * 1024;

/**
 * Call `_meta` key: the bytes of the files a call attaches (GRA-887), an
 * object of base64 by the SHA-256 of each, which connect sends to a native
 * connector's tool that takes files (`takesFiles`) only. The input names
 * each file by digest only (`attachments`); the tool checks every part
 * against those digests before it uses one, and keeps none. Core makes
 * them from the run's own files, outside the call's input, and connect
 * checks them too.
 */
export const attachmentsMetaKey = "grasp-os/attachments";

/**
 * The header a mail tool puts a stamp on (`stampMetaKey`), and connect's
 * mail events read it back from.
 */
export const stampHeader = "X-Grasp-Stamp";

/**
 * Response header on the answers connect's egress gives itself: `refused`
 * (the request never left) or `failed` (it left, but its answer is
 * withheld: a redirect, or unreachable). A response past the size limit
 * isn't one of these: its body fails once the limit is passed. Never on a
 * provider's: the egress drops it from theirs.
 */
export const egressHeader = "grasp-egress";

/**
 * The error a provider's answer fails with once it passes what connect's
 * egress reads of one answer: its body stops with this message, which a
 * connector tells apart from any other failure (`isTooLarge` in sync.ts).
 */
export const egressTooLargeMessage = "The provider's response is too large";

/** The kinds of answer connect's egress gives itself, as `egressHeader` says. */
export const egressKind = {
  refused: "refused",
  failed: "failed",
} as const;
export type EgressKind = (typeof egressKind)[keyof typeof egressKind];

/** The MCP revision connect and the connectors speak. */
export const mcpProtocolVersion = "2025-06-18";

/** Longest wait a throttled answer passes on, in seconds. */
export const maxRetryAfterSeconds = 3600;

/**
 * The methods an action may declare. Never DELETE: deleting is what Grasp
 * never does (tool-rules.ts), whatever a tool is called.
 */
export const httpMethods = ["GET", "HEAD", "POST", "PUT", "PATCH"] as const;

/**
 * A path segment an action leaves open, such as `{mailbox}`, maybe inside
 * literal text: a suffix after a colon, as Google's custom methods have it
 * (`{id}:batchUpdate`), an OData function call around it, as Graph's
 * search has it (`search(q='{query}')`), or a prefix that ends in a colon,
 * as every Teams chat's ID starts (`19:{chat}`). One parameter per segment;
 * the colon is the template's own, never the value's.
 */
export const parameterSegment =
  /^(?<prefix>[\w.~$@()'=-]*:?)\{(?<name>[A-Za-z_]\w*)\}(?<suffix>[\w.~$:@()'=-]*)$/u;

/**
 * Batch endpoints (Graph's `/$batch`, Google's `/batch/...`) carry any
 * number of requests to any path in one body, past the path allowlist:
 * never declared.
 */
export const isBatchSegment = (segment: string): boolean => {
  const lower = segment.toLowerCase();
  return lower === "batch" || lower.startsWith("$batch");
};

/** The JSON-RPC method connect asks a connector for a sync page by. */
export const syncMethod = "grasp-os/sync";

/** The JSON-RPC method connect asks a sync's places by. */
export const syncPlacesMethod = "grasp-os/sync-places";

const decodedSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * The characters a parameter's value may not decode to, as a regex
 * character class's contents: path and query delimiters, matrix and
 * custom-method separators (`;`, `:`), a percent sign (so it isn't decoded
 * a second time), a backslash, and controls.
 */
export const forbiddenInValue = String.raw`/\\?#%;:\u0000-\u001F\u007F`;

/**
 * A parameter's value, decoded: text with none of `forbiddenInValue`. A
 * connector checks its path inputs by it, so a bad value is refused with a
 * clear message before anything goes out.
 */
export const segmentValuePattern = new RegExp(`^[^${forbiddenInValue}]+$`, "u");

/** A run of quotes of odd length: one that ends a quoted literal. */
const unpairedQuote = /(?<!')(?:'')*'(?!')/u;

/**
 * Whether a parameter's decoded value is plain text where it stands. On
 * its own in a segment, the value is the segment, so it may not be a dot
 * segment or a batch endpoint; inside literal text it is neither. Inside
 * quotes (OData's `'...'`), a quote may only come doubled, as OData
 * escapes it, so the value can't end the literal early.
 */
const isValueAllowed = (
  decoded: string,
  prefix: string,
  suffix: string
): boolean => {
  if (!segmentValuePattern.test(decoded)) {
    return false;
  }
  if (prefix === "" && suffix === "") {
    return decoded !== "." && decoded !== ".." && !isBatchSegment(decoded);
  }
  const quoted = prefix.endsWith("'") && suffix.startsWith("'");
  return !(quoted && unpairedQuote.test(decoded));
};

/**
 * Whether a URL's path (as `URL.pathname` gives it: dot segments resolved,
 * still percent-encoded) is one the template allows. A `{name}` segment
 * takes one non-empty value that decodes to plain text: no path of its own
 * (`..`, a slash), nothing a server could read as a delimiter, and no
 * percent sign to decode again. Where `values` names a parameter, its
 * value must decode to exactly that (the resource a capability names).
 */
export const pathMatches = (
  template: string,
  pathname: string,
  values: Readonly<Record<string, string>> = {}
): boolean => {
  const expected = template.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const given = actual[index] ?? "";
      const parameter = parameterSegment.exec(segment);
      if (parameter === null) {
        return given === segment;
      }
      const { prefix = "", name = "", suffix = "" } = parameter.groups ?? {};
      if (
        given.length < prefix.length + suffix.length ||
        !given.startsWith(prefix) ||
        !given.endsWith(suffix)
      ) {
        return false;
      }
      const decoded = decodedSegment(
        given.slice(prefix.length, given.length - suffix.length)
      );
      const bound = Object.hasOwn(values, name) ? values[name] : undefined;
      return (
        decoded !== undefined &&
        isValueAllowed(decoded, prefix, suffix) &&
        (bound === undefined || decoded === bound)
      );
    })
  );
};
