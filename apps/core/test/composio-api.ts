/**
 * Composio's REST API as the connect Worker reaches it in core's tests:
 * part of the `connect-providers` Worker (test/connect-providers.ts), so
 * the real connect runs unchanged behind core. It lists three toolkits:
 * HubSpot, one it holds no app for, and one that takes a key, and makes
 * a session for a connection as Composio does. An admin's
 * auth at its link succeeds at once: the link it gives is the callback
 * connect asked it to send the browser back to, with `status=success` and
 * the `connected_account_id` appended, as Composio's redirect does; a key
 * it takes is
 * {@link acmeCrmKey} alone. It also lists the toolkits of the tests'
 * connections to a mail provider's server (test/mail-server.ts), so
 * connect can tell which of their tools Composio tags read-only.
 * Imported by vite.config.ts (Node) and the tests (workerd), so it only
 * holds data.
 */
import { testComposioKey } from "../../connect/test/provider-config.ts";

/** Composio's toolkits, as its API lists them in core's tests. */
export const composioToolkits = [
  {
    slug: "hubspot",
    name: "HubSpot",
    composio_managed_auth_schemes: ["OAUTH2"],
    meta: {
      categories: [{ id: "crm", name: "CRM" }],
      tools_count: 4,
      description:
        "HubSpot is a CRM platform for marketing, sales and service. It brings teams together.",
      logo: "https://logos.composio.dev/api/hubspot",
    },
  },
  // Composio holds no app for it: connecting it takes the organization's own.
  {
    slug: "acme_erp",
    name: "Acme ERP",
    composio_managed_auth_schemes: [],
    meta: { categories: [{ id: "erp", name: "ERP" }], tools_count: 1 },
  },
  // Composio holds no app for it, and it takes a key an admin types in.
  {
    slug: "acme_crm",
    name: "Acme CRM",
    // In lower case, as Composio's toolkit list names schemes.
    auth_schemes: ["api_key"],
    composio_managed_auth_schemes: [],
    meta: { categories: [{ id: "crm", name: "CRM" }], tools_count: 1 },
  },
  // The toolkits of the tests' connections to a mail provider's server
  // (test/mail-connection.ts), each holding the tools of `taggedTools`.
  ...["mail", "mail_own", "crm", "bulk"].map((slug) => ({
    slug,
    name: slug,
    composio_managed_auth_schemes: ["OAUTH2"],
    meta: { categories: [], tools_count: 1 },
  })),
];

/** The tests' `bulk` tools, each read-only (test/tool-search.test.ts). */
const bulkTools = [
  ...Array.from({ length: 3000 }, (_, index) => `BULK_TOOL_${index}`),
  "BULK_FIND_SHIPMENT",
  ...Array.from({ length: 21 }, (_, index) => `BULK_QUOKKA_READ_${index}`),
  "BULK_WOMBAT_READ_0",
  "BULK_WOMBAT_READ_1",
];

/** The mail toolkits' tools Composio tags read-only, and the rest. */
const mailReads = [
  "mail.search",
  "mail.read",
  "mail.others",
  "MAIL_SEARCH",
  "MAIL_READ",
];
const mailChanges = ["mail.send", "MAIL_SEND", "MAIL_REPLY"];

/**
 * Each toolkit's tools: those Composio tags read-only (`readOnlyHint`),
 * which the tests allow as reads, and the rest, listed without the tag.
 * Connect runs a tool as a read only if Composio tags it so.
 */
const taggedTools: Record<string, { reads: string[]; changes: string[] }> = {
  // With the CRM's tools in Stephen's eval (fixtures/stephen-world.ts).
  hubspot: {
    reads: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_SEARCH_NOTES"],
    changes: ["HUBSPOT_CREATE_CONTACT", "HUBSPOT_UPDATE_DEAL"],
  },
  acme_crm: { reads: [], changes: ["ACME_CRM_LIST_DEALS"] },
  mail: { reads: mailReads, changes: mailChanges },
  mail_own: { reads: mailReads, changes: mailChanges },
  crm: { reads: ["CRM_LIST_CONTACTS"], changes: [] },
  bulk: { reads: bulkTools, changes: [] },
};

/** The one key Acme CRM's provider accepts. */
export const acmeCrmKey = "acme-crm-test-key";

/** Acme CRM's auth, as Composio describes the toolkit. */
const acmeCrmDetail = {
  slug: "acme_crm",
  auth_config_details: [
    {
      mode: "API_KEY",
      name: "API key",
      required_scopes: [],
      is_connection_revoke_supported: false,
      fields: {
        auth_config_creation: { required: [], optional: [] },
        connected_account_initiation: {
          required: [
            {
              name: "generic_api_key",
              displayName: "API key",
              type: "string",
              description: "Your Acme CRM API key",
              required: true,
              is_secret: true,
              user_visible: true,
            },
          ],
          optional: [],
        },
      },
    },
  ],
};

/** HubSpot's logo, as Composio's logo host serves it. */
export const hubspotLogo =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>parent.stolen = document.cookie</script><rect width="1" height="1"/></svg>';

/** The logo host, as script for the `connect-providers` Worker. */
export const composioLogoScript = `
const composioLogo = (url) =>
  url.pathname === "/api/hubspot"
    ? new Response(${JSON.stringify(hubspotLogo)}, { headers: { "content-type": "image/svg+xml" } })
    : new Response("Not found", { status: 404 });
`;

/** The API, as script for the `connect-providers` Worker. */
export const composioApiScript = `
const composioAccounts = new Map();
const composioAuthConfigs = new Map();
const composioApi = async (request, url) => {
  if (request.headers.get("x-api-key") !== ${JSON.stringify(testComposioKey)}) {
    return new Response("Unauthorized", { status: 401 });
  }
  const route = url.pathname.slice("/api/v3.1".length);
  if (route === "/toolkits") {
    return Response.json({ items: ${JSON.stringify(composioToolkits)}, next_cursor: null });
  }
  if (route === "/toolkits/acme_crm") {
    return Response.json(${JSON.stringify(acmeCrmDetail)});
  }
  if (route === "/tools") {
    const tools = ${JSON.stringify(taggedTools)}[url.searchParams.get("toolkit_slug")] ?? { reads: [], changes: [] };
    return Response.json({
      items: [
        ...tools.reads.map((slug) => ({ slug, tags: ["readOnlyHint"] })),
        ...tools.changes.map((slug) => ({ slug })),
      ],
      next_cursor: null,
    });
  }
  if (request.method === "POST" && route === "/auth_configs") {
    const { toolkit } = await request.json();
    const id = "ac_" + crypto.randomUUID();
    composioAuthConfigs.set(id, toolkit.slug);
    return Response.json({ auth_config: { id } });
  }
  if (request.method === "POST" && route === "/connected_accounts/link") {
    const { auth_config_id, callback_url } = await request.json();
    const id = "ca_" + crypto.randomUUID();
    composioAccounts.set(id, auth_config_id);
    // The admin's auth succeeds at once: the link is where Composio then
    // sends the browser, the callback with its own query appended.
    const back = new URL(callback_url);
    back.searchParams.append("status", "success");
    back.searchParams.append("connected_account_id", id);
    return Response.json({ redirect_url: back.href, connected_account_id: id });
  }
  if (request.method === "POST" && route === "/connected_accounts") {
    const { auth_config, connection } = await request.json();
    if (connection.state.val.generic_api_key !== ${JSON.stringify(acmeCrmKey)}) {
      return Response.json(
        { error: { message: "Rejected", code: 1, slug: "ConnectedAccount_CredentialValidationRejected", status: 400 } },
        { status: 400 }
      );
    }
    const id = "ca_" + crypto.randomUUID();
    composioAccounts.set(id, auth_config.id);
    return Response.json({ id, status: "ACTIVE" });
  }
  if (request.method === "GET" && route.startsWith("/connected_accounts/")) {
    const id = route.slice("/connected_accounts/".length);
    const authConfig = composioAccounts.get(id);
    return Response.json({
      id,
      status: "ACTIVE",
      toolkit: { slug: composioAuthConfigs.get(authConfig) },
      auth_config: { id: authConfig },
    });
  }
  if (request.method === "POST" && route === "/tool_router/session") {
    const body = await request.json();
    const id = "trs_" + crypto.randomUUID();
    return Response.json(
      {
        session_id: id,
        mcp: { type: "http", url: "https://backend.composio.dev/api/v3/tool_router/session/" + id + "/mcp" },
        tool_router_tools: [],
        config: {
          user_id: body.user_id,
          connected_accounts: body.connected_accounts,
          manage_connections: { enabled: body.manage_connections?.enable !== false },
          search: { enable: body.search?.enable !== false },
          workbench: { enable: body.workbench?.enable !== false },
          proxy_execute: { enable: body.proxy_execute?.enable === true },
          instant: body.instant === false ? false : {},
        },
        config_version: 1,
      },
      { status: 201 }
    );
  }
  if (route.startsWith("/mcp")) {
    // Composio's legacy MCP servers: connect never asks for one.
    return new Response("Legacy MCP servers are not served", { status: 410 });
  }
  if (request.method === "DELETE") {
    return Response.json({ success: true });
  }
  return new Response("Not found", { status: 404 });
};
`;
