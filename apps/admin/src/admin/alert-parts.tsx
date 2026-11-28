/**
 * The alerts on Platform's Maintenance page: each channel switched on or
 * off, whether it's set up, and a test alert to see it works
 * (src/alerts/channels.ts). A channel switched on that isn't set up says
 * so: nothing is sent there until it is.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import type { AlertChannel } from "../alerts/alert-channels.ts";
import type { AlertChannelState, TestOutcome } from "../alerts/channels.ts";
import { sendTestAlertFn, switchAlertChannelFn } from "../alerts/functions.ts";
import { PagePart } from "./page-part.tsx";
import { addSecretStep } from "./words.ts";

const styles = stylex.create({
  channels: { display: "flex", flexDirection: "column", gap: space["6"] },
  channel: { display: "flex", flexDirection: "column", gap: space["2"] },
  test: { alignSelf: "flex-start" },
});

/** Each channel's name. */
const channelNames: Record<AlertChannel, string> = {
  mail: "Mail",
  discord: "Discord",
};

/** What staff do to set channel `channel` up. */
const setupStep: Record<AlertChannel, string> = {
  mail: "Onboard the sending domain in Cloudflare’s Email Sending, add ALERTS_MAIL_FROM and ALERTS_MAIL_TO to the stage’s 1Password Environment, then run Deploy platform.",
  discord: addSecretStep("DISCORD_ALERTS_WEBHOOK"),
};

/** Where channel `state` stands, in a sentence. */
const standingOf = (state: AlertChannelState): string => {
  if (state.ready) {
    const where =
      state.channel === "mail"
        ? `to ${state.mailbox ?? "its one mailbox"}`
        : "to the channel its webhook names";
    return state.on
      ? `Sends ${where}.`
      : `Set up to send ${where}, but off: nothing is sent.`;
  }
  return state.on
    ? `On, but not set up: nothing is sent. ${setupStep[state.channel]}`
    : `Not set up. ${setupStep[state.channel]}`;
};

/** What a test alert came to, in a sentence: `failed` when it couldn't be asked. */
const testWords = (outcome: TestOutcome): string => {
  if (outcome === "sent") {
    return "Sent. Check that it arrived.";
  }
  if (outcome === "not_ready") {
    return "Not set up, so nothing was sent.";
  }
  if (outcome === "failed") {
    return "That didn’t work. Try again.";
  }
  return `The channel refused it (${outcome}).`;
};

/** One channel: its switch, where it stands, and its test alert. */
const ChannelRow = ({ state }: { state: AlertChannelState }) => {
  const router = useRouter();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TestOutcome | null>(null);
  const name = channelNames[state.channel];
  const test = async () => {
    setTesting(true);
    try {
      setTested(await sendTestAlertFn({ data: { channel: state.channel } }));
    } catch {
      setTested("failed");
    }
    setTesting(false);
  };
  return (
    <div {...stylex.props(styles.channel)}>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>{name}</FieldLabel>
          <FieldDescription>{standingOf(state)}</FieldDescription>
        </FieldContent>
        <Switch
          defaultChecked={state.on}
          errorText="That didn’t work. Try again."
          onSave={async (on) => {
            await switchAlertChannelFn({
              data: { channel: state.channel, on },
            });
            await router.invalidate({ sync: true });
          }}
        />
      </Field>
      <Button
        disabled={testing}
        onClick={() => {
          void test();
        }}
        size="sm"
        style={styles.test}
        variant="outline"
      >
        {`Send a test to ${name}`}
      </Button>
      {tested === null ? null : <Text size="sm">{testWords(tested)}</Text>}
    </div>
  );
};

/** The alert channels, each switched and tested here. */
export const AlertChannels = ({
  channels,
}: {
  channels: readonly AlertChannelState[];
}) => (
  <PagePart
    description="Where the admin tells staff that a release didn’t import or an organization’s deploy failed, and that it recovered: once each time. Nothing goes to a channel that’s off."
    id="alerts"
    title="Alerts"
  >
    <div {...stylex.props(styles.channels)}>
      {channels.map((state) => (
        <ChannelRow key={state.channel} state={state} />
      ))}
    </div>
  </PagePart>
);
