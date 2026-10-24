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
import { botFrameworkKeysFake } from "../../connect/test/bot-framework-keys-fake.ts";
import { graphEventsFake } from "../../connect/test/graph-events-fake.ts";
import { npmRegistryFake } from "../../connect/test/npm-registry-fake.ts";
import { osvFake } from "../../connect/test/osv-fake.ts";
import { acmeTenant, clients } from "../../connect/test/provider-config.ts";
import { botConnectorFake } from "./bot-connector-fake.ts";
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

/** Grasp's Entra app for the directory's connection, as set on connect. */
export const directoryClient = clients.microsoftDirectory;

/**
 * Where tests set who is in the tenant's directory, for the directory's
 * reads: POST `{ users }` as Graph has them (`/users` with `$select` and
 * `$expand=manager`), a hundred to a page.
 */
export const directoryControlUrl = "https://graph-control.test/directory";

/**
 * Where tests set what HiBob holds, for the HR platform's reads: POST
 * `{ employees }` as its people search answers them, and `{ key }`, the
 * one service user it takes, as `<id>:<token>`.
 */
export const hibobControlUrl = "https://hibob-control.test/people";

/** What the directory's Entra app is granted, as Entra's token answer says. */
export const directoryGranted = "openid profile email User.Read User.Read.All";

/** Grasp's Entra app for the documents' connection, as set on connect. */
export const documentsClient = clients.microsoftDocuments;

/**
 * Where tests set what the admin's OneDrive holds, for the documents'
 * reads: POST `{ files }`, each `{ id, name, base64 }`, at its top. Graph
 * answers them as `/me/drive/root/children` and `/me/drive/items/{id}`,
 * and SharePoint serves each one's bytes from its download link.
 */
export const documentsControlUrl = "https://graph-control.test/documents";

/** What the documents' Entra app is granted, as Entra's token answer says. */
export const documentsGranted =
  "openid profile email User.Read Files.Read.All Sites.Read.All";

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
 * order: `{ mailbox, subject, to, replyTo, headers }` each (`headers` its
 * `internetMessageHeaders`), and the drafts it made (`draft: true`).
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

/**
 * Where tests publish Microsoft's Bot Framework signing keys, as
 * login.botframework.com serves them to connect: POST `{ keys }`, public
 * JWKs each with its `endorsements`, added to those published before (a
 * key with the same `kid` replaced).
 */
export const botFrameworkKeysUrl = "https://botframework-control.test/keys";

/**
 * Where tests have login.botframework.com fail its key set: POST
 * `{ status }` to have it answer with that status, `{ status: null }` to
 * have it answer as before.
 */
export const botFrameworkFailUrl = "https://botframework-control.test/fail";

/**
 * Where tests that post through core's own route, and so are checked
 * against the isolate's keys, take the one signing key they share: POST
 * `{ key }`, a private JWK with its `kid`, to have it published, and get
 * back the key the first test file published, this one or an earlier
 * one. Test files may share an isolate, which fetches the keys at most
 * once a minute: one key, published before any of them posts, is always
 * among them.
 */
export const botFrameworkSharedKeyUrl =
  "https://botframework-control.test/shared-key";

/** Where tests read the paths login.botframework.com was asked for, in order. */
export const botFrameworkAskedUrl = "https://botframework-control.test/asked";

/**
 * The client's Teams bot, as core (`TEAMS_BOT_ID`) and connect
 * (`TEAMS_BOT_*`) are set up with it in the tests, and Entra knows it.
 */
export const teamsBot = {
  id: "5b1e7c2a-3f4d-4e6b-9a8c-1d2e3f4a5b6c",
  tenant: acmeTenant,
  secret: "acme-teams-bot-secret",
} as const;

/**
 * Where tests set the Bot Connector's rosters: POST `{ members }`, each
 * `<conversation id> <user id>` to the member Teams answers with.
 */
export const botConnectorMembersUrl =
  "https://bot-connector-control.test/members";

/**
 * Where tests read what reached the Bot Connector, in order: `{ posted,
 * asked }`, the activities it took (`{ conversation, activity }` each) and
 * the roster reads (`<conversation id> <user id>` each).
 */
export const botConnectorPostedUrl =
  "https://bot-connector-control.test/posted";

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
const botFramework = (${botFrameworkKeysFake.toString()})();
let botFrameworkKeys = [];
let botFrameworkSharedKey = null;
const botConnector = (${botConnectorFake.toString()})(${JSON.stringify(teamsBot)});
const landscape = { grants: [], apps: [], people: [], throttle: null, failing: false };
const directory = { users: [] };
const hibob = { key: null, employees: [] };
/** Graph's users, as the directory's reads ask for them, a page at a time. */
const directoryGraph = (url) => {
  const top = Number(url.searchParams.get("$top") ?? "100");
  const from = Number(url.searchParams.get("$skiptoken") ?? "0");
  const next = from + top;
  return Response.json({
    value: directory.users.slice(from, next),
    ...(next < directory.users.length
      ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$top=" + top + "&$skiptoken=" + next }
      : {}),
  });
};
const documents = { files: [] };
/** The admin's OneDrive, as the documents' reads ask Graph for it, and SharePoint serves its files. */
const documentsGraph = (url) => {
  const item = (file) => ({
    id: file.id,
    name: file.name,
    size: atob(file.base64).length,
    lastModifiedDateTime: "2026-10-01T09:00:00Z",
    file: { mimeType: "application/octet-stream" },
  });
  if (url.hostname === "acme-my.sharepoint.com" && url.pathname.startsWith("/download/")) {
    const file = documents.files.find(({ id }) => "/download/" + id === url.pathname);
    return file === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)));
  }
  if (url.pathname === "/v1.0/sites" && url.searchParams.get("search") === "*") {
    return Response.json({ value: [] });
  }
  if (url.pathname === "/v1.0/me/drive/root/children") {
    return Response.json({ value: documents.files.map(item) });
  }
  const file = documents.files.find(({ id }) => url.pathname === "/v1.0/me/drive/items/" + id);
  if (file !== undefined) {
    return Response.json({
      ...item(file),
      "@microsoft.graph.downloadUrl": "https://acme-my.sharepoint.com/download/" + file.id + "?tempauth=signed",
    });
  }
  return undefined;
};
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
    if (request.method === "POST" && url.href === ${JSON.stringify(directoryControlUrl)}) {
      Object.assign(directory, await request.json());
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(hibobControlUrl)}) {
      Object.assign(hibob, await request.json());
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "api.hibob.com" && request.method === "POST" && url.pathname === "/v1/people/search") {
      const authorization = request.headers.get("authorization") ?? "";
      if (hibob.key === null || authorization !== "Basic " + btoa(hibob.key)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json({ employees: hibob.employees });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(documentsControlUrl)}) {
      Object.assign(documents, await request.json());
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "graph.microsoft.com" && request.method === "GET" && url.pathname.startsWith("/v1.0/users/") && url.pathname.split("/").length === 4 && url.searchParams.has("$expand")) {
      const id = url.pathname.split("/").pop().toLowerCase();
      const found = directory.users.find((user) => user.id.toLowerCase() === id);
      return found === undefined
        ? Response.json({ error: { code: "Request_ResourceNotFound" } }, { status: 404 })
        : Response.json(found);
    }
    if ((url.hostname === "graph.microsoft.com" || url.hostname === "acme-my.sharepoint.com") && request.method === "GET") {
      const answered = documentsGraph(url);
      if (answered !== undefined) {
        return answered;
      }
    }
    if (url.hostname === "graph.microsoft.com" && request.method === "GET" && url.pathname === "/v1.0/users" && url.searchParams.has("$expand")) {
      return directoryGraph(url);
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
          draft: true,
        });
        return Response.json({ id: "draft-" + graphSent.length, conversationId: null, webLink: null });
      }
      if (request.method === "GET" && mailPath && rest[0] === "messages") {
        return Response.json({ value: [] });
      }
      return graphEvents.answer(request, url);
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
    const fromMicrosoft = await botConnector.answer(request);
    if (fromMicrosoft !== undefined) {
      return fromMicrosoft;
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(botConnectorMembersUrl)}) {
      const { members } = await request.json();
      botConnector.setMembers(members);
      return new Response(null, { status: 204 });
    }
    if (url.href === ${JSON.stringify(botConnectorPostedUrl)}) {
      return Response.json({ posted: botConnector.posted, asked: botConnector.asked });
    }
    if (url.hostname === "login.botframework.com") {
      return botFramework.answer(request);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(botFrameworkKeysUrl)}) {
      // Added to the keys other test files published: files run at once,
      // and each signs with keys of its own.
      const { keys } = await request.json();
      const kids = new Set(keys.map(({ kid }) => kid));
      botFrameworkKeys = [...botFrameworkKeys.filter(({ kid }) => !kids.has(kid)), ...keys];
      botFramework.setKeys(botFrameworkKeys);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(botFrameworkSharedKeyUrl)}) {
      if (botFrameworkSharedKey === null) {
        const { key } = await request.json();
        botFrameworkSharedKey = key;
        const { kid, kty, n, e } = key;
        botFrameworkKeys = [...botFrameworkKeys, { kid, kty, n, e, use: "sig", endorsements: ["msteams"] }];
        botFramework.setKeys(botFrameworkKeys);
      }
      return Response.json({ key: botFrameworkSharedKey });
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(botFrameworkFailUrl)}) {
      const { status } = await request.json();
      botFramework.override(
        botFramework.keysPath,
        status === null ? undefined : () => new Response("Unavailable", { status })
      );
      return new Response(null, { status: 204 });
    }
    if (url.href === ${JSON.stringify(botFrameworkAskedUrl)}) {
      return Response.json(botFramework.asked.map(({ path }) => path));
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
    // The landscape's, the directory's or the documents' own app, or the one for every other connection.
    const forLandscape = form.get("client_id") === ${JSON.stringify(landscapeClient.id)};
    const forDirectory = form.get("client_id") === ${JSON.stringify(directoryClient.id)};
    const forDocuments = form.get("client_id") === ${JSON.stringify(documentsClient.id)};
    const client = forLandscape
      ? ${JSON.stringify(landscapeClient)}
      : forDirectory
        ? ${JSON.stringify(directoryClient)}
        : forDocuments
          ? ${JSON.stringify(documentsClient)}
          : ${JSON.stringify(connectClient)};
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
      ...(forDirectory ? { scope: ${JSON.stringify(directoryGranted)} } : {}),
      ...(forDocuments ? { scope: ${JSON.stringify(documentsGranted)} } : {}),
    });
  },
};
`;
