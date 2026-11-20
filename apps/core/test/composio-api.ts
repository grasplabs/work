/**
 * Composio's REST API as the connect Worker reaches it in core's tests:
 * part of the `connect-providers` Worker (test/connect-providers.ts), so
 * the real connect runs unchanged behind core. It lists three toolkits:
 * HubSpot, one it holds no app for, and one that takes a key. An admin's
 * auth at its link succeeds at once: the link it gives is the callback
 * connect asked it to send the browser back to; a key it takes is
 * {@link acmeCrmKey} alone.
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
      tools_count: 2,
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
    auth_schemes: ["API_KEY"],
    composio_managed_auth_schemes: [],
    meta: { categories: [{ id: "crm", name: "CRM" }], tools_count: 1 },
  },
];

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

/** HubSpot's tools, as Composio's API lists them. */
export const composioTools = [
  "HUBSPOT_LIST_CONTACTS",
  "HUBSPOT_CREATE_CONTACT",
];

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
    const toolkit = url.searchParams.get("toolkit_slug");
    const tools = toolkit === "hubspot" ? ${JSON.stringify(composioTools)} : toolkit === "acme_crm" ? ["ACME_CRM_LIST_DEALS"] : [];
    return Response.json({ items: tools.map((slug) => ({ slug })), next_cursor: null });
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
    return Response.json({ redirect_url: callback_url, connected_account_id: id });
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
  if (request.method === "POST" && route === "/mcp/servers") {
    return Response.json({ id: crypto.randomUUID() });
  }
  if (request.method === "POST" && route === "/mcp/servers/generate") {
    const { mcp_server_id, connected_account_ids } = await request.json();
    return Response.json({
      connected_account_urls: connected_account_ids.map(
        (id) => "https://backend.composio.dev/v3/mcp/" + mcp_server_id + "?connected_account_id=" + id
      ),
    });
  }
  if (request.method === "DELETE") {
    return Response.json({ success: true });
  }
  return new Response("Not found", { status: 404 });
};
`;
