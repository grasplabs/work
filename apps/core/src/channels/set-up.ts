import { signInConfig } from "../auth/config.ts";
import { gmailSetUp } from "./gmail.ts";
import { telegramSetUp } from "./telegram.ts";
import { whatsAppSetUp } from "./whatsapp.ts";

/** A chat platform Stephen can be set up on, by its Chat SDK adapter's name. */
export type SetUpPlatform =
  | "teams"
  | "slack"
  | "whatsapp"
  | "telegram"
  | "gmail";

/**
 * Whether the deployment set `platform` up: Teams once it has the bot's id
 * and the client's Entra tenant, Slack once it has the app's signing
 * secret, without which every request would be refused anyway.
 */
export const isSetUp = (
  env: Env,
  platform: string
): platform is SetUpPlatform => {
  if (platform === "gmail") {
    return gmailSetUp(env) !== undefined;
  }
  if (platform === "whatsapp") {
    return whatsAppSetUp(env);
  }
  if (platform === "telegram") {
    return telegramSetUp(env);
  }
  if (platform === "slack") {
    return (
      env.SLACK_SIGNING_SECRET !== undefined && env.SLACK_SIGNING_SECRET !== ""
    );
  }
  return (
    platform === "teams" &&
    env.TEAMS_BOT_ID !== undefined &&
    env.TEAMS_BOT_ID !== "" &&
    signInConfig(env)?.entra?.tenantId !== undefined
  );
};
