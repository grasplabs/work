/** Product names, as each platform writes its own; any other as Chat SDK names it. */
const platformNames: Readonly<Record<string, string>> = {
  teams: "Microsoft Teams",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  gchat: "Google Chat",
  "google-chat": "Google Chat",
  github: "GitHub",
  linear: "Linear",
};

/** A chat platform's product name, by its adapter's name: the same in every language. */
export const platformName = (platform: string): string =>
  platformNames[platform] ?? platform;
