import { signInConfig } from "../auth/config.ts";

/** A chat platform Stephen can be set up on, by its Chat SDK adapter's name. */
export type SetUpPlatform = "teams" | "slack";

/**
 * Whether the deployment set `platform` up: Teams once it has the bot's id
 * and the client's Entra tenant, Slack once it has the app's signing
 * secret, without which every request would be refused anyway.
 */
export const isSetUp = (
  env: Env,
  platform: string
): platform is SetUpPlatform => {
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
