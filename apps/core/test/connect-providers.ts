/**
 * The outside systems the connect Worker reaches in core's tests: a Worker
 * of its own, set as connect's outbound service in vite.config.ts, so the
 * real connect runs unchanged behind core. Entra ID's token endpoint checks
 * PKCE and Grasp's client secret as Entra does, and issues tokens for the
 * account the code names; Composio's API answers as test/composio-api.ts
 * says; a mail provider's MCP server answers as
 * test/mail-server.ts says; Microsoft Graph's delta queries answer as
 * connect's test/graph-events-fake.ts says, with mail tests post to
 * `graphControlUrl`. Imported by vite.config.ts (Node) and the tests
 * (workerd), so it only holds data.
 */
import { graphEventsFake } from "../../connect/test/graph-events-fake.ts";
import { npmRegistryFake } from "../../connect/test/npm-registry-fake.ts";
import { osvFake } from "../../connect/test/osv-fake.ts";
import { clients } from "../../connect/test/provider-config.ts";
import { composioApiScript, composioLogoScript } from "./composio-api.ts";
import { mailServerScript } from "./mail-server.ts";

/** Grasp's Entra app for connections, as set on connect in the tests. */
export const connectClient = clients.microsoft;

/** Grasp's Entra app for the application landscape, as set on connect. */
export const landscapeClient = clients.microsoftLandscape;

/**
 * Where tests set what Graph holds of the tenant's grants, for the
 * landscape's reads: POST `{ grants, apps, people }` as Graph has them
 * (`oauth2PermissionGrants`, `servicePrincipals`, `users`), or
 * `{ throttle: seconds }` to have every grants read throttled until
 * `{ throttle: null }`, or
 * `{ failing: "all" }` to have every grants read fail, or `"later"` every
 * page but the first, until `false`.
 */
export const landscapeControlUrl = "https://graph-control.test/landscape";

/** What the landscape's Entra app is granted, as Entra's token answer says. */
export const landscapeGranted =
  "openid profile email Application.Read.All DelegatedPermissionGrant.Read.All User.Read User.ReadBasic.All";

/**
 * The code Entra sends back once `subject` in `tenant` consents at `url`:
 * it carries the authorization's PKCE challenge, so only the flow's own
 * verifier redeems it.
 */
export const consentCode = (url: URL, tenant: string, subject: string) =>
  [url.searchParams.get("code_challenge"), tenant, subject].join(".");

/**
 * Where tests post a message arriving in a mailbox's inbox:
 * `{ mailbox, message }`, as Graph's delta queries then show it.
 */
export const graphControlUrl = "https://graph-control.test/receive";

/**
 * Where tests read the mail Microsoft Graph sent for them (`sendMail`), in
 * order: `{ mailbox, subject, to, replyTo, headers, attachments }` each
 * (`headers` its `internetMessageHeaders`, `attachments` the file
 * attachments it was given), and the drafts it made (`draft: true`).
 */
export const graphSentUrl = "https://graph-control.test/sent";

/**
 * Where tests have Graph lose the answers of a mailbox's next writes (a
 * mail sent, a draft made): POST `{ mailbox, writes }`, how many. Each such write is
 * carried out, then answered with a 502, as a gateway that lost it would.
 */
export const graphLoseUrl = "https://graph-control.test/lose";

/** Where tests read how many drafts Graph made for `?mailbox=`: `{ drafts }`. */
export const graphDraftsUrl = "https://graph-control.test/drafts";

/**
 * Where tests put a file attachment on a message of a mailbox, as Graph
 * then answers it (`/users/{mailbox}/messages/{message}/attachments/{id}`):
 * POST `{ mailbox, message, id, name, contentType, contentBytes }`, its
 * bytes as base64.
 */
export const graphAttachmentUrl = "https://graph-control.test/attachment";

/**
 * Where tests publish a package on the fake npm registry: POST one
 * version as connect's test/npm-registry-fake.ts takes it, as JSON.
 */
export const npmPublishUrl = "https://npm-control.test/publish";
/** POST `{ name, advisory }`: the registry knows `advisory` for `name`. */
export const npmAdviseUrl = "https://npm-control.test/advise";

/** POST `{ name, version, id }`: OSV.dev knows entry `id` for that version. */
export const osvReportUrl = "https://osv-control.test/report";

/**
 * POST `{ name, status }`: OSV.dev answers a batch naming the package with
 * that status and no results; `{ name, status: null }` restores its own.
 */
export const osvAnswerUrl = "https://osv-control.test/answer";

/** Where tests read the paths the fake npm registry was asked for, in order. */
export const npmAskedUrl = "https://npm-control.test/asked";

/** The tokens the fake issues for `subject`, to look for where they mustn't be. */
export const tokensFor = (subject: string): string[] => [
  `access.${subject}`,
  `refresh.${subject}`,
];

export const connectProvidersScript = `
${mailServerScript}
${composioApiScript}
${composioLogoScript}
const base64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const encoded = (value) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));
const graphEvents = (${graphEventsFake.toString()})();
const graphSent = [];
const graphLosing = new Map();
const graphDrafts = new Map();
const graphAttachments = new Map();
/** Whether Graph loses this write's answer (\`graphLoseUrl\`). */
const losesAnswer = (mailbox) => {
  const losing = graphLosing.get(mailbox) ?? 0;
  if (losing === 0) {
    return false;
  }
  graphLosing.set(mailbox, losing - 1);
  return true;
};
const npm = (${npmRegistryFake.toString()})();
const landscape = { grants: [], apps: [], people: [], throttle: null, failing: false };
const landscapeIds = (url) =>
  [...(url.searchParams.get("$filter") ?? "").matchAll(/'([^']*)'/gu)].map((match) => match[1]);
/** Graph's grants of the tenant, a page at a time, with their apps and people. */
const landscapeGraph = (url) => {
  if (url.pathname === "/v1.0/oauth2PermissionGrants") {
    if (landscape.failing === "all" || (landscape.failing === "later" && url.searchParams.has("$skiptoken"))) {
      return new Response("Unavailable", { status: 500 });
    }
    if (landscape.throttle !== null) {
      const seconds = landscape.throttle;
      return new Response("Slow down", { status: 429, headers: { "retry-after": String(seconds) } });
    }
    const top = Number(url.searchParams.get("$top") ?? "100");
    const from = Number(url.searchParams.get("$skiptoken") ?? "0");
    const next = from + top;
    return Response.json({
      value: landscape.grants.slice(from, next),
      ...(next < landscape.grants.length
        ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$top=" + top + "&$skiptoken=" + next }
        : {}),
    });
  }
  if (url.pathname === "/v1.0/servicePrincipals") {
    const ids = landscapeIds(url);
    return Response.json({ value: landscape.apps.filter(({ id }) => ids.includes(id)) });
  }
  if (url.pathname === "/v1.0/users") {
    const ids = landscapeIds(url);
    return Response.json({ value: landscape.people.filter(({ id }) => ids.includes(id)) });
  }
  return undefined;
};
const osv = (${osvFake.toString()})();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "backend.composio.dev" && url.pathname.startsWith("/api/v3.1/")) {
      return await composioApi(request, url);
    }
    if (url.hostname === "logos.composio.dev") {
      return composioLogo(url);
    }
    if (url.hostname === "backend.composio.dev" || url.hostname === "mail-control.test") {
      return await mailServer(request, url);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(landscapeControlUrl)}) {
      Object.assign(landscape, await request.json());
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "graph.microsoft.com" && request.method === "GET") {
      const answered = landscapeGraph(url);
      if (answered !== undefined) {
        return answered;
      }
    }
    if (url.hostname === "graph.microsoft.com") {
      // Graph's mail, as Microsoft 365's native actions use it: sending
      // records the message; a mailbox's messages are none.
      // The account's own profile, as connect reads its addresses: its
      // primary address and an SMTP alias, \`also-<subject>@acme.test\`.
      if (request.method === "GET" && url.pathname === "/v1.0/me") {
        const subject = (request.headers.get("authorization") ?? "").replace("Bearer access.", "");
        return Response.json({
          mail: subject + "@acme.test",
          proxyAddresses: ["SMTP:" + subject + "@acme.test", "smtp:also-" + subject + "@acme.test"],
        });
      }
      const [, version, users, mailbox, ...rest] = decodeURIComponent(url.pathname).split("/");
      const mailPath = version === "v1.0" && users === "users" && mailbox && rest.length === 1;
      if (request.method === "POST" && mailPath && rest[0] === "sendMail") {
        const { message } = await request.json();
        graphSent.push({
          mailbox,
          subject: message.subject,
          to: message.toRecipients.map((recipient) => recipient.emailAddress.address),
          replyTo: (message.replyTo ?? []).map((recipient) => recipient.emailAddress.address),
          headers: message.internetMessageHeaders ?? [],
          // The files attached (\`attachments\`), as Graph was given them.
          attachments: message.attachments ?? [],
          // The tag a native connector puts on what it sends: its effect key.
          effectKey: (message.singleValueExtendedProperties ?? [])[0]?.value ?? null,
        });
        return losesAnswer(mailbox)
          ? new Response("Bad Gateway", { status: 502 })
          : new Response(null, { status: 202 });
      }
      if (request.method === "POST" && mailPath && rest[0] === "messages") {
        graphDrafts.set(mailbox, (graphDrafts.get(mailbox) ?? 0) + 1);
        if (losesAnswer(mailbox)) {
          return new Response("Bad Gateway", { status: 502 });
        }
      }
      if (request.method === "POST" && mailPath && rest[0] === "messages") {
        // A draft, recorded as a message sent is, marked a draft.
        const message = await request.json();
        graphSent.push({
          mailbox,
          subject: message.subject,
          to: message.toRecipients.map((recipient) => recipient.emailAddress.address),
          replyTo: (message.replyTo ?? []).map((recipient) => recipient.emailAddress.address),
          headers: message.internetMessageHeaders ?? [],
          attachments: message.attachments ?? [],
          draft: true,
        });
        return Response.json({ id: "draft-" + graphSent.length, conversationId: null, webLink: null });
      }
      if (request.method === "GET" && mailPath && rest[0] === "messages") {
        return Response.json({ value: [] });
      }
      // A message's file attachment, as a test put it (\`graphAttachmentUrl\`):
      // its fields alone when selected, its content too otherwise.
      if (request.method === "GET" && version === "v1.0" && users === "users" && rest.length === 4 && rest[0] === "messages" && rest[2] === "attachments") {
        const found = graphAttachments.get([mailbox, rest[1], rest[3]].join("/"));
        if (!found) {
          return Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
        }
        const size = atob(found.contentBytes).length;
        const fields = { "@odata.type": "#microsoft.graph.fileAttachment", id: found.id, name: found.name, contentType: found.contentType, size, isInline: false };
        return Response.json(url.searchParams.has("$select") ? fields : { ...fields, contentBytes: found.contentBytes });
      }
      return graphEvents.answer(request, url);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(graphAttachmentUrl)}) {
      const attachment = await request.json();
      graphAttachments.set([attachment.mailbox, attachment.message, attachment.id].join("/"), attachment);
      return new Response(null, { status: 204 });
    }
    if (url.href === ${JSON.stringify(graphSentUrl)}) {
      return Response.json(graphSent);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(graphLoseUrl)}) {
      const { mailbox, writes } = await request.json();
      graphLosing.set(mailbox, (graphLosing.get(mailbox) ?? 0) + writes);
      return new Response(null, { status: 204 });
    }
    if (url.origin + url.pathname === ${JSON.stringify(graphDraftsUrl)}) {
      return Response.json({ drafts: graphDrafts.get(url.searchParams.get("mailbox")) ?? 0 });
    }
    if (url.hostname === "api.osv.dev") {
      return await osv.answer(request);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(osvReportUrl)}) {
      const { name, version, id } = await request.json();
      osv.report(name, version, id);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(osvAnswerUrl)}) {
      const { name, status } = await request.json();
      osv.failFor(name, status === null ? undefined : () => new Response("Unavailable", { status }));
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "registry.npmjs.org") {
      return await npm.answer(request);
    }
    if (url.href === ${JSON.stringify(npmAskedUrl)}) {
      return Response.json(npm.asked.map(({ path }) => path));
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(npmAdviseUrl)}) {
      const { name, advisory } = await request.json();
      npm.advise(name, advisory);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(npmPublishUrl)}) {
      const published = await request.json();
      await npm.publish(published);
      return Response.json({
        integrity: npm.integrityOf(published.name, published.version),
      });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(graphControlUrl)}) {
      const { mailbox, message } = await request.json();
      graphEvents.receive(mailbox, message);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST" || url.hostname !== "login.microsoftonline.com") {
      return new Response("Not found", { status: 404 });
    }
    const form = new URLSearchParams(await request.text());
    const [challenge, tenant, subject] = (form.get("code") ?? "").split(".");
    const verifier = new TextEncoder().encode(form.get("code_verifier") ?? "");
    const digest = base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", verifier))
    );
    // The landscape's own app, or the one for every other connection.
    const forLandscape = form.get("client_id") === ${JSON.stringify(landscapeClient.id)};
    const client = forLandscape ? ${JSON.stringify(landscapeClient)} : ${JSON.stringify(connectClient)};
    if (form.get("client_secret") !== client.secret || digest !== challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    // An account whose sign-in name (its UPN) isn't the address it sends
    // from, as a tenant's \`onmicrosoft\` UPNs are: \`alias-\` subjects.
    const aliased = subject.startsWith("alias-");
    const claims = {
      iss: "https://login.microsoftonline.com/" + tenant + "/v2.0",
      aud: client.id,
      tid: tenant,
      oid: subject,
      preferred_username: subject + (aliased ? "@acme.onmicrosoft.test" : "@acme.test"),
      ...(aliased ? { email: subject + "@acme.test" } : {}),
    };
    return Response.json({
      token_type: "Bearer",
      access_token: "access." + subject,
      refresh_token: "refresh." + subject,
      expires_in: 3600,
      id_token: [encoded({ alg: "RS256" }), encoded(claims), "signature"].join("."),
      ...(forLandscape ? { scope: ${JSON.stringify(landscapeGranted)} } : {}),
    });
  },
};
`;
