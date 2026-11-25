import {
  connectionCallbackPath,
  connectionErrors,
  connectorClientMetadataPath,
} from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import { z } from "zod";

import { modernProtocolVersion } from "./mcp.ts";
import { readCapped } from "./oauth-client.ts";

// How connect learns to sign in to an MCP server an admin adds by its URL
// (MCP 2026-07-28, basic/authorization), and registers itself there. All
// of it is read from servers connect doesn't trust (threat model on
// GRA-1375), so each answer is capped, read field by field, and refused
// unless it is exactly what the specification says:
// - the server's protected-resource metadata (RFC 9728) sits on the
//   server's own origin and names the server's own URL as its resource;
// - the authorization server's metadata (RFC 8414, or OpenID Connect's)
//   names the issuer the resource named, exactly, offers PKCE with S256,
//   and has HTTPS endpoints;
// - no request follows a redirect, and none carries anything secret but
//   a registration's client secret, which only goes to its issuer.
// Any refusal is `connection.sign_in_unsupported`: nothing is stored.

/** How long each request of the discovery may take. */
const discoveryTimeoutMs = 10_000;

/** What connect learned of a server's sign-in, all checked. */
export interface SignIn {
  /** The server's URL, as its protected-resource metadata names it. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | undefined;
  registrationEndpoint: string | undefined;
  /** The scopes to ask for, space-separated; null where none are named. */
  scopes: string | null;
  /** Whether the issuer puts `iss` on its answers (RFC 9207). */
  issParameter: boolean;
  /** Whether the issuer takes a client metadata document as a client ID. */
  metadataDocuments: boolean;
  /** How clients may authenticate at its token endpoint. */
  authMethods: readonly string[];
}

const unsupported = (): Error =>
  connectionErrors.create("connection.sign_in_unsupported");

const httpsUrlSchema = z.url({ protocol: /^https$/u });

/** A JSON object from `response`, read up to its cap, or undefined. */
const jsonOf = async (
  response: Response
): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = JSON.parse(await readCapped(response));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** GETs a metadata document; undefined unless it answers 200 with JSON. */
const metadata = async (
  url: string
): Promise<Record<string, unknown> | undefined> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(discoveryTimeoutMs),
    });
  } catch {
    return undefined;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return undefined;
  }
  return await jsonOf(response);
};

/** RFC 9110's token, and the whitespace between a challenge's parts. */
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/u;
const spacePattern = /^[ \t]*/u;

/**
 * The parameters of the `Bearer` challenge in a WWW-Authenticate value,
 * by RFC 9110's grammar (§11.6.1): `challenge = auth-scheme [ 1*SP (
 * token68 / #auth-param ) ]`, each param `token BWS "=" BWS ( token /
 * quoted-string )`, challenges and params separated by commas. Names in
 * lower case; undefined when the value doesn't parse or has no Bearer.
 */
export const bearerChallenge = (
  header: string
): Record<string, string> | undefined => {
  let rest = header;
  const skip = (pattern: RegExp): string => {
    const found = pattern.exec(rest)?.[0] ?? "";
    rest = rest.slice(found.length);
    return found;
  };
  const challenges: { scheme: string; params: Record<string, string> }[] = [];
  while (rest.length > 0) {
    skip(/^[ \t,]*/u);
    if (rest.length === 0) {
      break;
    }
    const scheme = skip(tokenPattern);
    if (scheme === "") {
      return undefined;
    }
    const params: Record<string, string> = {};
    challenges.push({ scheme: scheme.toLowerCase(), params });
    for (;;) {
      skip(spacePattern);
      // A name followed by "=" is a param; anything else ends the challenge.
      const save = rest;
      const name = skip(tokenPattern);
      skip(spacePattern);
      if (name === "" || !rest.startsWith("=")) {
        rest = save;
        break;
      }
      rest = rest.slice(1);
      skip(spacePattern);
      let value: string;
      if (rest.startsWith('"')) {
        const quoted = /^"(?<inner>(?:[^"\\]|\\.)*)"/u.exec(rest);
        if (quoted === null) {
          return undefined;
        }
        rest = rest.slice(quoted[0].length);
        value = (quoted.groups?.inner ?? "").replaceAll(
          /\\(?<escaped>.)/gu,
          "$<escaped>"
        );
      } else {
        value = skip(tokenPattern);
      }
      params[name.toLowerCase()] = value;
      skip(spacePattern);
      if (!rest.startsWith(",")) {
        break;
      }
      rest = rest.slice(1);
    }
  }
  return challenges.find(({ scheme }) => scheme === "bearer")?.params;
};

/**
 * Asks the server for its tools without a token, as MCP's discovery
 * starts: a server that signs in answers 401 with its challenge.
 */
const challengeOf = async (
  server: URL
): Promise<Record<string, string> | undefined> => {
  let response: Response;
  try {
    response = await fetch(server, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": modernProtocolVersion,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": modernProtocolVersion,
          },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(discoveryTimeoutMs),
    });
  } catch {
    throw unsupported();
  }
  await response.body?.cancel();
  if (response.status !== 401) {
    throw unsupported();
  }
  return bearerChallenge(response.headers.get("www-authenticate") ?? "") ?? {};
};

/** Where the protected-resource metadata of `server` may be (RFC 9728 §3). */
const resourceMetadataUrls = (server: URL): string[] => {
  const path = server.pathname === "/" ? "" : server.pathname;
  return [
    ...(path === ""
      ? []
      : [`${server.origin}/.well-known/oauth-protected-resource${path}`]),
    `${server.origin}/.well-known/oauth-protected-resource`,
  ];
};

/** Where the metadata of `issuer` may be (RFC 8414 §3, OpenID Connect). */
const issuerMetadataUrls = (issuer: URL): string[] => {
  const path = issuer.pathname === "/" ? "" : issuer.pathname;
  return path === ""
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ];
};

const resourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(httpsUrlSchema).min(1),
  scopes_supported: z.array(z.string().regex(/^[\u0021-\u007E]+$/u)).optional(),
});

const issuerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: httpsUrlSchema,
  token_endpoint: httpsUrlSchema,
  revocation_endpoint: httpsUrlSchema.optional(),
  registration_endpoint: httpsUrlSchema.optional(),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
});

/** The first of `urls` that answers metadata `schema` reads. */
const firstOf = async <T>(
  urls: readonly string[],
  schema: z.ZodType<T>
): Promise<T | undefined> => {
  for (const url of urls) {
    // oxlint-disable-next-line no-await-in-loop -- in the specification's order
    const found = schema.safeParse(await metadata(url));
    if (found.success) {
      return found.data;
    }
  }
  return undefined;
};

/**
 * The protected-resource metadata of `server`: where its challenge
 * named it, which must be on the server's own origin (it is fetched with
 * nothing secret, but it decides where the person signs in), else where
 * RFC 9728 puts it. Its `resource` must be the server's URL exactly.
 */
const resourceOf = async (
  server: URL,
  named: string | undefined
): Promise<z.infer<typeof resourceMetadataSchema>> => {
  const pointed = named === undefined ? undefined : URL.parse(named);
  if (
    pointed !== undefined &&
    (pointed === null || pointed.origin !== server.origin)
  ) {
    throw unsupported();
  }
  const resource = await firstOf(
    pointed === undefined ? resourceMetadataUrls(server) : [pointed.href],
    resourceMetadataSchema
  );
  if (
    resource === undefined ||
    URL.parse(resource.resource)?.href !== server.href
  ) {
    throw unsupported();
  }
  return resource;
};

/**
 * How `server` signs in, as its metadata says, checked as above. Throws
 * `connection.sign_in_unsupported` for anything else.
 */
export const discoverSignIn = async (server: URL): Promise<SignIn> => {
  const challenge = await challengeOf(server);
  const resource = await resourceOf(server, challenge?.resource_metadata);
  const [issuer] = resource.authorization_servers;
  const issuerUrl = issuer === undefined ? null : URL.parse(issuer);
  const found =
    issuer === undefined || issuerUrl === null
      ? undefined
      : await firstOf(issuerMetadataUrls(issuerUrl), issuerMetadataSchema);
  if (
    issuer === undefined ||
    found === undefined ||
    found.issuer !== issuer ||
    !found.code_challenge_methods_supported.includes("S256")
  ) {
    throw unsupported();
  }
  const scopes =
    challenge?.scope ?? resource.scopes_supported?.join(" ") ?? null;
  return {
    resource: resource.resource,
    issuer,
    authorizationEndpoint: found.authorization_endpoint,
    tokenEndpoint: found.token_endpoint,
    revocationEndpoint: found.revocation_endpoint,
    registrationEndpoint: found.registration_endpoint,
    scopes: scopes === "" ? null : scopes,
    issParameter: found.authorization_response_iss_parameter_supported === true,
    metadataDocuments: found.client_id_metadata_document_supported === true,
    // RFC 8414's default when it says nothing.
    authMethods: found.token_endpoint_auth_methods_supported ?? [
      "client_secret_basic",
    ],
  };
};

/** How connect authenticates at a token endpoint. */
export type ClientAuthentication =
  | "none"
  | "client_secret_post"
  | "client_secret_basic";

/** The client connect signs in to a server's issuer as. */
export interface Client {
  registration: "dynamic" | "metadata_document" | "preregistered";
  id: string;
  /** Only for a confidential client; seal it before keeping it. */
  secret: string | undefined;
  authentication: ClientAuthentication;
}

const registrationAnswerSchema = z.object({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(4096).optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .optional(),
});

/**
 * How a client with a secret authenticates at `signIn`'s issuer: HTTP
 * Basic where it takes it, else in the form; undefined if neither.
 */
const secretAuthentication = (
  signIn: Pick<SignIn, "authMethods">
): ClientAuthentication | undefined => {
  if (signIn.authMethods.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  return signIn.authMethods.includes("client_secret_post")
    ? "client_secret_post"
    : undefined;
};

/**
 * Registers connect at `signIn`'s issuer (RFC 7591), as a public client
 * where it takes one, for the deployment at `origin`.
 */
const registerDynamically = async (
  signIn: SignIn & { registrationEndpoint: string },
  origin: string
): Promise<Client> => {
  const asked: ClientAuthentication | undefined = signIn.authMethods.includes(
    "none"
  )
    ? "none"
    : secretAuthentication(signIn);
  if (asked === undefined) {
    throw unsupported();
  }
  let response: Response;
  try {
    response = await fetch(signIn.registrationEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_name: "Grasp",
        redirect_uris: [new URL(connectionCallbackPath, origin).href],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: asked,
        application_type: "web",
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(discoveryTimeoutMs),
    });
  } catch {
    throw unsupported();
  }
  const answer = registrationAnswerSchema.safeParse(
    response.status === 200 || response.status === 201
      ? await jsonOf(response)
      : await response.body?.cancel()
  );
  if (!answer.success) {
    throw unsupported();
  }
  const authentication = answer.data.token_endpoint_auth_method ?? asked;
  const secret = answer.data.client_secret;
  if (authentication !== "none" && secret === undefined) {
    throw unsupported();
  }
  return {
    registration: "dynamic",
    id: answer.data.client_id,
    secret: authentication === "none" ? undefined : secret,
    authentication,
  };
};

/**
 * The client connect signs in to `signIn`'s issuer as: the one the admin
 * entered; else one it registers there, where the issuer takes that;
 * else the deployment's client metadata document, where it takes those.
 * Registering comes before a document, though 2026-07-28 prefers
 * documents: an issuer must fetch a document from the deployment, which
 * on-prem can't promise. Throws `connection.client_required` when the
 * issuer takes neither and the admin entered none.
 */
export const clientFor = async (
  signIn: SignIn,
  origin: string,
  entered: { id: string; secret?: string | undefined } | undefined
): Promise<Client> => {
  if (entered !== undefined) {
    const authentication =
      entered.secret === undefined ? "none" : secretAuthentication(signIn);
    if (authentication === undefined) {
      throw unsupported();
    }
    return {
      registration: "preregistered",
      id: entered.id,
      secret: entered.secret,
      authentication,
    };
  }
  const { registrationEndpoint } = signIn;
  if (registrationEndpoint !== undefined) {
    return await registerDynamically(
      { ...signIn, registrationEndpoint },
      origin
    );
  }
  if (signIn.metadataDocuments && signIn.authMethods.includes("none")) {
    return {
      registration: "metadata_document",
      id: new URL(connectorClientMetadataPath, origin).href,
      secret: undefined,
      authentication: "none",
    };
  }
  throw connectionErrors.create("connection.client_required");
};
