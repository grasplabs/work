/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, eslint/complexity, eslint/prefer-named-capture-group -- a hand-run qualification harness (GRA-430), never in CI or production: kept as it ran, for the record. */
/**
 * The qualification harness's only way out of workerd (miniflare's
 * `outboundService`, run in Node): the Cloudflare API and the test clients'
 * workers.dev addresses, through the agent proxy that signs the API calls.
 * The account it reaches runs Grasp's live platform, so every write must
 * name something this run created, by its prefix or an id a create of
 * ours returned; anything else is refused before it leaves, and every
 * call is logged for the record.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const apiHost = "api.cloudflare.com";
const releaseHost = "qual-release.invalid";
const collections = /\/(?:d1\/database|r2\/buckets|storage\/kv\/namespaces)$/u;

export interface RelayOptions {
  /** Every name this run creates contains it (`qual-20261023`). */
  prefix: string;
  accountId: string;
  /** The built release's directory, served at https://qual-release.invalid/. */
  releaseDir: string;
  /** One JSON line per call. */
  logFile: string;
}

/** Whether `text` is an API envelope that says it failed, as a 200 can. */
const failedEnvelope = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "success") === false
    );
  } catch {
    return false;
  }
};

const refuse = (reason: string): Response =>
  Response.json(
    {
      success: false,
      errors: [{ code: 403, message: `qualification relay: ${reason}` }],
    },
    { status: 403 }
  );

export const relay = (options: RelayOptions) => {
  const ours = new Set<string>();
  const sessionTokens = new Set<string>();
  const accountPath = `/client/v4/accounts/${options.accountId}/`;
  const log = (entry: Record<string, unknown>): void => {
    appendFileSync(
      options.logFile,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    );
  };
  const namesOurs = (text: string): boolean =>
    text.includes(options.prefix) || [...ours].some((id) => text.includes(id));
  const remember = (text: string): void => {
    // Ids the API hands back for something we created (a D1 uuid).
    for (const match of text.matchAll(/"(?:uuid|id)":"([0-9a-f-]{32,36})"/gu)) {
      if (match[1] !== undefined) {
        ours.add(match[1]);
      }
    }
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { method } = request;
    if (url.hostname === releaseHost) {
      if (url.pathname === "/__report" && method === "POST") {
        log({ report: JSON.parse(await request.text()) as unknown });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__list") {
        const files = readdirSync(path.join(options.releaseDir, "blobs"), {
          recursive: true,
          withFileTypes: true,
        })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            path.relative(
              options.releaseDir,
              path.join(entry.parentPath, entry.name)
            )
          );
        return Response.json(files);
      }
      const file = path.join(options.releaseDir, path.normalize(url.pathname));
      if (!file.startsWith(options.releaseDir)) {
        return refuse("outside the release");
      }
      try {
        return new Response(readFileSync(file));
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    if (url.hostname.endsWith(".workers.dev")) {
      if (!url.hostname.includes(options.prefix)) {
        log({
          method,
          host: url.hostname,
          refused: "workers.dev host not ours",
        });
        return refuse("workers.dev host not ours");
      }
      const sent =
        method === "GET" || method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const response = await fetch(url, {
        method,
        headers: request.headers,
        body: sent,
        redirect: "manual",
      });
      log({
        method,
        host: url.hostname,
        path: url.pathname,
        status: response.status,
      });
      return response;
    }
    if (url.hostname !== apiHost) {
      log({ method, host: url.hostname, refused: "host" });
      return refuse(`host ${url.hostname}`);
    }
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    const bodyText =
      body === undefined
        ? ""
        : new TextDecoder().decode(body.slice(0, 1_000_000));
    const where = `${url.pathname}${url.search}`;
    const inAccount = url.pathname.startsWith(accountPath);
    if (method !== "GET" && method !== "HEAD") {
      // Writes: only in this account, only to what this run named or made.
      // Zones (the mail step's sending domain) are never created here.
      // A create names its resource in the body, at a collection's path.
      // An assets upload names no script: the session JWT one of ours was
      // handed authorises it.
      const uploads =
        method === "POST" &&
        url.pathname === `${accountPath}workers/assets/upload` &&
        sessionTokens.has(
          (request.headers.get("authorization") ?? "").replace(/^Bearer /u, "")
        );
      const creates =
        method === "POST" &&
        collections.test(url.pathname) &&
        namesOurs(bodyText);
      if (!inAccount || !(namesOurs(url.pathname) || creates || uploads)) {
        log({ method, path: where, refused: "write not ours" });
        return refuse(
          `${method} ${url.pathname} names nothing this run created`
        );
      }
    }
    // As the console sent it: the deployer token it holds is a placeholder
    // the proxy replaces; an asset upload's JWT is its own.
    const headers = new Headers(request.headers);
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { method, headers, body });
      text = await response.text();
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      log({ method, path: where, error: String(error), cause: String(cause) });
      throw error;
    }
    if (
      method === "POST" &&
      response.ok &&
      url.pathname.endsWith("/assets-upload-session") &&
      namesOurs(url.pathname)
    ) {
      const parsed: unknown = JSON.parse(text);
      const result: unknown =
        typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "result")
          : undefined;
      const jwt: unknown =
        typeof result === "object" && result !== null
          ? Reflect.get(result, "jwt")
          : undefined;
      if (typeof jwt === "string") {
        sessionTokens.add(jwt);
      }
    }
    if (
      method === "POST" &&
      response.ok &&
      collections.test(url.pathname) &&
      namesOurs(bodyText)
    ) {
      remember(text);
    }
    log({
      method,
      path: where,
      status: response.status,
      ...(response.ok && !failedEnvelope(text)
        ? {}
        : { response: text.slice(0, 2000) }),
    });
    // Fetch decoded the body: its upstream length and encoding no longer hold.
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  };
};
