import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { AppsState } from "../grasp/blocks/app-integration/app-integration.tsx";
import { Heading } from "../grasp/heading/index.ts";
import { PanelTexture } from "../grasp/panel/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useAppOf } from "./app-of.tsx";
import type { Integration } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";

// The Integrations overview's slim band (Ruben's direction B, RUB-68), as
// the library's pattern draws it (Grasp UI, app-integrations-recommended):
// what Grasp reaches in one line on the dither, and the connected apps'
// marks stacked at its end, and one line that sums them up (the library's
// AppsState): how many need someone, in amber, else how many are
// connected. Which app it is, and its fix, is on its own tile.

/** Most connected apps' marks in the stack; the count says the rest. */
const marksShown = 4;

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
  stack: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  marks: { display: "flex" },
  mark: {
    display: "inline-flex",
    padding: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: `0 0 0 ${grasp.hairline} ${grasp.line}`,
    marginInlineStart: {
      default: `calc(-1 * ${grasp.space2})`,
      ":first-child": 0,
    },
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
        <span {...stylex.props(styles.stack)}>
          <span aria-hidden="true" {...stylex.props(styles.marks)}>
            {connected.slice(0, marksShown).map((integration) => (
              <span key={integration.key} {...stylex.props(styles.mark)}>
                <ProviderMark
                  id={integration.id}
                  logo={integration.logo}
                  name={integration.name}
                />
              </span>
            ))}
          </span>
          <AppsState
            apps={connected.map((integration) =>
              appOf(integration, { size: "sm" })
            )}
          />
        </span>
      )}
    </section>
  );
};
