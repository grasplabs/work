import type { ChannelReach } from "@grasp-os/shared/channel-accounts";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { MessageSquareIcon } from "lucide-react";

// Settings › Security › Chat apps: where the person reaches Stephen, in
// each chat app the deployment set up that he answers them in, as core
// says (`channelAccounts.reach`): the number, the bot or the address to
// write to, and a link that opens a chat with him where the app has one.

/** What to look for in an app that gives no address, in the page's language. */
const useNoAddressText = (platform: string): string => {
  const { t } = useLingui();
  if (platform === "teams") {
    return t`Open a chat with Stephen, or search for him in Teams’ apps.`;
  }
  if (platform === "slack") {
    return t`Find Stephen under Apps in your Slack workspace.`;
  }
  return t`Ask your admin where to write to Stephen there.`;
};

/** One app, with what to write to and a link that opens it. */
const ReachRow = ({ reach }: { reach: ChannelReach }) => {
  const { t } = useLingui();
  const app = chatPlatformName(reach.platform);
  const noAddress = useNoAddressText(reach.platform);
  return (
    <li className="flex items-center gap-3 border-t px-5 py-3">
      <MessageSquareIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{app}</span>
        <span className="text-muted-foreground truncate">
          {reach.address ?? noAddress}
        </span>
      </div>
      {reach.href === null ? null : (
        <Button
          nativeButton={false}
          render={
            <a
              aria-label={t`Open Stephen in ${app}, in a new tab`}
              href={reach.href}
              rel="noopener noreferrer"
              target="_blank"
            />
          }
          size="sm"
          variant="outline"
        >
          <Trans>Open</Trans>
        </Button>
      )}
    </li>
  );
};

/** Each chat app the person reaches Stephen in, or nothing if there is none. */
export const WhereStephen = ({ reach }: { reach: ChannelReach[] }) => {
  if (reach.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col">
      <h3 className="px-5 pb-1 font-medium">
        <Trans>Where to reach Stephen</Trans>
      </h3>
      <ul>
        {reach.map((one) => (
          <ReachRow key={one.platform} reach={one} />
        ))}
      </ul>
    </div>
  );
};
