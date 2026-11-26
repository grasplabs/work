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
- It never sees a token or a key. Connect adds the connection's credential to each request on its way out, after the connector's code is done with it.
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
- `redirects`: for a GET route of its own, the hosts its answer may redirect to, as `*.<host>` where `*` is one label: `{ "GET /v1/files/{file}": ["*.storage.boards.example"] }`. Connect's egress follows one such redirect itself, without the token. Any other redirect is refused.
- `handler`: the call, as `(args, api, call)`. It gets the arguments, already checked, and the vendor's API. It refuses a call by throwing a `ToolError` with a `code`, such as `new ToolError("This list is shared", { code: "access_denied" })` or `invalid` for an argument `v` can't check: thrown before the tool's write, the call failed and nothing was done. Anything else it throws fails a read, and leaves a write's outcome unknown.

## The API

`api` sends a request to one of the tool's routes, as the route is declared: `api.get("/v1/boards/{board}/items", { path, query, body, returns })`, and `post`, `put`, `patch`, `delete` and `head` the same way. It fills in each path parameter from `path` as one segment of the path (a value can't be empty, `.` or `..`, or hold `/ \ ? # % ; :` or a control character; it's refused before anything is sent), adds `query` (leaving out undefined and null values) and sends `body` as JSON. A route the tool doesn't declare is refused before anything is sent.

`returns` is optional. With it, the answer is checked against it and typed by it, and one that doesn't fit fails the call. Fields it doesn't name are left out, so a field the vendor adds never breaks a call: name only what the connector reads. Without it, the answer is `unknown`: the JSON, or the text when the answer isn't JSON. Either way, the tool's own `returns` checks what the handler makes of it.

A call sends at most one write, as its last request: a write sent while another request is still out is refused, and once the write is sent, any other request is refused. That's how connect can tell a caller whether nothing was done.

`api` takes more than JSON:

- `headers`: request headers the call adds, such as `if-match` with an etag, or `prefer`. Names are lowercase, and values are visible ASCII and spaces. A header that connect's egress or the body sets is refused before anything is sent: `authorization`, `proxy-authorization`, `cookie`, `host`, `connection`, `content-length`, `content-type`, `transfer-encoding`, `te`, `upgrade`, `forwarded`, any `x-forwarded-*`, the method overrides (`x-http-method-override`, `x-http-method`, `x-method-override`) and `grasp-egress`.
- `contentType`: a media type, such as `text/html`. With it, a string `body` or a `Uint8Array` one goes out exactly as it is, under that type. Without it, `body` goes out as JSON. Bytes always need it, and it can't be set without a string or bytes body.
- `as: "bytes"`: the answer is the body's exact bytes, a `Uint8Array`, within the same size limit as any answer. It takes no `returns`.

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

## What a call read and changed

Connect records what each call read, by the vendor's IDs, from its answer: the string `id` of each of its `items`, or else the answer's own `id`, or else nothing. A handler never reports it.

A read that answers one item, such as a message or a page, says `answersItem: true`. Its answer's own `id` then names exactly that item, and one without it fails the call. Core may keep what such a tool reads of the person's own things as a source in the Brain.

A write reports what it changed with `call.changed({ before, after })`, once, for the audit's record of old and new values. A change past 256 KiB of JSON, or a second one, leaves the call's outcome unknown, as does any answer that isn't what the tool declares once its write went out.

## Confirmation

A write may say how a call reads to the person asked to confirm it: `describe`, a `title` and the args that matter, each under a `label`. The person sees each value exactly as the call holds it, and is told when the call holds more than these show, so list every arg that changes what it does. Without it they see the tool's name and the raw args. `call.confirmed` says whether the person confirmed this call on such a card.

```ts notes-tools.ts
import { tool, v } from "@grasp-os/sdk/connector";

/** Replaces an item's notes, unless someone changed them since. */
export const writeNotes = tool({
  description: "Replaces an item's notes",
  readOnly: false,
  reach: "company",
  resource: "board",
  routes: ["PUT /v1/boards/{board}/items/{item}/notes"],
  args: {
    board: v.string(),
    item: v.string(),
    notes: v.string(),
    etag: v.string(),
  },
  describe: {
    title: "Replace an item's notes",
    fields: [
      { label: "Item", arg: "item" },
      { label: "Notes", arg: "notes" },
      { label: "Version", arg: "etag" },
    ],
  },
  returns: v.object({ id: v.string(), etag: v.string() }),
  handler: async ({ board, item, notes, etag }, api, call) => {
    const answer = await api.put("/v1/boards/{board}/items/{item}/notes", {
      path: { board, item },
      headers: { "if-match": etag },
      body: notes,
      contentType: "text/markdown",
      returns: v.object({ etag: v.string(), previous: v.string() }),
    });
    call.changed({ before: answer.previous, after: notes });
    return { id: item, etag: answer.etag };
  },
});
```

## Files

A read that answers a file says `answersFile: true`. It takes an `as` arg of `"text"` or `"base64"` and answers `name`, `contentType`, `encoding` and `content`, as `contentAs(bytes, as)` makes the last two. A workflow may then keep the answer as a file of its run instead of passing the bytes on.

A write that attaches files says `takesFiles: true` and has exactly the SDK's `attachments` as its `attachments` arg: each file by name, type, size and SHA-256. A workflow names its run's files, and connect hands the call their bytes beside its args. They are checked against the digests before the handler runs, with none missing or extra, and `attachedFiles(args.attachments, call)` gives each file with its bytes. A handler refuses a call it can't carry out by throwing a `ToolError` before its write.

```ts file-tools.ts
import {
  attachedFiles,
  attachments,
  contentAs,
  tool,
  ToolError,
  v,
} from "@grasp-os/sdk/connector";

/** Reads an item's file, which the vendor serves from its storage. */
export const readFile = tool({
  description: "Reads the file on an item",
  readOnly: true,
  reach: "company",
  answersFile: true,
  routes: ["GET /v1/items/{item}/file"],
  redirects: { "GET /v1/items/{item}/file": ["*.storage.boards.example"] },
  args: { item: v.string(), as: v.enum(["text", "base64"]) },
  returns: v.object({
    name: v.string(),
    contentType: v.string(),
    encoding: v.enum(["text", "base64"]),
    content: v.string(),
  }),
  handler: async ({ item, as }, api) => {
    const bytes = await api.get("/v1/items/{item}/file", {
      path: { item },
      as: "bytes",
    });
    return {
      name: `${item}.bin`,
      contentType: "application/octet-stream",
      ...contentAs(bytes, as),
    };
  },
});

/** Puts one file on an item. */
export const putFile = tool({
  description: "Puts a file on an item",
  readOnly: false,
  reach: "company",
  takesFiles: true,
  routes: ["PUT /v1/items/{item}/file"],
  args: { item: v.string(), attachments },
  describe: {
    title: "Put a file on an item",
    fields: [
      { label: "Item", arg: "item" },
      { label: "File", arg: "attachments" },
    ],
  },
  returns: v.object({ id: v.string() }),
  handler: async ({ item, attachments: named }, api, call) => {
    const [file, ...more] = attachedFiles(named, call);
    if (file === undefined || more.length > 0) {
      throw new ToolError("Put exactly one file", { code: "invalid" });
    }
    return await api.put("/v1/items/{item}/file", {
      path: { item },
      query: { name: file.name },
      body: file.bytes,
      contentType: file.type,
      returns: v.object({ id: v.string() }),
    });
  },
});
```

## Mail

A tool that reads or changes email says `mail: true`, and a write that mails someone, sending or drafting, says `mail: { recipients: [...] }`, naming the args that hold the addresses it mails, as address strings or within objects. The platform holds mail tools to its mail rules: through one whose `resource` is `"mailbox"`, a chat's agent reaches only its person's own mailbox or one the company pointed it at for them; a card confirming a write tells the person when the turn read mail, which others wrote; and core records a workflow run's mail with its recipients.

A mail tool puts `call.stamp`, when a workflow run sends the mail, on what it sends or drafts as the message's `stampHeader` header, so a copy that reaches a watched mailbox names the run that sent it.

## Signing in

Connect runs the sign-in the connector declares, and keeps the token or key:

- `auth.apiKey({ header, prefix, account })`: a key the person pastes, sent in `header` on every request, after `prefix` (such as `"Bearer "`) if there is one.
- `auth.oauth2({ authorizeUrl, tokenUrl, revokeUrl, scopes, account })`: OAuth 2.0 with the authorization code, PKCE and refresh. `scopes` maps each scope it may ask for to what it allows, and its tools' `scopes` are among them. Without `revokeUrl`, disconnecting deletes the tokens only.

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

Both name an `account` lookup: a GET to a URL on one of the connector's hosts, sent with the new token or key, and JSON Pointers into its answer for the account's stable `id` and, if the vendor has them, its `name` and `email`. The email, as the vendor vouches for it, is what lets a person connect their own account. Without it, the vendor's accounts are connected only as shared ones, by an admin.

Grasp's client at the vendor, its ID and secret, is the deployment's, found by the provider's name: a connector never names one.

### A suite's sign-in

A vendor whose accounts belong to a company's own tenant (a directory, a workspace domain) can say what pins the sign-in to it, and more, in the same `auth.oauth2`. Pinning works only for a provider the deployment has a tenant for: today Grasp has one for `microsoft` (the Entra tenant ID) and `google` (the hosted domain), from the deployment's sign-in, and for no other provider. And while connect has its own config for `microsoft` and `google`, that config wins over a connector's declaration: until each suite's connector declares its sign-in and connect's config for it goes, no declared pinned sign-in runs.

- `tenant`: the kind of the organization's tenant at the vendor, `"guid"` or `"domain"`. Connect fills `{tenant}` in the endpoints' paths (never their hosts), in `params`, and in the ID token's issuer and claims with the organization's own tenant, in lower case.
- `params`: parameters the authorization request adds, such as `prompt`. A record may not set the redirect URI, the state, PKCE, the client, the scopes or the response mode.
- `idToken`, instead of `account`: the account comes from the OpenID ID token the token endpoint answers with. It must come from one of the `issuer`s, exactly, for Grasp's client; each of `claims` must say what it says there (without case) or be `true`; each of `sameIssuer` must be absent or the issuer itself. `subject` names the claim of the account's stable ID, and `name` and `email` the claims its name and address come from, the first that is there. A pinned sign-in checks its tenant in the issuer or a claim, and asks for `openid`.
- `rights`: what a consent asks for by the tool classes the company has on: `signIn` always, each class's while it is on, `implied` what a scope takes in besides itself, and `sharedMailbox` while a shared mailbox is pointed at (`reach` with Reach others on too). Turning a class on asks the connections whose grant lacks its scopes to connect again. Every scope here is one of `scopes`, and each of `scopes` is asked for by the sign-in, a class or a shared mailbox. The vendor's token answer must list the scopes it granted: one that lists none is refused when connecting. Without `rights`, a consent asks for every scope.
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

A connector can also declare `events` (with `event`: what a workflow could start on, read by polling) and `syncs` (with `sync`: records kept in step with the vendor's, a page at a time from a checkpoint). They are declared and typed only, and their routes are checked against the connector's hosts. Connect doesn't serve them yet.
