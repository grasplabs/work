/**
 * A client's own Slack app, as staff create it in the client's Slack from
 * a manifest (api.slack.com/apps, "From a manifest"): Stephen as a bot
 * that answers direct messages, sending everything Slack posts to the
 * client's core (core's src/channels/door.ts, `/api/channels/slack`).
 *
 * It asks for no more than connect lets core send (connect's
 * src/channels.ts, `slackMethods`) and the door reads: writing its own
 * messages, reading the direct messages people send it and their
 * conversations' kind, and who someone is. No channel history, no
 * files, no user scopes, no admin, and nothing in channels it isn't in.
 * Its bot token (`xoxb-`) and signing secret are then set as the
 * client's sealed secrets (src/deploy/sealed-secrets.ts).
 */

/** Slack's limit on an app's name. */
const slackAppNameLength = 35;

/** What the app may do, as the bot: connect's allowlist needs no more. */
export const slackBotScopes = [
  "chat:write",
  "im:history",
  "im:read",
  "users:read",
] as const;

/** Where Slack posts to the client's core, with `hostname` its host. */
export const slackRequestUrl = (hostname: string): string =>
  `https://${hostname}/api/channels/slack`;

/** The app's name: Stephen, with the client's name while it fits. */
const appName = (clientName: string): string => {
  const named = `Stephen for ${clientName}`;
  return named.length <= slackAppNameLength ? named : "Stephen";
};

/**
 * The manifest of client `clientName`'s Slack app, on `hostname`: a bot
 * that only answers in its own direct messages, with Slack's events and
 * its buttons both sent to core's door.
 */
export const slackAppManifest = (hostname: string, clientName: string) => {
  const requestUrl = slackRequestUrl(hostname);
  return {
    display_information: {
      name: appName(clientName),
      description: "Ask Stephen, your company's assistant in Grasp.",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: "Stephen", always_online: true },
    },
    oauth_config: { scopes: { bot: [...slackBotScopes] } },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: ["message.im"],
      },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
};
