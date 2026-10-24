// The secrets connect reads besides those wrangler.jsonc requires, which
// `wrangler types` can't see. Each is optional: connect takes calls without
// them, and whatever needs one fails closed while it is unset. Merged into
// the interface worker-configuration.d.ts generates.
interface __BaseEnv_Env {
  /** Only while rotating: the capability key core signed with before. */
  CAPABILITY_SIGNING_KEY_PREVIOUS?: string;
  /**
   * Seals OAuth tokens (src/vault.ts): 32 random bytes in base64, e.g.
   * `openssl rand -base64 32`. Without it nobody can connect an account.
   */
  TOKEN_ENCRYPTION_KEY?: string;
  /** Only while rotating: the key that sealed tokens before. */
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
  /** Grasp's multi-tenant Entra app for connections (src/providers.ts). */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /**
   * Grasp's multi-tenant Entra app for the application landscape's
   * read-only admin connection (src/providers.ts), registered apart from
   * the one above so its tokens can never carry mail, calendar or files.
   */
  MICROSOFT_LANDSCAPE_CLIENT_ID?: string;
  MICROSOFT_LANDSCAPE_CLIENT_SECRET?: string;
  /**
   * Grasp's multi-tenant Entra app for the directory's read-only admin
   * connection (src/providers.ts), apart for the same reason.
   */
  MICROSOFT_DIRECTORY_CLIENT_ID?: string;
  MICROSOFT_DIRECTORY_CLIENT_SECRET?: string;
  /**
   * Grasp's multi-tenant Entra app for the documents' read-only admin
   * connection (src/providers.ts), apart for the same reason.
   */
  MICROSOFT_DOCUMENTS_CLIENT_ID?: string;
  MICROSOFT_DOCUMENTS_CLIENT_SECRET?: string;
  /** Grasp's Google OAuth client for connections (src/providers.ts). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Grasp's Google OAuth client for the directory's read-only admin
   * connection (src/providers.ts), apart from the one above so that
   * disconnecting either leaves the other's grant alone.
   */
  GOOGLE_DIRECTORY_CLIENT_ID?: string;
  GOOGLE_DIRECTORY_CLIENT_SECRET?: string;
  /**
   * Grasp's Google OAuth client for the documents' read-only admin
   * connection (src/providers.ts), apart for the same reason.
   */
  GOOGLE_DOCUMENTS_CLIENT_ID?: string;
  GOOGLE_DOCUMENTS_CLIENT_SECRET?: string;
  /**
   * Grasp's OAuth apps at the apps that aren't suites (src/providers.ts),
   * as JSON: `{"<provider>": {"id": "...", "secret": "..."}}`, by the
   * provider an app's record names. An app without an entry can't be
   * connected with OAuth.
   */
  APP_OAUTH_CLIENTS?: string;
  /**
   * Grasp's key for the client's Composio project (src/composio.ts): lists
   * Composio's toolkits in the catalog. Without it, nothing of Composio is
   * offered or reached.
   */
  COMPOSIO_API_KEY?: string;
  /**
   * The client's own Teams bot (src/channels.ts): its Entra app ID, the
   * client's tenant the app is registered in, and its client secret. Set
   * by hand on staging until the console seals them per client. While any
   * is unset, every channel request is refused as `unconfigured`.
   */
  TEAMS_BOT_ID?: string;
  TEAMS_BOT_TENANT_ID?: string;
  TEAMS_BOT_SECRET?: string;
  /**
   * The client's own Slack app's bot token (`xoxb-…`, src/channels.ts),
   * set by hand on staging until the console seals it per client. While it
   * is unset, every Slack request is refused as `unconfigured`.
   */
  SLACK_BOT_TOKEN?: string;
  /**
   * The client's WhatsApp Business number: its Cloud API phone number id,
   * the one number connect sends from, and the system user's access token
   * it sends with (src/channels.ts), set by hand on staging until the
   * console seals them per client. While either is unset, every WhatsApp
   * request is refused as `unconfigured`.
   */
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  /**
   * `none` on workerd and on-prem, which have no Cloudflare jurisdiction:
   * the clock's object is then taken from the plain namespace
   * (src/clock.ts). Unset or any other value means the EU. Never set in
   * wrangler.jsonc.
   */
  DURABLE_OBJECT_JURISDICTION?: string;
}
