import type { Identity } from "@grasp-os/shared/rpc";
import { Card } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { useAppOf } from "./app-of.tsx";
import { AppsState } from "./app/parts.tsx";
import { needsYou } from "./app/state.ts";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";

// The Integrations overview's slim band (Ruben's direction B, RUB-68): what
// Grasp reaches in one line on a card washed in the mint, and at its end the app parts'
// AppsState (app/parts.tsx), which sums up the connected apps: how many need
// someone, in amber, else how many are connected; to someone who can fix
// none of them, that they wait for an admin. Which app it is, and its fix,
// is on its own tile.

const styles = stylex.create({
  band: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["4"],
    paddingBlock: space["5"],
    paddingInline: { default: space["6"], [media.maxSm]: space["4"] },
    borderRadius: radius.base,
    cornerShape: radius.shape,
    // The product's own wash of the mint from the top corner, where the
    // reference drew the dither (Damsko keeps it inside its page header).
    backgroundImage: `linear-gradient(170deg, color-mix(in srgb, ${colors.mint} 22%, transparent), transparent 40%)`,
  },
  words: { display: "grid", gap: space["1"], minWidth: 0 },
  state: {
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
});

/** The band over the overview's runs. */
export const IntegrationsBand = ({
  integrations,
  identity,
}: {
  integrations: readonly Integration[];
  identity: Pick<Identity, "role" | "staff" | "userId">;
}) => {
  const { t } = useLingui();
  const appOf = useAppOf(identity);
  const id = useId();
  const connected = integrations.filter(
    (integration) => integration.connections.length > 0
  );
  const count = connected.length;
  const apps = connected.map((integration) => ({
    integration,
    app: appOf(integration, { size: "sm" }),
  }));
  const waiting = apps.filter(({ app }) => needsYou(app));
  const onlyAnAdmin =
    waiting.length > 0 &&
    waiting.every(({ integration }) => fixOf(integration, identity) === "none");
  return (
    <Card aria-labelledby={id} asChild padding="none">
      <section>
        <div {...stylex.props(styles.band)}>
          <div {...stylex.props(styles.words)}>
            <Heading id={id} level={2} size="sm">
              {t`Connect the apps your work runs on`}
            </Heading>
            <Text color="muted" size="sm">
              {t`Grasp reaches only what you connect.`}
            </Text>
          </div>
          {count === 0 ? null : (
            <span {...stylex.props(styles.state)}>
              <AppsState
                apps={apps.map(({ app }) => app)}
                {...(onlyAnAdmin
                  ? {
                      waiting: (waits: number) =>
                        t`${plural(waits, { one: "# app waits for an admin", other: "# apps wait for an admin" })}`,
                    }
                  : {})}
              />
            </span>
          )}
        </div>
      </section>
    </Card>
  );
};
