import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import {
  connectorProviderSchema,
  oauthProviderSchema,
  toolReachSchema,
} from "@grasp-os/shared/connect";
import { attachmentsProperty } from "@grasp-os/shared/connector-attachments";
import { permissionActionSchema } from "@grasp-os/shared/permissions";
import { syncCursorSchema, syncItemKindSchema } from "@grasp-os/shared/sync";
import { z } from "zod";

import { httpMethods, isBatchSegment, parameterSegment } from "./protocol.ts";
import { endpointHost, signInSchema } from "./sign-in.ts";

// A native connector's manifest: what connect knows of it without running
// it. Connect's build reads it from the connector's module and ships it
// next to the module's code, so connect decides by the manifest alone which
// provider's token a call gets, and where that call may go (threat model
// R9, Q11): the connector's code can't widen either.

/**
 * How a caller wants a file's content, in a tool that answers a file
 * (`answersFile`): as text, or base64 for extraction.
 */
export const readAsSchema = z.enum(["text", "base64"]);

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

/** Most resource IDs one call may report reading. */
export const maxProvenanceItems = 1000;

/** The IDs of the resources a call read, as a tool reports them. */
export const provenanceSchema = z
  .array(z.string().min(1).max(auditIdentifierMaxLength))
  .max(maxProvenanceItems);

/**
 * A provider host, as the egress handler compares it: a lowercase DNS name
 * with at least two labels and a top-level label that starts with a letter,
 * so never an IP address, a port or userinfo.
 */
const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A path segment an action names as it is, such as `v1.0` or `$value`. */
const literalSegment = /^[\w.~$:@()'-]+$/u;

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

/** A host a connector may reach (`hostPattern`). */
export const hostSchema = z.string().regex(hostPattern);

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
 * by before it reads a token: whether it is read-only, whom it reaches,
 * the input property that selects its resource, its input properties, and
 * the only requests it may send. And how a held call of it is shown
 * (`describe`), if the tool says.
 */
const actionManifestSchema = z.strictObject({
  /** What it does, as the tool says: what the chat's agent searches. */
  description: z.string(),
  routes: z.array(routeSchema).max(maxRoutes),
  readOnly: z.boolean(),
  /**
   * Whom it reaches (`toolReaches`), which with `readOnly` makes its class
   * (`toolClassOf`). Required: a tool that doesn't say has no class, and a
   * manifest holding one is refused, by the build and by connect.
   */
  reach: toolReachSchema,
  /** How a call of unknown outcome may be recovered (`recoveryModes`). */
  recovery: z.enum(recoveryModes),
  resource: z
    .string()
    .regex(/^[A-Za-z_]\w*$/u)
    .nullable(),
  input: z.array(z.string().min(1).max(128)).max(128),
  describe: actionDescribeSchema.optional(),
  /**
   * It reads a file and answers its content (`contentAs`), which a
   * workflow action may ask core to keep as a file of its run (GRA-886).
   */
  answersFile: z.literal(true).optional(),
  /**
   * It reads one item and answers its content, naming exactly that item in
   * its provenance: what core keeps as a source in the Brain (GRA-1730).
   */
  answersItem: z.literal(true).optional(),
  /**
   * It attaches files (GRA-887): its input has an `attachments` property
   * naming each by digest, and its bytes come beside the input
   * (`attachmentsMetaKey`). In its generated contract the property names
   * run files by ID instead, which a workflow's action gives and core
   * turns into the digests and bytes. Only a write takes files.
   */
  takesFiles: z.literal(true).optional(),
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

/** A connector's name: its package's, and its app's slug. */
export const connectorNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

/** A sync's name, as core asks for it: `drive`, `gmail`, `calendar`. */
export const syncNameSchema = z.string().regex(/^[a-z][a-z\d-]{0,63}$/u);

/**
 * A sync (sync.ts), as the manifest declares it: the kind of item it
 * reads, and the only requests it may send, all reads.
 */
export const syncManifestSchema = z.strictObject({
  kind: syncItemKindSchema,
  /**
   * What it reads: of a personal connection, `own`, the whole account, or
   * `listed`, places of the account the sync lists itself
   * (`syncPlacesMethod`); of a shared connection, `picked`, the places of
   * the connected account an admin picked from those it lists (shared
   * drives, document libraries). Each place is read as a source of its
   * own with its own cursor.
   */
  places: z.enum(["own", "listed", "picked"]).default("own"),
  routes: z
    .array(routeSchema)
    .min(1)
    .max(maxRoutes)
    .refine(
      (routes) => routes.every(({ method }) => method === "GET"),
      "A sync only reads: its routes are GETs"
    ),
});
export type SyncManifest = z.infer<typeof syncManifestSchema>;

/**
 * Requests a connector's isolate may send per call, every one through
 * connect's egress: the limit connect loads each isolate with
 * (connect's connector-isolate.ts).
 */
export const connectorIsolateRequests = 50;

/** What connect asks a connector for its sync's places. */
export const syncPlacesParamsSchema = z.strictObject({
  name: syncNameSchema,
  /** Where a listing too long for one read goes on; null from the start. */
  cursor: syncCursorSchema.nullable(),
});

/** What connect asks a connector's sync for. */
export const syncParamsSchema = z.strictObject({
  name: syncNameSchema,
  /** `own`, the connection's own account, or a picked place. */
  place: z.string().min(1).max(256),
  /** Null for the first listing. */
  cursor: syncCursorSchema.nullable(),
  /** A names-only listing (`SyncPageRequest.names`). */
  names: z.boolean().optional(),
  /** Those items alone, in full (`SyncPageRequest.ids`): one request each at most. */
  ids: z
    .array(z.string().min(1).max(1024))
    .min(1)
    .max(connectorIsolateRequests)
    .optional(),
});
export type SyncParams = z.infer<typeof syncParamsSchema>;

export const connectorManifestSchema = z
  .strictObject({
    name: connectorNameSchema,
    /**
     * Whose token or key a call gets: a connection with this provider's.
     * A suite (`microsoft`, `google`) or an app with its own record.
     */
    provider: connectorProviderSchema,
    /**
     * An app's provider record: how a person signs in to it (sign-in.ts).
     * Required for an app, and never for a suite, whose sign-in connect
     * handles itself.
     */
    signIn: signInSchema.optional(),
    /** The OAuth scopes its actions need, all among those connect asks for. */
    scopes: z.array(z.string().min(1).max(256)).max(64),
    /** Every host it may reach, exactly. */
    hosts: z.array(hostSchema).min(1).max(maxHosts),
    /** Each action (tool) by name, and the only requests it may send. */
    actions: z.record(permissionActionSchema, actionManifestSchema),
    /**
     * Each sync (sync.ts) by name, and the only requests it may send:
     * none for a connector that syncs nothing.
     */
    syncs: z.record(syncNameSchema, syncManifestSchema).optional(),
  })
  .refine(
    ({ provider, signIn }) =>
      oauthProviderSchema.safeParse(provider).success ===
      (signIn === undefined),
    "An app's connector carries its provider record, and a suite's none"
  )
  .refine(
    ({ signIn, scopes }) =>
      signIn === undefined ||
      (signIn.kind === "oauth2"
        ? scopes.every((scope) => signIn.scopes.includes(scope))
        : scopes.length === 0),
    "A connector's scopes are among those its record asks for; an API key has none"
  )
  .refine(
    ({ signIn, hosts }) =>
      signIn === undefined ||
      hosts.includes(endpointHost(signIn.account.url) ?? ""),
    // The lookup carries the token or key: only where the calls go.
    "The account lookup goes to one of the connector's hosts"
  )
  .refine(
    ({ hosts, actions, syncs = {} }) =>
      [...Object.values(actions), ...Object.values(syncs)].every(({ routes }) =>
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
        ({ answersFile, readOnly }) => answersFile !== true || readOnly
      ),
    "Only a read-only action answers a file"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ answersItem, readOnly }) => answersItem !== true || readOnly
      ),
    "Only a read-only action answers an item"
  )
  .refine(
    ({ actions }) =>
      Object.values(actions).every(
        ({ takesFiles, readOnly, input }) =>
          takesFiles !== true ||
          (!readOnly && input.includes(attachmentsProperty))
      ),
    "Only a write takes files, as its `attachments` input property"
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
 * `microsoft-365.mail@1`). The family is all of the name but its last
 * part, as the mirror rule names a tool (`deals.followers.list` is `list`
 * of `crm.deals.followers@1`). Connect serves contracts from this, and the
 * SDK's connector catalog is typed from it, so both name the same
 * contracts and actions.
 */
export const generatedContracts = (
  manifest: ConnectorManifest
): ReadonlyMap<string, ReadonlyMap<string, ContractAction>> => {
  const contracts = new Map<string, Map<string, ContractAction>>();
  for (const [tool, declared] of Object.entries(manifest.actions)) {
    const dot = tool.lastIndexOf(".");
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
