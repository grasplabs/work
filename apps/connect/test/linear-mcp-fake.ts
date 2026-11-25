/**
 * Linear's remote MCP server (https://mcp.linear.app), as connect's tests
 * see it: MCP 2026-07-28 over Streamable HTTP, stateless (no `initialize`,
 * no session), behind Linear's own OAuth 2.1 authorization server, with
 * Linear's tools over a small workspace held in memory.
 *
 * - `/.well-known/…`: protected resource metadata (RFC 9728) and
 *   authorization server metadata (RFC 8414), as the real server answers.
 * - `/register`: dynamic client registration (RFC 7591).
 * - `consent(url)`: the person approving the authorization request connect
 *   built, in place of the `/authorize` page, which the fake doesn't serve.
 * - `/token`: the authorization code grant with PKCE, the refresh token
 *   grant (rotating), and revocation (RFC 7009), on the one endpoint as
 *   Linear has them.
 * - `/mcp`: the MCP endpoint, for a bearer token issued for it.
 *
 * Its knobs are plain fields, which `reset()` puts back along with the
 * workspace and everything the fake was sent: call it before each test.
 */
import { randomToken, toBase64Url } from "@grasp-os/shared/encoding";

export const linearOrigin = "https://mcp.linear.app";
export const linearMcpUrl = `${linearOrigin}/mcp`;
export const linearIssuer = linearOrigin;

/** The one protocol version the server speaks. */
const protocolVersion = "2026-07-28";
const versionMetaKey = "io.modelcontextprotocol/protocolVersion";
const resourceMetadataUrl = `${linearOrigin}/.well-known/oauth-protected-resource/mcp`;
const grantableScopes = ["read", "write"];
const defaultTtlMs = 300_000;
const defaultAccessTokenLifetimeSeconds = 3600;
/** How long a code redeems, as RFC 6749 recommends at most. */
const codeLifetimeMs = 600_000;
const msPerSecond = 1000;
const defaultPageLimit = 50;
const maxPageLimit = 250;
const documentationPageSize = 5;
const highestPriority = 4;

/** A tool as the server lists it; tests change, remove and add them. */
export interface LinearTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** A client registered at `/register`. */
export interface Registration {
  clientId: string;
  /** Only for a client that authenticates with a secret. */
  clientSecret: string | undefined;
  clientName: string | undefined;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: AuthMethod;
  applicationType: string;
}

/**
 * A client known by its metadata document's URL, as consented to: the fake
 * doesn't fetch the document, so it keeps the redirect URIs it saw.
 */
export interface DocumentClient {
  clientId: string;
  redirectUris: string[];
}

/** An access token the server issued; tests may change it. */
export interface IssuedToken {
  clientId: string;
  resource: string;
  scope: string;
  revoked: boolean;
  /** When it expires, in epoch milliseconds. */
  expiresAt: number;
  /** The grant it was issued under, which revocation ends whole. */
  grant: string;
}

/** One request that reached the MCP endpoint, as it arrived. */
export interface McpCall {
  httpMethod: string;
  /** The JSON-RPC method, if the body names one. */
  method: string | undefined;
  /** `params.name`, for a tool call. */
  name: string | undefined;
  arguments: unknown;
  meta: unknown;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
}

/** One request to a `/.well-known/` path. */
export interface MetadataRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** What the redirect back to connect carries after the person consents. */
export interface Consent {
  code: string;
  state: string;
  iss?: string;
}

interface Team {
  id: string;
  key: string;
  name: string;
}

interface User {
  id: string;
  name: string;
  displayName: string;
  email: string;
  admin: boolean;
}

interface State {
  id: string;
  name: string;
  type: string;
}

interface Label {
  id: string;
  name: string;
}

interface Issue {
  uuid: string;
  identifier: string;
  teamId: string;
  title: string;
  description: string;
  priority: number;
  estimate: number | null;
  stateId: string;
  assigneeId: string | null;
  creatorId: string;
  labelIds: string[];
  dueDate: string | null;
  parentId: string | null;
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
}

interface Comment {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

/** The Linear workspace behind the server. */
export interface Workspace {
  teams: Team[];
  users: User[];
  states: State[];
  labels: Label[];
  issues: Issue[];
  comments: Comment[];
}

export interface LinearMcpFake {
  /** What `tools/list` lists, in order; a call runs only a listed tool. */
  tools: LinearTool[];
  /**
   * The `ttlMs` caching hint on `tools/list` and `server/discover`;
   * none when undefined.
   */
  ttlMs: number | undefined;
  /** Tools per `tools/list` page; all on one page when undefined. */
  pageSize: number | undefined;
  /** Results as one JSON body, or as an event stream of one event. */
  answerAs: "json" | "sse";
  accessTokenLifetimeSeconds: number;
  /**
   * Answers the next request to `/mcp` in the server's place, then is
   * cleared; returning undefined lets the server answer it, and throwing
   * drops the connection.
   */
  next:
    | ((request: Request) => Response | Promise<Response> | undefined)
    | undefined;
  /** Every `/mcp` request hangs until its signal aborts. */
  down: boolean;
  calls: McpCall[];
  metadataRequests: MetadataRequest[];
  registrations: Registration[];
  documentClients: DocumentClient[];
  /** Access token → what it was issued for. */
  tokens: Map<string, IssuedToken>;
  workspace: Workspace;
  /** Puts every knob, the workspace and every record back. */
  reset: () => void;
  /**
   * The person approves `authorizationUrl`: the code and state the
   * redirect back carries, with `iss` (RFC 9207) unless `options.iss` is
   * null, or the one it names. Throws, with the reason, where Linear would
   * refuse the request.
   */
  consent: (
    authorizationUrl: string,
    options?: { iss?: string | null }
  ) => Consent;
  /** The server's answer to any request on its origin. */
  handle: (request: Request) => Promise<Response>;
}

type Args = Record<string, unknown>;

interface Grant {
  id: string;
  clientId: string;
  resource: string;
  scope: string;
  revoked: boolean;
}

interface Authorization {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
  /** The grant it was redeemed for, once it was. */
  redeemedFor: string | undefined;
}

interface RefreshToken {
  grant: string;
  used: boolean;
}

/** The client a token request authenticated as. */
interface Client {
  clientId: string;
  grantTypes: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

const headersOf = (request: Request): Record<string, string> =>
  Object.fromEntries(request.headers);

const hasMediaType = (request: Request, mediaType: string): boolean =>
  (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase() === mediaType;

const notFound = (): Response => new Response("Not Found", { status: 404 });

const methodNotAllowed = (allow: string): Response =>
  new Response(null, { status: 405, headers: { allow } });

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const nowIso = (): string => new Date().toISOString();

// Metadata, as https://mcp.linear.app answered on 25 November 2026.

const protectedResource = (resource: string) => ({
  resource,
  authorization_servers: [linearIssuer],
  scopes_supported: grantableScopes,
  bearer_methods_supported: ["header"],
});

const metadataDocuments = new Map<string, unknown>([
  [
    "/.well-known/oauth-protected-resource/mcp",
    protectedResource(linearMcpUrl),
  ],
  ["/.well-known/oauth-protected-resource", protectedResource(linearOrigin)],
  [
    "/.well-known/oauth-authorization-server",
    {
      issuer: linearIssuer,
      authorization_endpoint: `${linearOrigin}/authorize`,
      token_endpoint: `${linearOrigin}/token`,
      registration_endpoint: `${linearOrigin}/register`,
      scopes_supported: ["read", "write", "openid", "email"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
      revocation_endpoint: `${linearOrigin}/token`,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      resource: linearMcpUrl,
      resource_metadata: resourceMetadataUrl,
    },
  ],
]);

/** The `WWW-Authenticate` challenge of the MCP endpoint (RFC 6750). */
const bearerChallenge = (error?: string): string =>
  [
    'Bearer realm="OAuth"',
    ...(error === undefined ? [] : [`error="${error}"`]),
    `resource_metadata="${resourceMetadataUrl}"`,
    `scope="${grantableScopes.join(" ")}"`,
  ].join(", ");

// OAuth answers (RFC 6749 §5).

const noStore = { "cache-control": "no-store", pragma: "no-cache" };

const oauthError = (
  error: string,
  description: string,
  status = 400,
  headers: Record<string, string> = {}
): Response =>
  Response.json(
    { error, error_description: description },
    { status, headers: { ...noStore, ...headers } }
  );

/** The client failed to authenticate (RFC 6749 §5.2). */
const invalidClient = (description: string, triedBasic: boolean): Response =>
  oauthError(
    "invalid_client",
    description,
    401,
    triedBasic ? { "www-authenticate": 'Basic realm="OAuth"' } : {}
  );

/** The first parameter given more than once, which OAuth forbids. */
const repeated = (params: URLSearchParams): string | undefined =>
  [...params.keys()].find((key) => params.getAll(key).length > 1);

const formDecoded = (part: string): string =>
  decodeURIComponent(part.replaceAll("+", " "));

/** A `client_secret_basic` header: the id and secret, form-decoded. */
const basicCredentials = (header: string): [string, string] | undefined => {
  try {
    const decoded = atob(header.slice("Basic ".length));
    const colon = decoded.indexOf(":");
    if (colon === -1) {
      return undefined;
    }
    return [
      formDecoded(decoded.slice(0, colon)),
      formDecoded(decoded.slice(colon + 1)),
    ];
  } catch {
    return undefined;
  }
};

/** A client_id that is a metadata document's URL, as CIMD requires one. */
const isDocumentClientId = (clientId: string): boolean => {
  try {
    const url = new URL(clientId);
    return (
      url.protocol === "https:" &&
      url.pathname.length > 1 &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "" &&
      url.href === clientId
    );
  } catch {
    return false;
  }
};

/** Where loopback redirects may go over plain http (RFC 8252 §7.3). */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI Linear takes: https, or http to a loopback host, as
 * local MCP clients register (mcp-remote's http://localhost callback).
 */
const isRedirectUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopbackHosts.has(url.hostname)))
    );
  } catch {
    return false;
  }
};

const pkceVerifier = /^[A-Za-z0-9._~-]{43,128}$/u;
const pkceChallenge = /^[A-Za-z0-9_-]{43}$/u;

// MCP answers.

const rpcError = (
  id: unknown,
  code: number,
  message: string,
  status: number,
  data?: unknown
): Response =>
  Response.json(
    {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { status }
  );

const headerMismatch = (id: unknown, message: string): Response =>
  rpcError(id, -32_020, `Header mismatch: ${message}`, 400);

const base64Sentinel = /^=\?base64\?(?<encoded>[A-Za-z0-9+/]*={0,2})\?=$/u;

/**
 * A header value as the client meant it: decoded from the Base64 sentinel
 * form; undefined for a sentinel that doesn't decode.
 */
const headerValue = (raw: string): string | undefined => {
  if (!raw.startsWith("=?base64?")) {
    return raw;
  }
  const encoded = base64Sentinel.exec(raw)?.groups?.encoded;
  if (encoded === undefined) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(encoded), (char) => char.codePointAt(0) ?? 0)
    );
  } catch {
    return undefined;
  }
};

/**
 * The parameters a tool's schema mirrors into `Mcp-Param-*` headers
 * (`x-mcp-header`), by their path of `properties` keys.
 */
const mirroredParams = (
  schema: unknown,
  path: string[] = []
): { header: string; path: string[] }[] => {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }
  return Object.entries(schema.properties).flatMap(([key, property]) => {
    const at = [...path, key];
    const header = isRecord(property) ? property["x-mcp-header"] : undefined;
    return [
      ...(typeof header === "string" ? [{ header, path: at }] : []),
      ...mirroredParams(property, at),
    ];
  });
};

const valueAt = (args: Args, path: string[]): unknown => {
  let value: unknown = args;
  for (const key of path) {
    value = isRecord(value) ? value[key] : undefined;
  }
  return value;
};

/** Whether a mirrored header carries `value`, as the transport encodes it. */
const mirrors = (header: string | undefined, value: unknown): boolean => {
  if (header === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return header.trim() !== "" && Number(header) === value;
  }
  return header === String(value);
};

// Linear's tools: their descriptions as Linear's server has them, their
// schemas with the long enums trimmed to what the workspace models.

const schemaDialect = "https://json-schema.org/draft/2020-12/schema";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
) => ({
  $schema: schemaDialect,
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

const text = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});

const nullableText = (description: string) => ({
  type: ["string", "null"],
  description,
});

const texts = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

const limitProperty = {
  type: "number",
  description: "Maximum number of results to return per page",
  maximum: maxPageLimit,
  default: defaultPageLimit,
};
const cursorProperty = text(
  "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
);
const orderByProperty = text(
  "Timestamp to sort results by: creation time or last update time",
  {
    enum: ["createdAt", "updatedAt"],
    default: "updatedAt",
  }
);
const userProperty = text('User ID, name, email, or "me"');
const issueIdDescription =
  "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues";
const priorityProperty = {
  type: "number",
  description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
};
const includeArchivedProperty = {
  type: "boolean",
  description: "Include archived items",
  default: false,
};
const afterProperty = (what: string) =>
  text(`${what} after: ISO-8601 date/duration (e.g., -P1D)`);

const issueFields = [
  "id",
  "uuid",
  "title",
  "description",
  "priority",
  "estimate",
  "url",
  "gitBranchName",
  "createdAt",
  "updatedAt",
  "dueDate",
  "status",
  "statusType",
  "labels",
  "createdBy",
  "createdById",
  "assignee",
  "assigneeId",
  "team",
  "teamId",
  "parentId",
];
const fieldsProperty = {
  type: "array",
  items: { type: "string", enum: issueFields },
  description:
    "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
};

const commentParents = {
  issueId: text(`${issueIdDescription} (provide exactly one parent)`),
  projectId: text(
    "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)"
  ),
  initiativeId: text(
    "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)"
  ),
  documentId: text("Document ID or slug (provide exactly one parent)"),
  milestoneId: text(
    "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first."
  ),
  statusUpdateId: text(
    "Status update UUID (provide exactly one parent). Resolve status updates via `get_status_updates` first."
  ),
  statusUpdateType: text(
    "Set only together with `statusUpdateId`; omit for issue, project, initiative, document, and milestone comments. Type of status update named by `statusUpdateId`, as returned by `get_status_updates`. Omit to check both project and initiative status updates.",
    { enum: ["project", "initiative"] }
  ),
};

const anchored = (anchorDescription: string) => ({
  anchor: text(anchorDescription, { minLength: 1 }),
});

const patchProperty = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  description:
    "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
  items: {
    anyOf: [
      objectSchema(
        {
          op: { type: "string", const: "replace" },
          old_string: text(
            "Exact text to replace. Must match the current content exactly once",
            {
              minLength: 1,
            }
          ),
          new_string: text("Replacement text. Empty string deletes the match"),
          replace_all: {
            type: "boolean",
            description:
              "Replace every occurrence instead of requiring a unique match",
          },
        },
        ["op", "old_string", "new_string"]
      ),
      objectSchema(
        {
          op: { type: "string", const: "insert_before" },
          ...anchored(
            "Exact text to insert before. Must match the current content exactly once"
          ),
          text: text(
            'Text to insert directly before the anchor. Include separators (e.g. "\\n\\n")',
            {
              minLength: 1,
            }
          ),
        },
        ["op", "anchor", "text"]
      ),
      objectSchema(
        {
          op: { type: "string", const: "insert_after" },
          ...anchored(
            "Exact text to insert after. Must match the current content exactly once"
          ),
          text: text(
            'Text to insert directly after the anchor. Include separators (e.g. "\\n\\n")',
            {
              minLength: 1,
            }
          ),
        },
        ["op", "anchor", "text"]
      ),
      objectSchema(
        {
          op: { type: "string", const: "prepend" },
          text: text("Text to insert at the very start of the content", {
            minLength: 1,
          }),
        },
        ["op", "text"]
      ),
      objectSchema(
        {
          op: { type: "string", const: "append" },
          text: text("Text to insert at the very end of the content", {
            minLength: 1,
          }),
        },
        ["op", "text"]
      ),
      objectSchema(
        {
          op: { type: "string", const: "replace_range" },
          from: text(
            "Exact text where the range starts (inclusive). Must match exactly once",
            { minLength: 1 }
          ),
          to: text(
            "Exact text where the range ends (exclusive, stays in place). Must match exactly once after `from`",
            { minLength: 1 }
          ),
          new_string: text("Text replacing the range. Empty string deletes it"),
        },
        ["op", "from", "to", "new_string"]
      ),
    ].map(({ $schema: _dialect, ...schema }) => schema),
  },
};

const readOnly = { readOnlyHint: true };
const writes = { readOnlyHint: false, destructiveHint: false };

/** Linear's tools, as its server lists them. */
const linearTools = (): LinearTool[] => [
  {
    name: "list_issues",
    description:
      'List issues in the user\'s Linear workspace, including active Triage Intelligence suggestions for issues in triage. For issues assigned to me, use "me" as the assignee. For issues created by me, use "me" as the creator. Use "null" for no assignee.',
    inputSchema: objectSchema({
      limit: limitProperty,
      cursor: cursorProperty,
      orderBy: orderByProperty,
      query: text(
        "Search issue title or description. Cannot be combined with customView"
      ),
      customView: text(
        "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
        { minLength: 1 }
      ),
      team: text("Team name or ID"),
      includeSubTeams: {
        type: "boolean",
        description:
          "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters",
        default: false,
      },
      state: text("State type, name, or ID"),
      cycle: text("Cycle name, number, or ID"),
      label: text("Label name or ID"),
      assignee: nullableText('User ID, name, email, or "me"'),
      creator: userProperty,
      delegate: text(
        'Agent name or ID. When the user asks to delegate to "Linear" or "the Linear agent", this refers to the "Linear" app user specifically'
      ),
      project: text("Project name, ID, identifier (e.g., P-ENG-123), or slug"),
      release: text("Release ID or slug"),
      priority: priorityProperty,
      parentId: text("Parent issue ID or identifier (e.g., LIN-123)"),
      fields: fieldsProperty,
      createdAt: afterProperty("Created"),
      updatedAt: afterProperty("Updated"),
      triagedAt: text(
        'Left triage after: ISO-8601 date/duration (e.g., -P1D). Issues still in triage have no triagedAt; list them with state "triage"'
      ),
      completedAt: text(
        "Completed after: ISO-8601 date/duration (e.g., -P1D). Excludes issues that are not completed"
      ),
      includeArchived: includeArchivedProperty,
    }),
    annotations: readOnly,
  },
  {
    name: "get_issue",
    description:
      "Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage Intelligence suggestions when the issue is in triage. A nonempty fields selection overrides the include options; request optional fields directly in fields.",
    inputSchema: objectSchema(
      {
        id: text(issueIdDescription),
        fields: fieldsProperty,
        includeRelations: {
          type: "boolean",
          description: "Include blocking/related/duplicate relations",
          default: false,
        },
        includeCustomerNeeds: {
          type: "boolean",
          description: "Include associated customer needs",
          default: false,
        },
        includeReleases: {
          type: "boolean",
          description: "Include associated releases",
          default: false,
        },
      },
      ["id"]
    ),
    annotations: readOnly,
  },
  {
    name: "save_issue",
    description:
      'Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one. When creating, `team` is required, and `title` is required unless `template` is set. Note: use `assignee` (not `assigneeId`) to set the assignee — it accepts a user ID, name, email, or "me".',
    inputSchema: objectSchema({
      id: text(
        "Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123). Do NOT pass this parameter when creating a new issue."
      ),
      title: text(
        "Issue title (required when creating, unless template is set)"
      ),
      description: text(
        "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)."
      ),
      patch: patchProperty,
      team: text("Team name or ID (required when creating)"),
      template: text(
        "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own"
      ),
      cycle: nullableText("Cycle name, number, or ID. Null to remove"),
      milestone: text("Milestone name or ID"),
      priority: priorityProperty,
      project: nullableText(
        "Project name, ID, identifier (e.g., P-ENG-123), or slug. Null to remove"
      ),
      state: text("State type, name, or ID"),
      assignee: nullableText('User ID, name, email, or "me". Null to remove'),
      delegate: nullableText(
        'Agent name or ID. When the user asks to delegate to "Linear" or "the Linear agent", this refers to the "Linear" app user specifically. Null to remove'
      ),
      labels: texts(
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged. Cannot be combined with addLabels/removeLabels; prefer those for incremental changes'
      ),
      addLabels: texts(
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]) to add. Append-only; existing labels are never removed. Cannot be combined with a team change'
      ),
      removeLabels: texts(
        'Label names or IDs as a JSON array of strings (e.g. ["Bug", "Urgent"]) to remove. Only valid when updating an existing issue. Cannot be combined with a team change'
      ),
      dueDate: nullableText(
        "Due date (ISO format). On update, pass null to remove the due date"
      ),
      slaBreachesAt: nullableText(
        "ISO-8601 timestamp when the SLA will breach. On update, pass null to remove the SLA"
      ),
      slaType: {
        type: ["string", "null"],
        enum: ["all", "onlyBusinessDays", null],
        description:
          'SLA day counting type: "all" or "onlyBusinessDays". Only use with slaBreachesAt; null means unset',
      },
      parentId: nullableText(
        "Parent issue ID or identifier (e.g., LIN-123). Null to remove"
      ),
      estimate: {
        type: ["number", "null"],
        description:
          "Issue estimate value. On create, pass null or omit for no estimate. On update, pass null to clear the estimate; omitting leaves it unchanged. 0 is a real estimate only on teams that allow zero estimates.",
      },
      links: {
        type: "array",
        description:
          "Link attachments to add [{url, title}]. Append-only; existing links are never removed",
        items: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            title: { type: "string", minLength: 1 },
          },
          required: ["url", "title"],
          additionalProperties: false,
        },
      },
      setReleases: texts(
        "Replace all releases on the issue with these. Cannot be combined with addReleases/removeReleases"
      ),
      addReleases: texts(
        "Release IDs or slugs to add. Append-only; existing releases are never removed"
      ),
      removeReleases: texts(
        "Release IDs or slugs to remove. Only valid when updating an existing issue"
      ),
      blocks: texts(
        "Issue IDs/identifiers this blocks. Append-only; existing relations are never removed"
      ),
      blockedBy: texts(
        "Issue IDs/identifiers blocking this. Append-only; existing relations are never removed"
      ),
      relatedTo: texts(
        "Related issue IDs/identifiers. Append-only; existing relations are never removed"
      ),
      duplicateOf: nullableText(
        "Duplicate of issue ID/identifier. Null to remove"
      ),
      removeBlocks: texts("Issue IDs/identifiers to stop blocking"),
      removeBlockedBy: texts(
        "Issue IDs/identifiers to remove as blockers of this issue"
      ),
      removeRelatedTo: texts("Related issue IDs/identifiers to remove"),
    }),
    annotations: writes,
  },
  {
    name: "list_comments",
    description:
      "List comments on a Linear issue, project, initiative, document, project milestone, or project/initiative status update. Provide exactly one of `issueId`, `projectId`, `initiativeId`, `documentId`, `milestoneId`, or `statusUpdateId`. `statusUpdateType` applies only to `statusUpdateId`; omit it for every other parent. For issues, projects, and initiatives this returns both top-level discussion threads and inline description comments. Inline (anchored) comments carry a non-null `quotedText` set to the snippet of description text they reference. Returned comments include `author` and nullable `onBehalfOf`; when set, `onBehalfOf` identifies the user the agent author acted for. Files uploaded in comment bodies are returned in `attachments` with titles and download URLs, not issue attachment IDs. Signed upload URLs expire after five minutes; call list_comments again to refresh them. Download documents using these URLs and process them with your own file tools.",
    inputSchema: objectSchema({
      limit: limitProperty,
      cursor: cursorProperty,
      orderBy: orderByProperty,
      ...commentParents,
    }),
    annotations: readOnly,
  },
  {
    name: "save_comment",
    description:
      "Create or update a comment on a Linear issue, project, initiative, document, project milestone, or project/initiative status update. If `id` is provided, updates the existing comment; otherwise creates a new one. To start a new thread, pass `body` and exactly one of `issueId`, `projectId`, `initiativeId`, `documentId`, `milestoneId`, or `statusUpdateId` (`statusUpdateType` applies only to `statusUpdateId`; omit it for every other parent) — comments on issues/projects/initiatives become top-level discussion threads; comments on documents/milestones become description comments. A status update holds a single thread, so a comment on an update that already has one is added to it as a reply. To reply to an existing thread, pass `parentId` and `body`; the reply inherits the parent's thread type, so no entity reference is needed. Parent reference fields are ignored when `id` or `parentId` is provided (`statusUpdateType` is rejected instead). A new top-level comment starts a separate Linear thread and is not posted to a synced external thread. To post in a thread synced with Jira, Slack, or another service (for example, when asked to comment on the Jira thread), call `list_comments` on the issue, project, initiative, or status update that owns the thread. For project or initiative status updates, use `statusUpdateId`. Find the root comment (null `parentId`) whose body says the thread is synced with that service, and pass that root's `id` as `parentId`. When several threads match, such as an issue synced with more than one Jira issue, choose by the external link in the root's body. If no matching synced thread exists, do not post a top-level comment instead; report that no synced thread was found.",
    inputSchema: objectSchema(
      {
        id: text("Comment ID. If provided, updates the existing comment"),
        ...commentParents,
        parentId: text(
          "Parent comment ID (for replies, only when creating). To post in a thread synced with an external service such as Jira, pass the ID of that thread's root comment"
        ),
        body: text(
          "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe). To embed an image or file, upload it with prepare_file_upload and insert the returned markdown"
        ),
      },
      ["body"]
    ),
    annotations: writes,
  },
  {
    name: "delete_comment",
    description:
      "Delete a Linear comment. Inline description comments (those with non-null `quotedText`) anchor a mark in the editor, so their root cannot be deleted — delete the replies individually or resolve the thread instead.",
    inputSchema: objectSchema({ id: text("Comment ID") }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "list_teams",
    description:
      "List teams in the user's Linear workspace, including their parent IDs and hierarchy names",
    inputSchema: objectSchema({
      limit: limitProperty,
      cursor: cursorProperty,
      orderBy: orderByProperty,
      query: text("Search query"),
      parentTeam: text("Only direct sub-teams of this team (name, key, or ID)"),
      ancestorTeam: text(
        "All descendant teams of this team, at any depth, excluding itself (name, key, or ID)"
      ),
      includeArchived: includeArchivedProperty,
      createdAt: afterProperty("Created"),
      updatedAt: afterProperty("Updated"),
    }),
    annotations: readOnly,
  },
  {
    name: "get_user",
    description:
      "Retrieve one user's profile, email, admin, guest, and active flags, plus team IDs, names, and keys. Use list_users to find matching users.",
    inputSchema: objectSchema({ query: userProperty }, ["query"]),
    annotations: readOnly,
  },
  {
    name: "search_documentation",
    description:
      "Search Linear's product documentation for feature and usage guidance. Returns up to five results with titles, URLs, and content snippets per page.",
    inputSchema: objectSchema(
      {
        query: text(
          "Feature name, topic, or question to search for in Linear's product documentation"
        ),
        page: {
          type: "number",
          description:
            "Zero-based page number. Increment by one to fetch the next page for the same query",
          default: 0,
        },
      },
      ["query"]
    ),
    annotations: readOnly,
  },
  {
    name: "share_issue",
    description:
      "Share an issue with a workspace user who cannot otherwise access it. Use this tool only when the user explicitly asks to share the issue.",
    inputSchema: objectSchema(
      {
        issue: text(issueIdDescription),
        user: text(
          'User ID, name, email, or "me" Must be an email address or UUID.'
        ),
      },
      ["issue", "user"]
    ),
    annotations: writes,
  },
];

// The workspace.

const seededAt = (day: number): string =>
  `2026-11-${String(day).padStart(2, "0")}T09:00:00.000Z`;

const seedWorkspace = (): Workspace => {
  const team = {
    id: "8c1a3f2e-4b7d-4e0a-9f6c-2d5e8a1b3c40",
    key: "ENG",
    name: "Engineering",
  };
  const ada = {
    id: "3f6b9d2a-1c4e-4a8b-b7d0-5e2f8c1a9b61",
    name: "Ada Lovelace",
    displayName: "ada",
    email: "ada@acme.test",
    admin: true,
  };
  const grace = {
    id: "7a2c5e8b-3d1f-4b6a-8c9e-0f4d7b2a5c82",
    name: "Grace Hopper",
    displayName: "grace",
    email: "grace@acme.test",
    admin: false,
  };
  const states = [
    {
      id: "b1e0c7d4-2a5f-4c8e-9d3b-6f1a4e7c0d10",
      name: "Backlog",
      type: "backlog",
    },
    {
      id: "b1e0c7d4-2a5f-4c8e-9d3b-6f1a4e7c0d11",
      name: "Todo",
      type: "unstarted",
    },
    {
      id: "b1e0c7d4-2a5f-4c8e-9d3b-6f1a4e7c0d12",
      name: "In Progress",
      type: "started",
    },
    {
      id: "b1e0c7d4-2a5f-4c8e-9d3b-6f1a4e7c0d13",
      name: "Done",
      type: "completed",
    },
    {
      id: "b1e0c7d4-2a5f-4c8e-9d3b-6f1a4e7c0d14",
      name: "Canceled",
      type: "canceled",
    },
  ];
  const labels = [
    { id: "d4a7b0e3-5c8f-4e1a-a2d5-8b3e6f9c1a20", name: "Bug" },
    { id: "d4a7b0e3-5c8f-4e1a-a2d5-8b3e6f9c1a21", name: "Feature" },
    { id: "d4a7b0e3-5c8f-4e1a-a2d5-8b3e6f9c1a22", name: "Improvement" },
  ];
  const issue = (
    number: number,
    fields: Pick<
      Issue,
      | "title"
      | "description"
      | "priority"
      | "stateId"
      | "assigneeId"
      | "labelIds"
    >
  ): Issue => ({
    uuid: `e9f2a5c8-1b4d-4f7a-8e0c-3d6a9b2c5f${String(number).padStart(2, "0")}`,
    identifier: `ENG-${number}`,
    teamId: team.id,
    estimate: null,
    creatorId: ada.id,
    dueDate: null,
    parentId: null,
    sharedWith: [],
    createdAt: seededAt(number),
    updatedAt: seededAt(number + 10),
    ...fields,
  });
  const [backlog, todo, inProgress] = states;
  const [bug, feature, improvement] = labels;
  const first = issue(1, {
    title: "Sign-in fails with a long password",
    description: "Passwords over 72 characters are refused at sign-in.",
    priority: 2,
    stateId: todo?.id ?? "",
    assigneeId: ada.id,
    labelIds: [bug?.id ?? ""],
  });
  return {
    teams: [team],
    users: [ada, grace],
    states,
    labels,
    issues: [
      first,
      issue(2, {
        title: "Export the audit log as CSV",
        description: "Admins want the audit log in a spreadsheet.",
        priority: 3,
        stateId: inProgress?.id ?? "",
        assigneeId: grace.id,
        labelIds: [feature?.id ?? ""],
      }),
      issue(3, {
        title: "Dark mode for the settings page",
        description: "",
        priority: 0,
        stateId: backlog?.id ?? "",
        assigneeId: null,
        labelIds: [improvement?.id ?? ""],
      }),
    ],
    comments: [
      {
        id: "f0c3e6a9-2d5b-4e8c-b1f4-7a0d3c6e9b30",
        issueId: first.uuid,
        parentId: null,
        body: "I can reproduce this with a 73-character password.",
        authorId: grace.id,
        createdAt: seededAt(12),
        updatedAt: seededAt(12),
      },
      {
        id: "f0c3e6a9-2d5b-4e8c-b1f4-7a0d3c6e9b31",
        issueId: first.uuid,
        parentId: "f0c3e6a9-2d5b-4e8c-b1f4-7a0d3c6e9b30",
        body: "bcrypt stops at 72 bytes; I'll move us to Argon2id.",
        authorId: ada.id,
        createdAt: seededAt(13),
        updatedAt: seededAt(13),
      },
    ],
  };
};

const documentation = [
  {
    title: "Issue properties",
    url: "https://linear.app/docs/issue-properties",
    content:
      "Every issue has a status, a priority, an assignee, labels and an estimate.",
  },
  {
    title: "Comments",
    url: "https://linear.app/docs/comment-on-issues",
    content:
      "Comment on issues to discuss them; replies keep a discussion in one thread.",
  },
  {
    title: "MCP server",
    url: "https://linear.app/docs/mcp",
    content:
      "Linear's MCP server at https://mcp.linear.app/mcp signs in with OAuth.",
  },
];

// What the tools run.

/** A tool execution error: the result says `isError`, with this message. */
class ToolFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailureError";
  }
}

const fail = (message: string): never => {
  throw new ToolFailureError(message);
};

const stringArg = (args: Args, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string"
    ? value
    : fail(`Invalid input: ${key} must be a string`);
};

const requiredStringArg = (args: Args, key: string): string =>
  stringArg(args, key) ?? fail(`Invalid input: ${key} is required`);

const nullableStringArg = (
  args: Args,
  key: string
): string | null | undefined =>
  args[key] === null ? null : stringArg(args, key);

const numberArg = (args: Args, key: string): number | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number"
    ? value
    : fail(`Invalid input: ${key} must be a number`);
};

const stringsArg = (args: Args, key: string): string[] | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  const items: unknown[] = Array.isArray(value)
    ? value
    : fail(`Invalid input: ${key} must be an array`);
  const strings = items.filter(
    (item): item is string => typeof item === "string"
  );
  return strings.length === items.length
    ? strings
    : fail(`Invalid input: ${key} must hold strings`);
};

const sameText = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const findTeam = (ws: Workspace, ref: string): Team =>
  ws.teams.find(
    (team) =>
      team.id === ref || sameText(team.key, ref) || sameText(team.name, ref)
  ) ?? fail(`Team not found: ${ref}`);

const findUser = (ws: Workspace, ref: string, actor: User): User => {
  if (ref === "me") {
    return actor;
  }
  return (
    ws.users.find(
      (user) =>
        user.id === ref ||
        sameText(user.email, ref) ||
        sameText(user.name, ref) ||
        sameText(user.displayName, ref)
    ) ?? fail(`User not found: ${ref}`)
  );
};

const findState = (ws: Workspace, ref: string): State =>
  ws.states.find(
    (state) =>
      state.id === ref || sameText(state.name, ref) || state.type === ref
  ) ?? fail(`State not found: ${ref}`);

const findLabel = (ws: Workspace, ref: string): Label =>
  ws.labels.find((label) => label.id === ref || sameText(label.name, ref)) ??
  fail(`Label not found: ${ref}`);

const findIssue = (ws: Workspace, ref: string): Issue =>
  ws.issues.find(
    (issue) => issue.uuid === ref || sameText(issue.identifier, ref)
  ) ?? fail(`Issue not found: ${ref}`);

const findComment = (ws: Workspace, id: string): Comment =>
  ws.comments.find((comment) => comment.id === id) ??
  fail(`Comment not found: ${id}`);

const priorityNames = ["No priority", "Urgent", "High", "Medium", "Low"];

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

const issueView = (ws: Workspace, issue: Issue): Record<string, unknown> => {
  const state = ws.states.find(({ id }) => id === issue.stateId);
  const team = ws.teams.find(({ id }) => id === issue.teamId);
  const creator = ws.users.find(({ id }) => id === issue.creatorId);
  const assignee = ws.users.find(({ id }) => id === issue.assigneeId);
  const parent = ws.issues.find(({ uuid }) => uuid === issue.parentId);
  const slug = slugOf(issue.title);
  return {
    id: issue.identifier,
    uuid: issue.uuid,
    title: issue.title,
    description: issue.description,
    priority: { value: issue.priority, name: priorityNames[issue.priority] },
    estimate: issue.estimate,
    url: `https://linear.app/acme/issue/${issue.identifier}/${slug}`,
    gitBranchName: `${creator?.displayName ?? "linear"}/${issue.identifier.toLowerCase()}-${slug}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    status: state?.name,
    statusType: state?.type,
    labels: issue.labelIds.flatMap(
      (labelId) => ws.labels.find(({ id }) => id === labelId)?.name ?? []
    ),
    createdBy: creator?.name,
    createdById: issue.creatorId,
    assignee: assignee?.name ?? null,
    assigneeId: issue.assigneeId,
    team: team?.name,
    teamId: issue.teamId,
    parentId: parent?.identifier ?? null,
  };
};

/** The fields asked for, `id` always among them; the whole view if none. */
const selected = (
  view: Record<string, unknown>,
  args: Args
): Record<string, unknown> => {
  const fields = stringsArg(args, "fields") ?? [];
  if (fields.length === 0) {
    return view;
  }
  const unknown = fields.find((field) => !issueFields.includes(field));
  if (unknown !== undefined) {
    fail(`Invalid input: unknown field ${unknown}`);
  }
  return Object.fromEntries(
    ["id", ...fields.filter((field) => field !== "id")].map((field) => [
      field,
      view[field] ?? null,
    ])
  );
};

/** One page of `items`, newest first by `orderBy`, after `cursor`. */
const paged = <
  Item extends { id: string; createdAt: string; updatedAt: string },
>(
  items: readonly Item[],
  args: Args
): { page: Item[]; hasNextPage: boolean; cursor?: string } => {
  const limit = numberArg(args, "limit") ?? defaultPageLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxPageLimit) {
    fail(`Invalid input: limit must be an integer from 1 to ${maxPageLimit}`);
  }
  const orderBy = stringArg(args, "orderBy") ?? "updatedAt";
  if (orderBy !== "createdAt" && orderBy !== "updatedAt") {
    fail("Invalid input: orderBy must be createdAt or updatedAt");
  }
  const key = orderBy === "createdAt" ? "createdAt" : "updatedAt";
  const ordered = items.toSorted(
    (a, b) => b[key].localeCompare(a[key]) || a.id.localeCompare(b.id)
  );
  const cursor = stringArg(args, "cursor");
  const start =
    cursor === undefined ? 0 : ordered.findIndex(({ id }) => id === cursor) + 1;
  if (start === 0 && cursor !== undefined) {
    fail("Invalid input: cursor isn't one this list gave");
  }
  const page = ordered.slice(start, start + limit);
  const hasNextPage = start + limit < ordered.length;
  const last = page.at(-1);
  return {
    page,
    hasNextPage,
    ...(hasNextPage && last !== undefined ? { cursor: last.id } : {}),
  };
};

/** The filters of `list_issues` the workspace models; others are ignored. */
const issueFilters = (
  args: Args,
  ws: Workspace,
  actor: User
): ((issue: Issue) => boolean)[] => {
  const filters: ((issue: Issue) => boolean)[] = [];
  const query = stringArg(args, "query")?.toLowerCase();
  if (query !== undefined) {
    filters.push(({ title, description }) =>
      `${title}\n${description}`.toLowerCase().includes(query)
    );
  }
  const team = stringArg(args, "team");
  if (team !== undefined) {
    const { id } = findTeam(ws, team);
    filters.push(({ teamId }) => teamId === id);
  }
  const state = stringArg(args, "state");
  if (state !== undefined) {
    const { id } = findState(ws, state);
    filters.push(({ stateId }) => stateId === id);
  }
  const assignee = nullableStringArg(args, "assignee");
  if (assignee === null || assignee === "null") {
    filters.push(({ assigneeId }) => assigneeId === null);
  } else if (assignee !== undefined) {
    const { id } = findUser(ws, assignee, actor);
    filters.push(({ assigneeId }) => assigneeId === id);
  }
  const creator = stringArg(args, "creator");
  if (creator !== undefined) {
    const { id } = findUser(ws, creator, actor);
    filters.push(({ creatorId }) => creatorId === id);
  }
  const label = stringArg(args, "label");
  if (label !== undefined) {
    const { id } = findLabel(ws, label);
    filters.push(({ labelIds }) => labelIds.includes(id));
  }
  const priority = numberArg(args, "priority");
  if (priority !== undefined) {
    filters.push((issue) => issue.priority === priority);
  }
  const parent = stringArg(args, "parentId");
  if (parent !== undefined) {
    const { uuid } = findIssue(ws, parent);
    filters.push(({ parentId }) => parentId === uuid);
  }
  return filters;
};

const occurrences = (content: string, part: string): number =>
  content.split(part).length - 1;

/** Where `part` is in `content`, which must hold it exactly once. */
const onlyAt = (content: string, part: string, what: string): number => {
  const count = occurrences(content, part);
  if (count !== 1) {
    fail(
      `${what} must match the current content exactly once; it matches ${count} times`
    );
  }
  return content.indexOf(part);
};

/** `content` after one `patch` operation of `save_issue`. */
const patched = (content: string, operation: unknown): string => {
  const op: Args = isRecord(operation)
    ? operation
    : fail("Invalid input: a patch operation must be an object");
  const arg = (key: string) => requiredStringArg(op, key);
  switch (op.op) {
    case "replace": {
      const old = arg("old_string");
      const replacement = arg("new_string");
      if (op.replace_all === true) {
        return content.includes(old)
          ? content.replaceAll(old, () => replacement)
          : fail("old_string doesn't match the current content");
      }
      const at = onlyAt(content, old, "old_string");
      return `${content.slice(0, at)}${replacement}${content.slice(at + old.length)}`;
    }
    case "insert_before": {
      const at = onlyAt(content, arg("anchor"), "anchor");
      return `${content.slice(0, at)}${arg("text")}${content.slice(at)}`;
    }
    case "insert_after": {
      const anchor = arg("anchor");
      const at = onlyAt(content, anchor, "anchor") + anchor.length;
      return `${content.slice(0, at)}${arg("text")}${content.slice(at)}`;
    }
    case "prepend": {
      return `${arg("text")}${content}`;
    }
    case "append": {
      return `${content}${arg("text")}`;
    }
    case "replace_range": {
      const from = arg("from");
      const start = onlyAt(content, from, "from");
      const after = start + from.length;
      const end = after + onlyAt(content.slice(after), arg("to"), "to");
      return `${content.slice(0, start)}${arg("new_string")}${content.slice(end)}`;
    }
    default: {
      return fail("Invalid input: unknown patch op");
    }
  }
};

/** The description after `save_issue`'s `description` or `patch`. */
const describedAs = (current: string, args: Args): string => {
  const description = stringArg(args, "description");
  const { patch } = args;
  if (patch === undefined) {
    return description ?? current;
  }
  if (description !== undefined) {
    fail("Invalid input: pass either description or patch, not both");
  }
  const operations: unknown[] = Array.isArray(patch)
    ? patch
    : fail("Invalid input: patch must be an array");
  let content = current;
  for (const operation of operations) {
    content = patched(content, operation);
  }
  return content;
};

/** The labels after `save_issue`'s `labels`, `addLabels` and `removeLabels`. */
const labelsAfter = (
  labelIds: string[],
  args: Args,
  ws: Workspace
): string[] => {
  const labels = stringsArg(args, "labels");
  const added = (stringsArg(args, "addLabels") ?? []).map(
    (label) => findLabel(ws, label).id
  );
  const removed = new Set(
    (stringsArg(args, "removeLabels") ?? []).map(
      (label) => findLabel(ws, label).id
    )
  );
  if (labels !== undefined && added.length + removed.size > 0) {
    fail(
      "Invalid input: labels can't be combined with addLabels or removeLabels"
    );
  }
  const kept = labels?.map((label) => findLabel(ws, label).id) ?? labelIds;
  return [...new Set([...kept, ...added])].filter((id) => !removed.has(id));
};

/**
 * `issue` with the changes `save_issue` was given, of the fields the
 * workspace models; the rest are ignored.
 */
const changed = (
  issue: Issue,
  args: Args,
  ws: Workspace,
  actor: User
): Issue => {
  const next: Issue = { ...issue, labelIds: [...issue.labelIds] };
  const title = stringArg(args, "title");
  if (title !== undefined) {
    next.title = title;
  }
  next.description = describedAs(next.description, args);
  const priority = numberArg(args, "priority");
  if (priority !== undefined) {
    next.priority =
      Number.isInteger(priority) && priority >= 0 && priority <= highestPriority
        ? priority
        : fail("Invalid input: priority must be 0 to 4");
  }
  const state = stringArg(args, "state");
  if (state !== undefined) {
    next.stateId = findState(ws, state).id;
  }
  const assignee = nullableStringArg(args, "assignee");
  if (assignee !== undefined) {
    next.assigneeId =
      assignee === null ? null : findUser(ws, assignee, actor).id;
  }
  next.labelIds = labelsAfter(next.labelIds, args, ws);
  const dueDate = nullableStringArg(args, "dueDate");
  if (dueDate !== undefined) {
    next.dueDate = dueDate;
  }
  next.estimate =
    args.estimate === null
      ? null
      : (numberArg(args, "estimate") ?? next.estimate);
  const parent = nullableStringArg(args, "parentId");
  if (parent !== undefined) {
    next.parentId = parent === null ? null : findIssue(ws, parent).uuid;
  }
  if (next.parentId === next.uuid) {
    fail("An issue can't be its own parent");
  }
  return next;
};

const saveIssue = (
  args: Args,
  ws: Workspace,
  actor: User
): Record<string, unknown> => {
  if (stringArg(args, "template") !== undefined) {
    fail(`Template not found: ${String(args.template)}`);
  }
  const id = stringArg(args, "id");
  if (id !== undefined) {
    const issue = findIssue(ws, id);
    const updated = { ...changed(issue, args, ws, actor), updatedAt: nowIso() };
    ws.issues = ws.issues.map((each) => (each === issue ? updated : each));
    return issueView(ws, updated);
  }
  if (args.patch !== undefined || args.removeLabels !== undefined) {
    fail(
      "Invalid input: patch and removeLabels are only valid when updating an issue"
    );
  }
  const team = findTeam(ws, requiredStringArg(args, "team"));
  const number =
    Math.max(
      0,
      ...ws.issues
        .filter(({ teamId }) => teamId === team.id)
        .map(({ identifier }) => Number(identifier.split("-")[1]))
    ) + 1;
  const createdAt = nowIso();
  const draft: Issue = {
    uuid: crypto.randomUUID(),
    identifier: `${team.key}-${number}`,
    teamId: team.id,
    title: requiredStringArg(args, "title"),
    description: "",
    priority: 0,
    estimate: null,
    stateId: findState(ws, "unstarted").id,
    assigneeId: null,
    creatorId: actor.id,
    labelIds: [],
    dueDate: null,
    parentId: null,
    sharedWith: [],
    createdAt,
    updatedAt: createdAt,
  };
  const created = changed(draft, args, ws, actor);
  ws.issues.push(created);
  return issueView(ws, created);
};

const commentParentKeys = [
  "issueId",
  "projectId",
  "initiativeId",
  "documentId",
  "milestoneId",
  "statusUpdateId",
];

/** The issue a comment tool names as the parent: the one kind modelled. */
const commentedIssue = (args: Args, ws: Workspace): Issue => {
  const given = commentParentKeys.filter((key) => args[key] !== undefined);
  const [key] = given;
  if (given.length !== 1 || key === undefined) {
    fail(
      `Invalid input: provide exactly one of ${commentParentKeys.join(", ")}`
    );
  }
  if (args.statusUpdateType !== undefined && key !== "statusUpdateId") {
    fail("Invalid input: statusUpdateType applies only to statusUpdateId");
  }
  if (key !== "issueId") {
    fail(`Not found: ${String(args[key ?? ""])}`);
  }
  return findIssue(ws, requiredStringArg(args, "issueId"));
};

const commentView = (
  ws: Workspace,
  comment: Comment
): Record<string, unknown> => {
  const author = ws.users.find(({ id }) => id === comment.authorId);
  return {
    id: comment.id,
    body: comment.body,
    author: author === undefined ? null : { id: author.id, name: author.name },
    onBehalfOf: null,
    parentId: comment.parentId,
    quotedText: null,
    attachments: [],
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
};

const saveComment = (
  args: Args,
  ws: Workspace,
  actor: User
): Record<string, unknown> => {
  const body = requiredStringArg(args, "body");
  const id = stringArg(args, "id");
  if (id !== undefined) {
    const comment = findComment(ws, id);
    comment.body = body;
    comment.updatedAt = nowIso();
    return commentView(ws, comment);
  }
  const parentId = stringArg(args, "parentId");
  const parent = parentId === undefined ? undefined : findComment(ws, parentId);
  const createdAt = nowIso();
  const comment: Comment = {
    id: crypto.randomUUID(),
    issueId: parent?.issueId ?? commentedIssue(args, ws).uuid,
    parentId: parent === undefined ? null : (parent.parentId ?? parent.id),
    body,
    authorId: actor.id,
    createdAt,
    updatedAt: createdAt,
  };
  ws.comments.push(comment);
  return commentView(ws, comment);
};

const emailPattern = /^[^\s@]+@[^\s@]+$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface Handler {
  /** Needs the `write` scope. */
  writes: boolean;
  run: (args: Args, ws: Workspace, actor: User) => Record<string, unknown>;
}

/** What each of Linear's tools does, by name. */
const handlers = new Map<string, Handler>([
  [
    "list_issues",
    {
      writes: false,
      run: (args, ws, actor) => {
        const filters = issueFilters(args, ws, actor);
        const views = ws.issues
          .filter((issue) => filters.every((matches) => matches(issue)))
          .map((issue) => ({
            ...issueView(ws, issue),
            id: issue.identifier,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          }));
        const { page, ...rest } = paged(views, args);
        return { issues: page.map((view) => selected(view, args)), ...rest };
      },
    },
  ],
  [
    "get_issue",
    {
      writes: false,
      run: (args, ws) => {
        const issue = findIssue(ws, requiredStringArg(args, "id"));
        const view = {
          ...issueView(ws, issue),
          attachments: [],
          documents: [],
        };
        return selected(view, args);
      },
    },
  ],
  ["save_issue", { writes: true, run: saveIssue }],
  [
    "list_comments",
    {
      writes: false,
      run: (args, ws) => {
        const issue = commentedIssue(args, ws);
        const { page, ...rest } = paged(
          ws.comments.filter(({ issueId }) => issueId === issue.uuid),
          args
        );
        return {
          comments: page.map((comment) => commentView(ws, comment)),
          ...rest,
        };
      },
    },
  ],
  ["save_comment", { writes: true, run: saveComment }],
  [
    "delete_comment",
    {
      writes: true,
      run: (args, ws) => {
        const { id } = findComment(ws, requiredStringArg(args, "id"));
        ws.comments = ws.comments.filter(
          (comment) => comment.id !== id && comment.parentId !== id
        );
        return { success: true };
      },
    },
  ],
  [
    "list_teams",
    {
      writes: false,
      run: (args, ws) => {
        const query = stringArg(args, "query")?.toLowerCase() ?? "";
        const teams = ws.teams
          .filter(({ key, name }) =>
            `${key} ${name}`.toLowerCase().includes(query)
          )
          .map((team) => ({
            ...team,
            parentId: null,
            hierarchyNames: [team.name],
            createdAt: seededAt(1),
            updatedAt: seededAt(1),
          }));
        const { page, ...rest } = paged(teams, args);
        return { teams: page, ...rest };
      },
    },
  ],
  [
    "get_user",
    {
      writes: false,
      run: (args, ws, actor) => {
        const user = findUser(ws, requiredStringArg(args, "query"), actor);
        return {
          ...user,
          guest: false,
          active: true,
          teams: ws.teams.map(({ id, name, key }) => ({ id, name, key })),
        };
      },
    },
  ],
  [
    "search_documentation",
    {
      writes: false,
      run: (args) => {
        const words = requiredStringArg(args, "query")
          .toLowerCase()
          .split(/\s+/u)
          .filter(Boolean);
        const page = numberArg(args, "page") ?? 0;
        if (!Number.isInteger(page) || page < 0) {
          fail("Invalid input: page must be a whole number from 0");
        }
        const found = documentation.filter(({ title, content }) =>
          words.some((word) =>
            `${title} ${content}`.toLowerCase().includes(word)
          )
        );
        const start = page * documentationPageSize;
        return {
          results: found.slice(start, start + documentationPageSize),
          page,
          hasNextPage: start + documentationPageSize < found.length,
        };
      },
    },
  ],
  [
    "share_issue",
    {
      writes: true,
      run: (args, ws, actor) => {
        const issue = findIssue(ws, requiredStringArg(args, "issue"));
        const ref = requiredStringArg(args, "user");
        if (!emailPattern.test(ref) && !uuidPattern.test(ref)) {
          fail("Invalid input: user must be an email address or UUID");
        }
        const user = findUser(ws, ref, actor);
        issue.sharedWith = [...new Set([...issue.sharedWith, user.id])];
        return {
          success: true,
          issue: issue.identifier,
          user: { id: user.id, name: user.name },
        };
      },
    },
  ],
]);

const toolResult = (value: Record<string, unknown>) => ({
  resultType: "complete",
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const toolError = (message: string) => ({
  resultType: "complete",
  content: [{ type: "text", text: message }],
  isError: true,
});

const toolsCursor = (offset: number): string => btoa(`tools:${offset}`);

const toolsOffset = (cursor: string): number | undefined => {
  try {
    const offset = /^tools:(?<offset>[1-9]\d*)$/u.exec(atob(cursor))?.groups
      ?.offset;
    return offset === undefined ? undefined : Number(offset);
  } catch {
    return undefined;
  }
};

/** A nonempty list of strings, as client metadata has them. */
const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: unknown[] = value;
  const each = items.filter((item): item is string => typeof item === "string");
  return each.length === items.length && each.length > 0 ? each : undefined;
};

const authMethods: readonly AuthMethod[] = [
  "none",
  "client_secret_post",
  "client_secret_basic",
];
const isAuthMethod = (value: unknown): value is AuthMethod =>
  authMethods.some((method) => method === value);
const registrableGrants = ["authorization_code", "refresh_token"];
const applicationTypes = new Set(["web", "native"]);

/** The client a registration request describes (RFC 7591), or its refusal. */
const registrationOf = (
  body: Record<string, unknown>
): Registration | Response => {
  const {
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method = "client_secret_basic",
    grant_types: grantTypes = ["authorization_code"],
    response_types: responseTypes = ["code"],
    application_type: applicationType = "web",
    client_name: clientName,
  } = body;
  const uris = stringList(redirectUris);
  if (uris === undefined || !uris.every(isRedirectUrl)) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must be https URLs or http to a loopback host"
    );
  }
  const grants = stringList(grantTypes) ?? [];
  const responses = stringList(responseTypes) ?? [];
  const listsValid =
    grants.length > 0 &&
    grants.every((grant) => registrableGrants.includes(grant)) &&
    responses.length > 0 &&
    responses.every((type) => type === "code");
  if (
    !isAuthMethod(method) ||
    typeof applicationType !== "string" ||
    !applicationTypes.has(applicationType) ||
    (clientName !== undefined && typeof clientName !== "string") ||
    !listsValid
  ) {
    return oauthError(
      "invalid_client_metadata",
      "The client metadata isn't valid"
    );
  }
  return {
    clientId: randomToken(16),
    clientSecret: method === "none" ? undefined : randomToken(),
    clientName,
    redirectUris: uris,
    grantTypes: grants,
    responseTypes: responses,
    tokenEndpointAuthMethod: method,
    applicationType,
  };
};

const refuse = (reason: string): never => {
  throw new Error(`Linear refuses the authorization request: ${reason}`);
};

/**
 * That `clientId` may ask to be sent back to `redirectUri`: a registered
 * client to one it registered; a client known by its metadata document,
 * which the fake doesn't fetch, to any https URL.
 */
const checkClient = (
  clientId: string,
  redirectUri: string,
  registered: Registration | undefined
): void => {
  if (registered === undefined && !isDocumentClientId(clientId)) {
    refuse(`client_id ${clientId} isn't registered`);
  }
  if (
    registered !== undefined &&
    !registered.redirectUris.includes(redirectUri)
  ) {
    refuse(`redirect_uri ${redirectUri} isn't registered for the client`);
  }
  if (registered === undefined && !isRedirectUrl(redirectUri)) {
    refuse(`redirect_uri ${redirectUri} isn't an https or loopback URL`);
  }
};

/** What an authorization request asks for, once Linear's checks pass. */
const authorizationRequest = (
  authorizationUrl: string,
  registrations: readonly Registration[]
) => {
  const url = new URL(authorizationUrl);
  if (`${url.origin}${url.pathname}` !== `${linearOrigin}/authorize`) {
    refuse(`it goes to ${url.origin}${url.pathname}`);
  }
  const twice = repeated(url.searchParams);
  if (twice !== undefined) {
    refuse(`${twice} is given more than once`);
  }
  const param = (name: string) =>
    url.searchParams.get(name) ?? refuse(`${name} is missing`);
  if (param("response_type") !== "code") {
    refuse("response_type isn't code");
  }
  const clientId = param("client_id");
  const redirectUri = param("redirect_uri");
  const registered = registrations.find((each) => each.clientId === clientId);
  checkClient(clientId, redirectUri, registered);
  if (param("code_challenge_method") !== "S256") {
    refuse("code_challenge_method isn't S256");
  }
  const challenge = param("code_challenge");
  if (!pkceChallenge.test(challenge)) {
    refuse("code_challenge isn't an S256 challenge");
  }
  const resource = param("resource");
  if (resource !== linearMcpUrl) {
    refuse(`resource ${resource} isn't ${linearMcpUrl}`);
  }
  const scope = param("scope");
  if (!scope.split(" ").every((each) => grantableScopes.includes(each))) {
    refuse(`scope ${scope} isn't within ${grantableScopes.join(" ")}`);
  }
  const state = param("state");
  if (state === "") {
    refuse("state is empty");
  }
  return {
    clientId,
    redirectUri,
    challenge,
    resource,
    scope,
    state,
    registered,
  };
};

/** Why a request to `/mcp` isn't a JSON-RPC request to read, if it isn't. */
const malformed = (
  request: Request,
  message: unknown
): Response | undefined => {
  const accept = new Set(
    (request.headers.get("accept") ?? "")
      .split(",")
      .map((part) => part.split(";")[0]?.trim().toLowerCase())
  );
  if (!accept.has("application/json") || !accept.has("text/event-stream")) {
    return rpcError(
      null,
      -32_600,
      "Accept must list application/json and text/event-stream",
      406
    );
  }
  if (!hasMediaType(request, "application/json")) {
    return rpcError(
      null,
      -32_600,
      "Content-Type must be application/json",
      415
    );
  }
  if (message === undefined) {
    return rpcError(null, -32_700, "Parse error", 400);
  }
  if (
    !isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (message.params !== undefined && !isRecord(message.params))
  ) {
    return rpcError(null, -32_600, "Invalid Request", 400);
  }
  return undefined;
};

type FakeState = Omit<LinearMcpFake, "reset" | "consent" | "handle">;

const freshState = (): FakeState => ({
  tools: linearTools(),
  ttlMs: defaultTtlMs,
  pageSize: undefined,
  answerAs: "json",
  accessTokenLifetimeSeconds: defaultAccessTokenLifetimeSeconds,
  next: undefined,
  down: false,
  calls: [],
  metadataRequests: [],
  registrations: [],
  documentClients: [],
  tokens: new Map(),
  workspace: seedWorkspace(),
});

/** The longest a timer waits: a server that never answers. */
const forever = 2_147_483_647;

/**
 * The fake, fresh as `reset()` leaves it; pass `handle` to the fake
 * internet (test/internet.ts) for requests to `linearOrigin`.
 */
export const linearMcpFake = (): LinearMcpFake => {
  const fake = freshState();
  const codes = new Map<string, Authorization>();
  const grants = new Map<string, Grant>();
  const refreshTokens = new Map<string, RefreshToken>();

  const revokeGrant = (id: string): void => {
    const grant = grants.get(id);
    if (grant !== undefined) {
      grant.revoked = true;
    }
    for (const token of fake.tokens.values()) {
      if (token.grant === id) {
        token.revoked = true;
      }
    }
  };

  const tokenAnswer = (
    grant: Grant,
    client: Client,
    scope: string
  ): Response => {
    const accessToken = randomToken();
    const lifetime = fake.accessTokenLifetimeSeconds;
    fake.tokens.set(accessToken, {
      clientId: grant.clientId,
      resource: grant.resource,
      scope,
      revoked: false,
      expiresAt: Date.now() + lifetime * msPerSecond,
      grant: grant.id,
    });
    const refreshToken = client.grantTypes.includes("refresh_token")
      ? randomToken()
      : undefined;
    if (refreshToken !== undefined) {
      refreshTokens.set(refreshToken, { grant: grant.id, used: false });
    }
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: lifetime,
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
        scope,
      },
      { headers: noStore }
    );
  };

  /** The client a token request authenticates as, or why it can't. */
  const authenticated = (
    request: Request,
    form: URLSearchParams
  ): Client | Response => {
    const header = request.headers.get("authorization");
    const formId = form.get("client_id");
    const formSecret = form.get("client_secret");
    if (header !== null) {
      const credentials = header.startsWith("Basic ")
        ? basicCredentials(header)
        : undefined;
      if (credentials === undefined || formSecret !== null) {
        return invalidClient("Client authentication failed", true);
      }
      const [clientId, secret] = credentials;
      const registered = fake.registrations.find(
        (each) => each.clientId === clientId
      );
      if (
        registered?.tokenEndpointAuthMethod !== "client_secret_basic" ||
        registered.clientSecret !== secret ||
        (formId !== null && formId !== clientId)
      ) {
        return invalidClient("Client authentication failed", true);
      }
      return registered;
    }
    if (formId === null) {
      return invalidClient("client_id is missing", false);
    }
    const registered = fake.registrations.find(
      (each) => each.clientId === formId
    );
    if (registered === undefined) {
      return fake.documentClients.some((each) => each.clientId === formId) &&
        formSecret === null
        ? { clientId: formId, grantTypes: registrableGrants }
        : invalidClient("Client authentication failed", false);
    }
    const authenticates =
      registered.tokenEndpointAuthMethod === "none"
        ? formSecret === null
        : registered.tokenEndpointAuthMethod === "client_secret_post" &&
          formSecret === registered.clientSecret;
    return authenticates
      ? registered
      : invalidClient("Client authentication failed", false);
  };

  const redeemCode = async (
    form: URLSearchParams,
    client: Client
  ): Promise<Response> => {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (code === null || redirectUri === null || verifier === null) {
      return oauthError(
        "invalid_request",
        "code, redirect_uri and code_verifier are required"
      );
    }
    const authorization = codes.get(code);
    if (
      authorization === undefined ||
      authorization.clientId !== client.clientId
    ) {
      return oauthError("invalid_grant", "The code is invalid");
    }
    if (authorization.redeemedFor !== undefined) {
      // A code used twice: what it was redeemed for is revoked too.
      revokeGrant(authorization.redeemedFor);
      return oauthError("invalid_grant", "The code was already used");
    }
    if (
      authorization.expiresAt <= Date.now() ||
      authorization.redirectUri !== redirectUri
    ) {
      return oauthError(
        "invalid_grant",
        "The code is expired or for another redirect_uri"
      );
    }
    if (
      !pkceVerifier.test(verifier) ||
      (await s256(verifier)) !== authorization.challenge
    ) {
      return oauthError(
        "invalid_grant",
        "The code_verifier doesn't match the code_challenge"
      );
    }
    if (form.get("resource") !== authorization.resource) {
      return oauthError(
        "invalid_target",
        "The resource isn't the one authorized"
      );
    }
    const grant: Grant = {
      id: crypto.randomUUID(),
      clientId: client.clientId,
      resource: authorization.resource,
      scope: authorization.scope,
      revoked: false,
    };
    grants.set(grant.id, grant);
    authorization.redeemedFor = grant.id;
    return tokenAnswer(grant, client, grant.scope);
  };

  const refresh = (form: URLSearchParams, client: Client): Response => {
    const held = refreshTokens.get(form.get("refresh_token") ?? "");
    const grant = held === undefined ? undefined : grants.get(held.grant);
    if (
      held === undefined ||
      grant === undefined ||
      grant.clientId !== client.clientId ||
      grant.revoked
    ) {
      return oauthError("invalid_grant", "The refresh token is invalid");
    }
    if (held.used) {
      // A rotated refresh token used again: it was stolen, or replayed.
      revokeGrant(grant.id);
      return oauthError("invalid_grant", "The refresh token was already used");
    }
    if (form.get("resource") !== grant.resource) {
      return oauthError(
        "invalid_target",
        "The resource isn't the one authorized"
      );
    }
    const asked = form.get("scope");
    const granted = grant.scope.split(" ");
    if (
      asked !== null &&
      !asked.split(" ").every((scope) => granted.includes(scope))
    ) {
      return oauthError("invalid_scope", "The scope exceeds the one granted");
    }
    held.used = true;
    return tokenAnswer(grant, client, asked ?? grant.scope);
  };

  /** RFC 7009: revokes the client's own token; any other token is ignored. */
  const revoke = (form: URLSearchParams, client: Client): Response => {
    const token = form.get("token") ?? "";
    const access = fake.tokens.get(token);
    if (access?.clientId === client.clientId) {
      access.revoked = true;
    }
    const held = refreshTokens.get(token);
    if (
      held !== undefined &&
      grants.get(held.grant)?.clientId === client.clientId
    ) {
      revokeGrant(held.grant);
    }
    return new Response(null, { status: 200, headers: noStore });
  };

  const tokenEndpoint = async (request: Request): Promise<Response> => {
    if (!hasMediaType(request, "application/x-www-form-urlencoded")) {
      return oauthError("invalid_request", "The body must be form-encoded");
    }
    const form = new URLSearchParams(
      new TextDecoder().decode(await request.arrayBuffer())
    );
    const twice = repeated(form);
    if (twice !== undefined) {
      return oauthError("invalid_request", `${twice} is given more than once`);
    }
    const client = authenticated(request, form);
    if (client instanceof Response) {
      return client;
    }
    const grantType = form.get("grant_type");
    if (grantType === null) {
      return form.has("token")
        ? revoke(form, client)
        : oauthError("invalid_request", "grant_type is missing");
    }
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError(
        "unsupported_grant_type",
        `${grantType} isn't supported`
      );
    }
    if (!client.grantTypes.includes(grantType)) {
      return oauthError(
        "unauthorized_client",
        `The client didn't register ${grantType}`
      );
    }
    return grantType === "authorization_code"
      ? await redeemCode(form, client)
      : refresh(form, client);
  };

  const register = async (request: Request): Promise<Response> => {
    const body = hasMediaType(request, "application/json")
      ? parseJson(await request.text())
      : undefined;
    if (!isRecord(body)) {
      return oauthError(
        "invalid_client_metadata",
        "The body must be a JSON object"
      );
    }
    const registration = registrationOf(body);
    if (registration instanceof Response) {
      return registration;
    }
    fake.registrations.push(registration);
    return Response.json(
      {
        client_id: registration.clientId,
        client_id_issued_at: Math.floor(Date.now() / msPerSecond),
        ...(registration.clientSecret === undefined
          ? {}
          : {
              client_secret: registration.clientSecret,
              client_secret_expires_at: 0,
            }),
        ...(registration.clientName === undefined
          ? {}
          : { client_name: registration.clientName }),
        redirect_uris: registration.redirectUris,
        grant_types: registration.grantTypes,
        response_types: registration.responseTypes,
        token_endpoint_auth_method: registration.tokenEndpointAuthMethod,
        application_type: registration.applicationType,
      },
      { status: 201, headers: noStore }
    );
  };

  /** The access token a request to `/mcp` bears, or the 401 it gets. */
  const bearer = (request: Request): IssuedToken | Response => {
    const [scheme, token, ...rest] = (
      request.headers.get("authorization") ?? ""
    ).split(" ");
    if (
      scheme?.toLowerCase() !== "bearer" ||
      token === undefined ||
      token === "" ||
      rest.length > 0
    ) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": bearerChallenge() },
      });
    }
    const issued = fake.tokens.get(token);
    if (
      issued === undefined ||
      issued.revoked ||
      issued.expiresAt <= Date.now() ||
      issued.resource !== linearMcpUrl
    ) {
      return Response.json(
        {
          error: "invalid_token",
          error_description: "The access token is invalid",
        },
        {
          status: 401,
          headers: { "www-authenticate": bearerChallenge("invalid_token") },
        }
      );
    }
    return issued;
  };

  /** A result, as JSON or as an event stream of one event. */
  const answer = (id: string | number, result: unknown): Response => {
    const message = { jsonrpc: "2.0", id, result };
    if (fake.answerAs === "json") {
      return Response.json(message);
    }
    return new Response(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      }
    );
  };

  /** Where the headers don't say what the body does (Server Validation). */
  const headerProblem = (
    request: Request,
    id: string | number,
    method: string,
    params: Args
  ): Response | undefined => {
    const version = request.headers.get("mcp-protocol-version");
    if (version === null) {
      return headerMismatch(id, "the MCP-Protocol-Version header is missing");
    }
    if (version !== protocolVersion) {
      return rpcError(id, -32_022, "Unsupported protocol version", 400, {
        supported: [protocolVersion],
        requested: version,
      });
    }
    const meta = params._meta;
    if (!isRecord(meta) || meta[versionMetaKey] !== version) {
      return headerMismatch(
        id,
        `MCP-Protocol-Version ${version} doesn't match the body's _meta`
      );
    }
    const methodHeader = request.headers.get("mcp-method");
    if (methodHeader !== method) {
      return headerMismatch(
        id,
        `Mcp-Method ${methodHeader ?? "(missing)"} doesn't match ${method}`
      );
    }
    if (method !== "tools/call") {
      return undefined;
    }
    const nameHeader = request.headers.get("mcp-name");
    if (nameHeader === null || headerValue(nameHeader) !== params.name) {
      return headerMismatch(
        id,
        `Mcp-Name ${nameHeader ?? "(missing)"} doesn't match the body's name`
      );
    }
    const tool = fake.tools.find(({ name }) => name === params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    for (const { header, path } of mirroredParams(tool?.inputSchema)) {
      const value = valueAt(args, path);
      const sent = request.headers.get(`Mcp-Param-${header}`);
      const decoded = sent === null ? undefined : headerValue(sent);
      if (value !== undefined && value !== null && !mirrors(decoded, value)) {
        return headerMismatch(
          id,
          `Mcp-Param-${header} doesn't match the body's ${path.join(".")}`
        );
      }
    }
    return undefined;
  };

  const listTools = (id: string | number, params: Args): Response => {
    const { cursor } = params;
    let start: number | undefined = 0;
    if (cursor !== undefined) {
      start = typeof cursor === "string" ? toolsOffset(cursor) : undefined;
    }
    if (start === undefined || start > fake.tools.length) {
      return rpcError(id, -32_602, "Invalid cursor", 200);
    }
    const end = start + (fake.pageSize ?? fake.tools.length);
    return answer(id, {
      resultType: "complete",
      tools: fake.tools.slice(start, end),
      ...(end < fake.tools.length ? { nextCursor: toolsCursor(end) } : {}),
      ttlMs: fake.ttlMs,
      cacheScope: "private",
    });
  };

  const callTool = (
    id: string | number,
    params: Args,
    token: IssuedToken
  ): Response => {
    const { name } = params;
    const args = params.arguments ?? {};
    const tool = fake.tools.find((each) => each.name === name);
    if (typeof name !== "string" || !isRecord(args) || tool === undefined) {
      return rpcError(
        id,
        -32_602,
        `Unknown tool: ${JSON.stringify(name)}`,
        200
      );
    }
    const handler = handlers.get(name);
    if (handler?.writes === true && !token.scope.split(" ").includes("write")) {
      return new Response(null, {
        status: 403,
        headers: {
          "www-authenticate": `Bearer realm="OAuth", error="insufficient_scope", scope="write", resource_metadata="${resourceMetadataUrl}"`,
        },
      });
    }
    if (handler === undefined) {
      return answer(id, toolError(`${name} isn't available in this workspace`));
    }
    const [actor] = fake.workspace.users;
    if (actor === undefined) {
      return answer(id, toolError("No user is signed in"));
    }
    try {
      return answer(id, toolResult(handler.run(args, fake.workspace, actor)));
    } catch (error) {
      if (error instanceof ToolFailureError) {
        return answer(id, toolError(error.message));
      }
      throw error;
    }
  };

  const dispatch = (
    id: string | number,
    method: string,
    params: Args,
    token: IssuedToken
  ): Response => {
    switch (method) {
      case "server/discover": {
        return answer(id, {
          resultType: "complete",
          supportedVersions: [protocolVersion],
          capabilities: { tools: {} },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "Linear",
              version: "1.0.0",
            },
          },
          ttlMs: fake.ttlMs,
          cacheScope: "public",
        });
      }
      case "ping": {
        return answer(id, { resultType: "complete" });
      }
      case "tools/list": {
        return listTools(id, params);
      }
      case "tools/call": {
        return callTool(id, params, token);
      }
      default: {
        // `initialize` too: this server speaks only the stateless revision.
        return rpcError(id, -32_601, `Method not found: ${method}`, 404, {
          supported: [protocolVersion],
        });
      }
    }
  };

  const mcp = async (request: Request): Promise<Response> => {
    const body = await request.clone().text();
    const message = parseJson(body);
    const params =
      isRecord(message) && isRecord(message.params) ? message.params : {};
    fake.calls.push({
      httpMethod: request.method,
      method:
        isRecord(message) && typeof message.method === "string"
          ? message.method
          : undefined,
      name: typeof params.name === "string" ? params.name : undefined,
      arguments: params.arguments,
      meta: params._meta,
      authorization: request.headers.get("authorization"),
      headers: headersOf(request),
      body,
    });
    const hook = fake.next;
    fake.next = undefined;
    const hooked = await hook?.(request);
    if (hooked !== undefined) {
      return hooked;
    }
    if (fake.down) {
      // Fails with why the request was given up on, as a fetch does.
      await scheduler.wait(forever, { signal: request.signal });
      throw new Error("The server stayed down");
    }
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const token = bearer(request);
    if (token instanceof Response) {
      return token;
    }
    const refusal = malformed(request, message);
    if (
      refusal !== undefined ||
      !isRecord(message) ||
      typeof message.method !== "string"
    ) {
      return refusal ?? rpcError(null, -32_600, "Invalid Request", 400);
    }
    const { id, method } = message;
    if (id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, -32_600, "Invalid Request", 400);
    }
    return (
      headerProblem(request, id, method, params) ??
      dispatch(id, method, params, token)
    );
  };

  const oauthEndpoints = new Map([
    ["/register", register],
    ["/token", tokenEndpoint],
  ]);

  return Object.assign(fake, {
    reset: () => {
      Object.assign(fake, freshState());
      codes.clear();
      grants.clear();
      refreshTokens.clear();
    },
    consent: (
      authorizationUrl: string,
      options: { iss?: string | null } = {}
    ): Consent => {
      const asked = authorizationRequest(authorizationUrl, fake.registrations);
      const { clientId, redirectUri, state } = asked;
      if (asked.registered === undefined) {
        const known = fake.documentClients.find(
          (each) => each.clientId === clientId
        );
        if (known === undefined) {
          fake.documentClients.push({ clientId, redirectUris: [redirectUri] });
        } else if (!known.redirectUris.includes(redirectUri)) {
          known.redirectUris.push(redirectUri);
        }
      }
      const code = randomToken();
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: asked.challenge,
        resource: asked.resource,
        scope: asked.scope,
        expiresAt: Date.now() + codeLifetimeMs,
        redeemedFor: undefined,
      });
      return options.iss === null
        ? { code, state }
        : { code, state, iss: options.iss ?? linearIssuer };
    },
    handle: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.origin !== linearOrigin) {
        return notFound();
      }
      if (url.pathname.startsWith("/.well-known/")) {
        fake.metadataRequests.push({
          method: request.method,
          path: url.pathname,
          headers: headersOf(request),
        });
        const document = metadataDocuments.get(url.pathname);
        if (document === undefined) {
          return notFound();
        }
        return request.method === "GET"
          ? Response.json(document)
          : methodNotAllowed("GET");
      }
      if (url.pathname === "/mcp") {
        return await mcp(request);
      }
      const endpoint = oauthEndpoints.get(url.pathname);
      if (endpoint === undefined) {
        return notFound();
      }
      return request.method === "POST"
        ? await endpoint(request)
        : methodNotAllowed("POST");
    },
  });
};
