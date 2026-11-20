import type { Identity } from "@grasp-os/shared/rpc";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import {
  AppsState,
  needsYou,
} from "../grasp/blocks/app-integration/app-integration.tsx";
import { Heading } from "../grasp/heading/index.ts";
import { PanelTexture } from "../grasp/panel/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useAppOf } from "./app-of.tsx";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";

// The Integrations overview's slim band (Ruben's direction B, RUB-68), as
// the library's pattern draws it (Grasp UI, app-integrations-recommended):
// what Grasp reaches in one line on the dither, and at its end the
// library's AppsState, which sums up the connected apps: how many need
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
    gap: grasp.space4,
    paddingBlock: grasp.space5,
    paddingInline: { default: grasp.space6, [media.belowPhone]: grasp.space4 },
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
    backgroundColor: grasp.raised,
  },
  texture: { zIndex: -1 },
  words: { display: "grid", gap: grasp.space1, minWidth: 0 },
  state: {
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
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
    <section aria-labelledby={id} {...stylex.props(styles.band)}>
      <PanelTexture layout={styles.texture} />
      <div {...stylex.props(styles.words)}>
        <Heading id={id} level={2} size="sm">
          {t`Connect the apps your work runs on`}
        </Heading>
        <Text size="sm" tone="muted">
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
                    appsNeedYou: (waits) =>
                      t`${plural(waits, { one: "# app waits for an admin", other: "# apps wait for an admin" })}`,
                  }
                : undefined
            }
          />
        </span>
      )}
    </section>
  );
};
