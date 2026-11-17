import type { ChannelReach } from "@grasp-os/shared/channel-accounts";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";

import { Button } from "../grasp/button/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { TitleLine } from "./section.tsx";

// Settings › Security › Chat apps: where the person reaches Stephen, in
// each chat app the deployment set up that he answers them in, as core
// says (`channelAccounts.reach`): where to find him, and a link that opens
// a chat with him where the app has one.

/** Where to find Stephen in `platform`, in the page's language. */
const useFindText = (platform: ChannelReach["platform"]): string => {
  const { t } = useLingui();
  return platform === "teams"
    ? t`Open a chat with Stephen, or search for him in Teams’ apps.`
    : t`Find Stephen under Apps in your Slack workspace.`;
};

/** One app, with where to find him and a link that opens it. */
const ReachRow = ({ reach }: { reach: ChannelReach }) => {
  const { t } = useLingui();
  const app = chatPlatformName(reach.platform);
  const find = useFindText(reach.platform);
  return (
    <Item
      {...(reach.href === null
        ? {}
        : {
            actions: (
              <Button
                render={
                  <a
                    aria-label={t`Open Stephen in ${app}, in a new tab`}
                    href={reach.href}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                size="sm"
              >
                {t`Open`}
              </Button>
            ),
          })}
      size="sm"
      title={<TitleLine detail={find}>{app}</TitleLine>}
    />
  );
};

/** Each chat app the person reaches Stephen in, or nothing if there is none. */
export const WhereStephen = ({ reach }: { reach: ChannelReach[] }) => {
  const { t } = useLingui();
  if (reach.length === 0) {
    return null;
  }
  return (
    <ItemGroup aria-label={t`Where to reach Stephen`} separated>
      {reach.map((one) => (
        <ReachRow key={one.platform} reach={one} />
      ))}
    </ItemGroup>
  );
};
