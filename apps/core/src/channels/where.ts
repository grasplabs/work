import type { ChannelReach } from "@grasp-os/shared/channel-accounts";

import { stephenFor } from "../stephen-reach.ts";
import { isSetUp } from "./set-up.ts";
import type { SetUpPlatform } from "./set-up.ts";

// Where a person reaches Stephen: each chat app the deployment set up, in
// the order Settings shows them, and only where he answers them
// (Settings › Stephen), so nobody is sent to an app that turns them away.
// Each says only what the app shows anyone who looks for him there: the
// Teams bot's app id. Never a secret.

/** The chat apps Stephen can be set up in, in the order they are shown. */
const platforms: readonly SetUpPlatform[] = ["teams", "slack"];

/** How to reach Stephen on `platform`, once it is set up. */
const reachOn = (env: Env, platform: SetUpPlatform): ChannelReach => {
  switch (platform) {
    case "teams": {
      // A chat with the bot, by its app id: Teams opens it, or offers the
      // app first where it isn't added yet.
      const botId = encodeURIComponent(env.TEAMS_BOT_ID ?? "");
      return {
        platform,
        href: `https://teams.microsoft.com/l/chat/0/0?users=28:${botId}`,
      };
    }
    case "slack": {
      // Slack has no link to an app that works in every workspace: people
      // find him under Apps in their own.
      return { platform, href: null };
    }
    default: {
      return platform satisfies never;
    }
  }
};

/** Where `userId` reaches Stephen: each app set up that he answers them in. */
export const stephenReachFor = async (
  env: Env,
  userId: string
): Promise<ChannelReach[]> => {
  const setUp = platforms.filter((platform) => isSetUp(env, platform));
  const answered = await Promise.all(
    setUp.map(async (platform) => {
      const { reaches } = await stephenFor(env, userId, platform);
      return { platform, reaches };
    })
  );
  return answered
    .filter(({ reaches }) => reaches)
    .map(({ platform }) => reachOn(env, platform));
};
