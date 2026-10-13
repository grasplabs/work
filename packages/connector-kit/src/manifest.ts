import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import { oauthProviderSchema } from "@grasp-os/shared/connect";
import { permissionActionSchema } from "@grasp-os/shared/permissions";
import { z } from "zod";

// A native connector's manifest: what connect knows of it without running
// it. Connect's build reads it from the connector's module and ships it
// next to the module's code, so connect decides by the manifest alone which
// provider's token a call gets, and where that call may go (threat model
// R9, Q11): the connector's code can't widen either.

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
 * `connect.server_unavailable`, which a workflow step retries. Without it
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
 * How connect may recover a call of an action once its outcome is unknown
 * (spec 14.3): `none`, it stays unknown; `repeat`, it is sent again under
 * the same effect key, because it can't take effect twice (the provider
 * keeps the key, or the write sets a state); `find`, the tool looks its
 * effect up by the key first (`findMetaKey`). A read-only action is
 * always `none`: it has no effect to recover.
 */
export const recoveryModes = ["none", "repeat", "find"] as const;
export type RecoveryMode = (typeof recoveryModes)[number];

/**
 * Response header on the answers connect's egress gives itself: `refused`
 * (the request never left) or `failed` (it left, but its answer is
 * withheld: a redirect, or unreachable). A response past the size limit
 * isn't one of these: its body fails once the limit is passed. Never on a
 * provider's: the egress drops it from theirs.
 */
export const egressHeader = "grasp-egress";

/** The kinds of answer connect's egress gives itself, as `egressHeader` says. */
export const egressKind = {
  refused: "refused",
  failed: "failed",
} as const;
export type EgressKind = (typeof egressKind)[keyof typeof egressKind];

/** Most resource IDs one call may report reading. */
export const maxProvenanceItems = 1000;

/** The IDs of the resources a call read, as a tool reports them. */
export const provenanceSchema = z
  .array(z.string().min(1).max(auditIdentifierMaxLength))
  .max(maxProvenanceItems);

/** The MCP revision connect and the connectors speak. */
export const mcpProtocolVersion = "2025-06-18";

/** Longest wait a throttled answer passes on, in seconds. */
export const maxRetryAfterSeconds = 3600;

/** The methods an action may declare. */
export const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

/**
 * A provider host, as the egress handler compares it: a lowercase DNS name
 * with at least two labels and a top-level label that starts with a letter,
 * so never an IP address, a port or userinfo.
 */
const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A path segment an action names as it is, such as `v1.0` or `$value`. */
const literalSegment = /^[\w.~$:@()'-]+$/u;

/**
 * A path segment an action leaves open, such as `{mailbox}`, maybe inside
 * literal text: a suffix after a colon, as Google's custom methods have it
 * (`{id}:batchUpdate`), or an OData function call around it, as Graph's
 * search has it (`search(q='{query}')`). One parameter per segment.
 */
const parameterSegment =
  /^(?<prefix>[\w.~$@()'=-]*)\{(?<name>[A-Za-z_]\w*)\}(?<suffix>[\w.~$:@()'=-]*)$/u;

/**
 * Batch endpoints (Graph's `/$batch`, Google's `/batch/...`) carry any
 * number of requests to any path in one body, past the path allowlist:
 * never declared.
 */
const isBatchSegment = (segment: string): boolean => {
  const lower = segment.toLowerCase();
  return lower === "batch" || lower.startsWith("$batch");
};

/** Whether `path` is a path template: `/` and one or more segments. */
const isPathTemplate = (path: string): boolean => {
  const [empty, ...segments] = path.split("/");
  return (
    empty === "" &&
    segments.length > 0 &&
    segments.every((segment) => {
      const parameter = parameterSegment.exec(segment);
      // A parameter's literal text is never a batch endpoint's either.
      return parameter === null
        ? literalSegment.test(segment) &&
            segment !== "." &&
            segment !== ".." &&
            !isBatchSegment(segment)
        : !isBatchSegment(parameter.groups?.prefix ?? "");
    })
  );
};

const hostSchema = z.string().regex(hostPattern);

/**
 * Hosts a redirect may lead to, as `*.<host>`: the `*` stands for exactly
 * one DNS label, such as a SharePoint tenant's `contoso` in
 * `contoso.sharepoint.com`.
 */
const redirectHostSchema = z
  .string()
  .refine(
    (pattern) => pattern.startsWith("*.") && hostPattern.test(pattern.slice(2)),
    "Not a redirect host: *.<host>"
  );

/** One DNS label, as a redirect host's `*` stands for. */
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Whether `hostname` (lowercase, as a URL has it) is one `pattern` allows. */
export const redirectHostMatches = (
  pattern: string,
  hostname: string
): boolean => {
  const base = `.${pattern.slice(2)}`;
  return (
    pattern.startsWith("*.") &&
    hostname.endsWith(base) &&
    dnsLabel.test(hostname.slice(0, -base.length))
  );
};

/**
 * One request an action may send: its method, host and path, where a
 * `{name}` segment stands for any one segment. A `{name}` segment named
 * after the action's resource property holds the resource a call's
 * capability names. The query string and the body are the action's own.
 *
 * A GET may name `redirects`: the hosts connect's egress follows one
 * redirect of its answer to, itself, without the token or any of the
 * connector's headers, and never a second one. That is how a download
 * works where the provider answers with a redirect to a pre-authenticated
 * URL on its storage hosts (Graph to SharePoint). Every other redirect is
 * refused.
 */
export const routeSchema = z
  .strictObject({
    method: z.enum(httpMethods),
    host: hostSchema,
    path: z.string().max(512).refine(isPathTemplate, "Not a path template"),
    redirects: z.array(redirectHostSchema).min(1).max(4).optional(),
  })
  .refine(
    ({ method, redirects }) => redirects === undefined || method === "GET",
    "Only a GET may follow a redirect"
  );
export type Route = z.infer<typeof routeSchema>;

/** Most requests one action may declare. */
const maxRoutes = 32;

/**
 * How a call of an action reads to the person asked to confirm it: a
 * title, and the input properties that matter, each under a label. The
 * person is shown each property's value exactly as the call holds it,
 * never a summary of it, and is told when the call's input holds more than
 * these show.
 */
const actionDescribeSchema = z.strictObject({
  title: z.string().min(1).max(120),
  fields: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(64),
        /** The input property whose value it shows. */
        input: z.string().min(1).max(128),
      })
    )
    .min(1)
    .max(32),
});
export type ActionDescribe = z.infer<typeof actionDescribeSchema>;

/** A JSON Schema of a tool's input or output, as plain JSON data. */
const jsonSchemaObject = z.record(z.string(), z.json());

/**
 * What connect knows of one action (tool) before running it, and decides
 * by before it reads a token: whether it is read-only, the input property
 * that selects its resource, its input properties, and the only requests
 * it may send. And how a held call of it is shown (`describe`), if the
 * tool says.
 */
const actionManifestSchema = z.strictObject({
  routes: z.array(routeSchema).max(maxRoutes),
  readOnly: z.boolean(),
  /** How a call of unknown outcome may be recovered (`recoveryModes`). */
  recovery: z.enum(recoveryModes),
  resource: z
    .string()
    .regex(/^[A-Za-z_]\w*$/u)
    .nullable(),
  input: z.array(z.string().min(1).max(128)).max(128),
  describe: actionDescribeSchema.optional(),
  /**
   * Its input and its output, as the JSON Schemas the connector's own
   * schemas make: the generated contract an App's resource binding is
   * checked against (spec 12), in both directions. Data only: connect
   * never runs anything from them.
   */
  contract: z.strictObject({
    input: jsonSchemaObject,
    output: jsonSchemaObject,
  }),
});
export type ActionManifest = z.infer<typeof actionManifestSchema>;

/** Most hosts one connector may reach. */
const maxHosts = 16;

const connectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

export const connectorManifestSchema = z
  .strictObject({
    name: connectorNameSchema,
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u),
    /** Whose OAuth token a call gets: a connection with this provider's. */
    provider: oauthProviderSchema,
    /** The OAuth scopes its actions need, all among those connect asks for. */
    scopes: z.array(z.string().min(1).max(256)).max(64),
    /** Every host it may reach, exactly. */
    hosts: z.array(hostSchema).min(1).max(maxHosts),
    /** Each action (tool) by name, and the only requests it may send. */
    actions: z.record(permissionActionSchema, actionManifestSchema),
  })
  .refine(
    ({ hosts, actions }) =>
      Object.values(actions).every(({ routes }) =>
        routes.every(({ host }) => hosts.includes(host))
      ),
    "Every route's host must be one of the connector's hosts"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ resource, input }) => resource === null || input.includes(resource)
      ),
    "An action's resource must be one of its input properties"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ describe, input }) =>
          describe === undefined ||
          (describe.fields.every((field) => input.includes(field.input)) &&
            new Set(describe.fields.map((field) => field.input)).size ===
              describe.fields.length)
      ),
    "An action describes only its own input properties, each once"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ readOnly, recovery, routes }) =>
          (!readOnly || recovery === "none") &&
          (recovery !== "find" || routes.some(({ method }) => method === "GET"))
      ),
    // Nothing to recover of a read; and a lookup reads, through the egress,
    // on one of the action's own routes.
    "A read-only action recovers nothing, and one that finds its effect declares the GET it finds it by"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ routes }) =>
          routes.filter(({ method }) => method !== "GET" && method !== "HEAD")
            .length <= 1
      ),
    // A tool writes at most once, as its last request, so a provider's
    // "nothing done" (429) for the call holds for all of it (R7): a tool
    // with two write routes could have written with the first.
    "An action may declare at most one write (a method other than GET or HEAD)"
  );
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** One action of a generated connector contract, and the tool it calls. */
export interface ContractAction {
  /** The connector's tool, e.g. `mail.send`. */
  readonly tool: string;
  readonly declared: ActionManifest;
}

/**
 * The one major version connector contracts are generated at: a change of
 * an action's shape is drift on the bindings that use it, never a new
 * major.
 */
export const generatedContractMajor = 1;

/** An action's name in a contract: what an App's declaration may list. */
const contractActionPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/**
 * The contracts `manifest` generates (spec 12): one per family of its
 * tools, `<connector>.<family>@1`, holding each tool of the family under
 * its name after the family (`mail.send` is `send` of
 * `microsoft-365.mail@1`). Connect serves contracts from this, and the
 * SDK's connector catalog is typed from it, so both name the same
 * contracts and actions.
 */
export const generatedContracts = (
  manifest: ConnectorManifest
): ReadonlyMap<string, ReadonlyMap<string, ContractAction>> => {
  const contracts = new Map<string, Map<string, ContractAction>>();
  for (const [tool, declared] of Object.entries(manifest.actions)) {
    const dot = tool.indexOf(".");
    const action = tool.slice(dot + 1);
    if (dot > 0 && contractActionPattern.test(action)) {
      const contract = `${manifest.name}.${tool.slice(0, dot)}@${generatedContractMajor}`;
      const actions =
        contracts.get(contract) ?? new Map<string, ContractAction>();
      actions.set(action, { tool, declared });
      contracts.set(contract, actions);
    }
  }
  return contracts;
};

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
