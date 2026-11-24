import type { Identity } from "@grasp-os/shared/rpc";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { useAppOf } from "./app-of.tsx";
import { AppsState } from "./app/parts.tsx";
import { needsYou } from "./app/state.ts";
import { Texture } from "./app/texture.tsx";
import { useAppIntegrationWords } from "./app/words.ts";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";

// The Integrations overview's slim band (Ruben's direction B, RUB-68), as
// #2503's library pattern drew it (app-integrations-recommended): what
// Grasp reaches in one line on the dither, and at its end the app parts'
// AppsState, which sums up the connected apps: how many need
// someone, in amber, else how many are connected; to someone who can fix
// none of them, that they wait for an admin. Which app it is, and its fix,
// is on its own tile.

const styles = stylex.create({
  band: {
    position: "relative",
    isolation: "isolate",
    overflow: "clip",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["4"],
    paddingBlock: space["5"],
    paddingInline: { default: space["6"], [media.maxSm]: space["4"] },
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.border}`,
    backgroundColor: colors.card,
  },
  texture: { zIndex: -1 },
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
  const words = useAppIntegrationWords();
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
    <section aria-labelledby={id} {...stylex.props(styles.band)}>
      <Texture style={styles.texture} />
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
            words={
              onlyAnAdmin
                ? {
                    ...words,
                    appsNeedYou: (waits: number) =>
                      t`${plural(waits, { one: "# app waits for an admin", other: "# apps wait for an admin" })}`,
                  }
                : words
            }
          />
        </span>
      )}
    </section>
  );
};
