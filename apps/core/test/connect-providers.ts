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
import { clients } from "../../connect/test/provider-config.ts";
import { composioApiScript, composioLogoScript } from "./composio-api.ts";
import { mailServerScript } from "./mail-server.ts";

/** Grasp's Entra app for connections, as set on connect in the tests. */
export const connectClient = clients.microsoft;

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
    if (form.get("client_secret") !== ${JSON.stringify(connectClient.secret)} || digest !== challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    // An account whose sign-in name (its UPN) isn't the address it sends
    // from, as a tenant's \`onmicrosoft\` UPNs are: \`alias-\` subjects.
    const aliased = subject.startsWith("alias-");
    const claims = {
      iss: "https://login.microsoftonline.com/" + tenant + "/v2.0",
      aud: ${JSON.stringify(connectClient.id)},
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
    });
  },
};
`;
