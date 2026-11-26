---
title: Connectors
description: One vendor's API as tools that Apps, workflows and agents call through a connection.
sidebar:
  order: 7
---

A connector is how Grasp reaches one vendor's API, such as a CRM or a project tracker. It declares the vendor's hosts, how a person signs in there, and its tools: each one a few routes of the API, with what it takes and what it answers. Apps, workflows and the chat's agent call its tools through a connection someone made, and connect checks every call against the connector's declaration and the caller's permission.

A connector is written on `@grasp-os/sdk/connector`. This guide shows how.

## What a connector may do

A connector runs in connect, each call of a tool in an isolate of its own, and holds nothing from one call to the next. Three rules hold for all its code:

- It imports only `@grasp-os/sdk/connector` and its own files.
- It never sees a token or a key. Connect adds the connection's credential to each request on its way out, after the connector's code is done with it, and only for the hosts the sign-in names. The answers it reads carry no cookies, and no exact copy of the credential in their headers.
- Every request goes through connect's egress, and only to a route the called tool declares, on one of the connector's hosts. Anything else is refused before it leaves.

## A connector

`defineConnector` takes the connector's `name` (lowercase), its vendor's `title` as people read it, every host it may reach (`hosts`, exactly), how a person signs in (`auth`) and its `tools`, by name. Its connections are its `provider`'s: its `name`, unless it names another, such as a connector `microsoft-365` whose provider is `microsoft`:

```ts connector.ts
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

const host = "api.boards.example";

const Item = v.object({ id: v.string(), title: v.string(), done: v.boolean() });

export default defineConnector({
  name: "boards",
  title: "Boards",
  hosts: [host],
  auth: auth.apiKey({
    header: "x-api-key",
    account: {
      url: `https://${host}/v1/me`,
      id: "/account/id",
      name: "/account/name",
      email: "/account/email",
    },
  }),
  tools: {
    "items.list": tool({
      description: "Lists the items on a board, a page at a time",
      readOnly: true,
      reach: "company",
      resource: "board",
      routes: ["GET /v1/boards/{board}/items"],
      args: { board: v.string().min(1), cursor: v.string().optional() },
      returns: page(Item),
      handler: async ({ board, cursor }, api) => {
        const answer = await api.get("/v1/boards/{board}/items", {
          path: { board },
          query: { cursor },
          returns: v.object({
            data: v.array(Item),
            next_cursor: v.string().nullable(),
          }),
        });
        return { items: answer.data, next: answer.next_cursor };
      },
    }),
  },
});
```

A tool's name is its family and its action: `items.list`. The tools of one family make one contract, named after the connector and the family: `boards.items@1`, with the action `list`. That contract is what an App's connection permission names, with the actions it uses (see [Server functions](/guides/server-functions)).

## Tools

`tool` declares one tool:

- `description`: what it does, for whoever picks a tool.
- `args`: its arguments, in `v`'s words, as a strict object: a call with any other argument is refused.
- `returns`: what it answers, an object. The answer is checked against it before anyone sees it: one that doesn't fit fails the call, and its caller gets the failure, never the answer.
- `readOnly`: `true` for a tool that only reads, `false` for one that changes something at the vendor.
- `reach`: whom it reaches, as far as any call of it can: `own` (only the person it acts for), `company` (what the company keeps together), `others` (anything that reaches other people, such as sending them something) or `conversations` (what other people said where the person was, such as a chat or a meeting's transcript). With `readOnly`, it decides the tool's class, which an admin allows or not.
- `routes`: the only requests it may send, as `"METHOD /path"` with `{name}` for a path parameter. A connector with several hosts names the host too: `"GET api.boards.example/v1/me"`. At most one route is a write (anything but GET and HEAD).
- `resource`: the one string argument that names the record a call acts on, such as a board. A permission can be held to one record, and a path parameter of that name is held to the record the call's permission names.
- `scopes`: the OAuth scopes it needs, among those its connector's `auth` asks for.
- `handler`: the call, as `(args, api, call)`. It gets the arguments, already checked, and the vendor's API.

`readOnly` and `reach` are checked against the rules that class every tool by its name, its arguments and its routes' paths, and a connector that claims less than they find isn't built:

- A read-only tool sends only GET and HEAD requests, and its name says no change (`send_message` can't be read-only).
- A tool whose arguments name people it may reach (`to`, `recipients`, `attendees`, `cc`, `email`, a callback) reaches `others`. So does a write named for delivering (send, notify, reply, publish), one with an argument that sends (`sendNow`, `notifyAttendees`), one that acts on a channel, a user, an assignee, a watcher or a URL, and one that writes in a chat or mail (`chat.createMessage`). A draft reaches nobody until someone sends it, so `mail.createDraft` taking `to` is fine. A write that only sorts mail or messages (`mail.label`) reaches whom the connector declares.
- A tool named for what Grasp never does (deleting, sharing and permissions, forwarding and mail rules, settings, payments) is refused whatever it declares, and no route is a DELETE.
- Each route's path is read by the same words, its parameters left out, so a mild name can't hide what a route does. A path that names what Grasp never does refuses the tool ("a route's path names what Grasp never does": `POST /messages/{id}/trash`). A write whose path delivers reaches `others` ("a route's path delivers to people, so it reaches others": `POST /me/sendMail`), but for a draft's own route: `mail.createReplyDraft` may write to `createReply`, never to `reply`. A read-only tool whose path changes or delivers is refused ("it is read-only, but a route's path says it changes or delivers something": `GET /api/chat.postMessage`).

Type every value the vendor gives a shape. A free-form `v.json()` in a connector, such as a vendor's custom fields, carries a comment on the line before it saying why, and the lint refuses one without.

## The API

`api` sends a request to one of the tool's routes, as the route is declared: `api.get("/v1/boards/{board}/items", { path, query, body, returns })`, and `post`, `put`, `patch` and `head` the same way. It fills in each path parameter from `path` as one segment of the path (a value can't be empty, `.` or `..`, or hold `/ \ ? # % ; :` or a control character; it's refused before anything is sent), adds `query` (leaving out undefined and null values) and sends `body` as JSON. A route the tool doesn't declare is refused before anything is sent.

`returns` is optional. With it, the answer is checked against it and typed by it, and one that doesn't fit fails the call. Fields it doesn't name are left out, so a field the vendor adds never breaks a call: name only what the connector reads. Without it, the answer is `unknown`: the JSON, or the text when the answer isn't JSON. Either way, the tool's own `returns` checks what the handler makes of it.

A call sends at most one write, as its last request: a write sent while another request is still out is refused, and once the write is sent, any other request is refused. That's how connect can tell a caller whether nothing was done.

## Writes that can be recovered

A write whose answer was lost, by a timeout or a dropped connection, has an unknown outcome. By default connect never sends it again, and its caller is told the outcome is unknown. A tool says how its effect can be recovered:

- `repeatable: true`: sending it twice changes nothing, because it sets a state, or the vendor keeps the call's key. Connect may send it again.
- `find`: looks the effect up instead of carrying it out, as `(args, api, call)` like `handler`. It answers what the handler would have answered had the write happened, or `null` only when it certainly didn't. Its `api` has only the tool's reads.

A tool declares one or the other, or neither. `call.key` is the call's effect key: the same for every attempt of one call, and different for any other. A tool that finds its effect gives the key to the vendor with the write, as a tag on what it makes, and looks for it:

```ts write-tools.ts
import { tool, v } from "@grasp-os/sdk/connector";

const Item = v.object({ id: v.string(), title: v.string(), done: v.boolean() });

/** Marks an item done: sending it twice changes nothing. */
export const finish = tool({
  description: "Marks an item done",
  readOnly: false,
  reach: "company",
  resource: "board",
  routes: ["PATCH /v1/boards/{board}/items/{item}"],
  args: { board: v.string(), item: v.string() },
  returns: Item,
  repeatable: true,
  handler: async ({ board, item }, api) =>
    await api.patch("/v1/boards/{board}/items/{item}", {
      path: { board, item },
      body: { done: true },
      returns: Item,
    }),
});

/** Adds an item, tagged with the call's key, so connect can find it. */
export const add = tool({
  description: "Adds an item to a board",
  readOnly: false,
  reach: "company",
  resource: "board",
  routes: ["GET /v1/boards/{board}/items", "POST /v1/boards/{board}/items"],
  args: { board: v.string(), title: v.string().min(1) },
  returns: Item,
  handler: async ({ board, title }, api, call) =>
    await api.post("/v1/boards/{board}/items", {
      path: { board },
      body: { title, tag: call.key },
      returns: Item,
    }),
  find: async ({ board }, api, call) => {
    const { data } = await api.get("/v1/boards/{board}/items", {
      path: { board },
      query: { tag: call.key },
      returns: v.object({ data: v.array(Item) }),
    });
    return data[0] ?? null;
  },
});
```

Each goes into the connector's `tools` under its name, such as `"items.finish": finish`.

## Signing in

Connect runs the sign-in the connector declares, and keeps the token or key:

- `auth.apiKey({ header, prefix, account })`: a key the person pastes, sent in `header` on every request, after `prefix` (such as `"Bearer "`) if there is one.
- `auth.oauth2({ authorizeUrl, tokenUrl, revokeUrl, scopes, account })`: OAuth 2.0 with the authorization code, PKCE and refresh. `scopes` maps each scope it may ask for to what it allows, and its tools' `scopes` are among them. Without `revokeUrl`, disconnecting deletes the tokens only.
- `auth.login({ fields, account, request, token, expiresIn })`: a sign-in with a call, for a system with no API key or OAuth, such as an ERP that takes a user name and a password and answers with a session. See [Session logins](#session-logins).

```ts oauth.ts
import { auth } from "@grasp-os/sdk/connector";

export const boardsSignIn = auth.oauth2({
  authorizeUrl: "https://boards.example/oauth/authorize",
  tokenUrl: "https://boards.example/oauth/token",
  revokeUrl: "https://boards.example/oauth/revoke",
  scopes: {
    "items:read": "Read the items on boards",
    "items:write": "Add and change items",
  },
  account: {
    url: "https://api.boards.example/v1/me",
    id: "/id",
    email: "/email",
  },
});
```

Both name an `account` lookup: a GET to a URL on one of the hosts the credential goes to, sent with the new token or key, and JSON Pointers into its answer for the account's stable `id` and, if the vendor has them, its `name` and `email`. The email, as the vendor vouches for it, is what lets a person connect their own account. Without it, the vendor's accounts are connected only as shared ones, by an admin.

Grasp's client at the vendor, its ID and secret, is the deployment's, found by the provider's name: a connector never names one.

### Where the credential goes

The credential goes only to the hosts the sign-in names in `hosts`. A request to any other host of the connector goes without it. A connector with one host needs no `hosts`: the credential goes to that host. A connector with several hosts must name them, and its `account` lookup must go to one of them:

```ts hosts.ts
import { auth } from "@grasp-os/sdk/connector";

// The connector's hosts are api.boards.example and files.boards.example:
// downloads from files.boards.example go without the key.
export const boardsKey = auth.apiKey({
  header: "x-api-key",
  hosts: ["api.boards.example"],
  account: { url: "https://api.boards.example/v1/me", id: "/account/id" },
});
```

Before the connector's code reads an answer, connect drops its `Set-Cookie` and `Set-Cookie2` headers and replaces each copy of the credential in its headers, as sent, bare or JSON-escaped, with `[credential]`. The body comes as the vendor sent it: a vendor that echoes the credential in a body, or encodes it some other way, hands it to the connector's code. A redirect is followed only to a host a route's `redirects` names, and never with the credential.

### Hosts set per connection

A host that differs from one connection to the next is a template in `hosts`:

- `{name}.<host>`: one DNS label in front of a fixed name, such as `{company}.boards.example`.
- `{name}` alone: a whole host, such as a company's own server, with `auth.apiKey` or `auth.login` only. Only an admin gives it: its connections are shared ones.

Routes name a template like any other host, and the connector's code never learns the host it stands for: connect fills it in as each request leaves. Code that calls `fetch` itself sends to the template's stand-in, `company.boards.example.invalid` for `{company}.boards.example` and `host.invalid` for `{host}`. With `auth.apiKey`, whoever connects gives each template's host along with the key. With `auth.oauth2`, the token response names the host. `hostsFrom` maps each template to a JSON Pointer into that response, pointing at a host or an HTTPS origin, and the account is read with a lookup, never from an ID token:

```ts company.ts
import { auth } from "@grasp-os/sdk/connector";

// The connector's hosts are ["{company}.boards.example"].
export const companySignIn = auth.oauth2({
  authorizeUrl: "https://boards.example/oauth/authorize",
  tokenUrl: "https://boards.example/oauth/token",
  scopes: { "items:read": "Read the items on boards" },
  hostsFrom: { "{company}.boards.example": "/api_domain" },
  account: {
    url: "https://{company}.boards.example/v1/me",
    id: "/id",
    email: "/email",
  },
});
```

A filled host is read as a URL parser reads it, in lower case, and must fit its template: a DNS name with no address, port, userinfo or path, and for `{name}.<host>` one label in front of the fixed name. Connect checks this before anything is sent there, the account lookup included. A sign-in whose host doesn't fit connects nothing. The hosts are sealed with the credential, so a connection's host never changes: the same account at another host is another connection, and moving to another host means connecting again.

### Session logins

`auth.login` declares the call that signs in, and connect makes it: with the fields the person gave, and again whenever the session runs out. The connector's code never sees the fields, the login's answer or the session.

```ts login.ts
import { auth, v } from "@grasp-os/sdk/connector";

// The connector's one host is erp.example.
export const erpLogin = auth.login({
  fields: { userName: v.string(), password: v.string() },
  account: "userName",
  request: {
    url: "https://erp.example/api/auth/login",
    json: { userName: "{userName}", password: "{password}" },
  },
  token: { from: "/token", header: "authorization", prefix: "Bearer " },
  expiresIn: "/expires_in",
});
```

- `fields`: what the person gives, each a plain `v.string()`. `account` names the one that names the account, which is shown; every other field is a secret. The account is that field's value, so the same user name is the same connection.
- `request`: one POST to `url`, on a host the credential goes to, over HTTPS, with no query string. Its body is `json` or `form` (form-encoded). Each value is a field's placeholder, such as `"{password}"`, replaced by the whole of what the person gave, or a constant without braces. Every field is sent, and nothing is ever spliced into text, so a password holding quotes or braces is sent as it is.
- `token`: where the answer holds the session. `{ from, header, prefix }` reads a token at a JSON Pointer into the answer and sends it in `header` after `prefix`, as an API key is. `{ cookie }` reads the cookie of that name the answer sets and sends it as that one cookie. Its `Domain`, `Path` and other attributes are ignored, and no other cookie is kept.
- `expiresIn`: a JSON Pointer to how many seconds the session lasts. Without it, a session that is a JWT lasts until its `exp`. Otherwise, it lasts a day. Whatever it says, connect logs in again after two minutes at the earliest and a day at the latest.

A login answered with anything but a success, a `429` or a `5xx` (a redirect included, which is never followed) marks the connection as needing sign-in. Its fields are deleted, so nothing logs in with them again until a person gives them anew: a password changed at the vendor can't lock the account with retries. A login answered `429` or `5xx`, or not at all, pauses the connection for as long as the vendor's `retry-after` says, or a minute.

When the vendor refuses a session with a `401`, connect logs in once more, however many calls were refused that session at once. A read is sent again with the new session, but a write is not: it fails, and its caller decides. A call refused the new session too gets the `401`, and doesn't log in again.

As with an API key, whoever connects gives each [host template](#hosts-set-per-connection)'s host with the fields, and an admin may reach a shared connection through the company network: the login and every call then go to the address the admin gave.

### A suite's sign-in

A vendor whose accounts belong to a company's own tenant (a directory, a workspace domain) can say what pins the sign-in to it, and more, in the same `auth.oauth2`. Pinning works only for a provider the deployment has a tenant for: today Grasp has one for `microsoft` (the Entra tenant ID) and `google` (the hosted domain), from the deployment's sign-in, and for no other provider. And while connect has its own config for `microsoft` and `google`, that config wins over a connector's declaration: until each suite's connector declares its sign-in and connect's config for it goes, no declared pinned sign-in runs.

- `tenant`: the kind of the organization's tenant at the vendor, `"guid"` or `"domain"`. Connect fills `{tenant}` in the endpoints' paths (never their hosts), in `params`, and in the ID token's issuer and claims with the organization's own tenant, in lower case.
- `params`: parameters the authorization request adds, such as `prompt`. A record may not set the redirect URI, the state, PKCE, the client, the scopes or the response mode.
- `idToken`, instead of `account`: the account comes from the OpenID ID token the token endpoint answers with. It must come from one of the `issuer`s, exactly, for Grasp's client; each of `claims` must say what it says there (without case) or be `true`; each of `sameIssuer` must be absent or the issuer itself. `subject` names the claim of the account's stable ID, and `name` and `email` the claims its name and address come from, the first that is there. A pinned sign-in checks its tenant in the issuer or a claim, and asks for `openid`.
- `rights`: what a consent asks for by the tool classes the company has on: `signIn` always, each class's while it is on, `implied` what a scope takes in besides itself (each scope lists everything it takes in, also through the scopes it takes in, never itself, so there are no cycles), and `sharedMailbox` while a shared mailbox is pointed at (`reach` with Reach others on too). Turning a class on asks the connections whose grant lacks its scopes to connect again. Every scope here is one of `scopes`, and each of `scopes` is asked for by the sign-in, a class or a shared mailbox. The vendor's token answer must list the scopes it granted: an answer that lists none, or isn't a list as RFC 6749 §3.3 writes one, counts as listing nothing: it is refused when connecting, and a renewal's keeps the grant it renews. Without `rights`, a consent asks for every scope.
- `scopePrefix`: a URL ending in `/` the vendor's token answer may put before a scope, left out when scopes are compared.
- `renewalRequires`: scopes a renewed token must still hold, or its connection is asked to connect again. With `rights`, only scopes of `signIn`, which every consent asks for.
- `grant: "account"`: revoking one token revokes the account's whole grant with Grasp's client, so connect never revokes an old token while the same account holds the grant again.

```ts suite.ts
import { auth } from "@grasp-os/sdk/connector";

export const suiteSignIn = auth.oauth2({
  authorizeUrl: "https://login.suite.example/{tenant}/oauth2/authorize",
  tokenUrl: "https://login.suite.example/{tenant}/oauth2/token",
  revokeUrl: "https://login.suite.example/oauth2/revoke",
  scopes: {
    openid: "Sign you in",
    email: "Read your address",
    offline_access: "Stay signed in",
    "Mail.Read": "Read your mail",
    "Mail.ReadWrite": "Change your mail",
    "Mail.Send": "Send mail as you",
  },
  params: { prompt: "select_account" },
  tenant: "guid",
  idToken: {
    issuer: "https://login.suite.example/{tenant}/v2.0",
    subject: "oid",
    name: ["preferred_username"],
    email: ["email", "preferred_username"],
    claims: { tid: "{tenant}" },
    sameIssuer: ["idp"],
  },
  rights: {
    signIn: ["openid", "email", "offline_access"],
    classes: {
      "read-own": ["Mail.Read"],
      "change-own": ["Mail.ReadWrite"],
      "read-company": [],
      "change-company": [],
      "reach-others": ["Mail.Send"],
      "read-others": [],
    },
    implied: { "Mail.ReadWrite": ["Mail.Read"] },
  },
  scopePrefix: "https://api.suite.example/",
  grant: "account",
});
```

## Lists

`page(Item)` is what a list answers, one page at a time: `{ items, next }`, where `next` is where the next page starts, or `null` after the last. `items.list` above takes the next page's start as its `cursor` argument.

## Events and syncs

A connector can also declare `events` (with `event`: what a workflow could start on, read by polling) and `syncs` (with `sync`: records kept in step with the vendor's, a page at a time from a checkpoint). They are declared and typed only, and their routes are checked against the connector's hosts. A route of theirs may not deliver to people (`GET /api/chat.postMessage`), since they run on their own and it would on every run. Connect doesn't serve them yet.
