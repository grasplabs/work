import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { IntegrationsNerves, LINES } from "./integrations-nerves.tsx";
import type { Integration } from "./integrations.ts";
import { reliedOnLapsed } from "./integrations.ts";

// The Integrations page's header card: what Grasp reaches, said once, and
// drawn as a brain in dots with a nerve into it for every connected app
// (integrations-nerves.tsx). A nerve whose app needs someone to sign in
// again glows, and the card names that app with the one action it needs;
// a click on any nerve opens its app over the page.

/** From this width the drawing stands beside the words; narrower, above them. */
const roomy = "@media (min-width: 64rem)";

const styles = stylex.create({
  // The words on the near side, the drawing filling the rest; on a narrow
  // screen the drawing first, then the words under it.
  field: {
    position: "relative",
    minHeight: { default: null, [roomy]: "11rem" },
    display: "flex",
    flexDirection: { default: "column", [roomy]: "row" },
    alignItems: { default: "stretch", [roomy]: "center" },
    gap: { default: grasp.space4, [roomy]: 0 },
  },
  drawing: {
    position: { default: "relative", [roomy]: "absolute" },
    height: { default: "8rem", [roomy]: "auto" },
    insetBlock: { default: null, [roomy]: 0 },
    insetInlineEnd: { default: null, [roomy]: 0 },
    insetInlineStart: { default: null, [roomy]: "40%" },
  },
  words: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space3,
    maxWidth: "24rem",
  },
});

/** The header card, over every app's tile. */
export const IntegrationsHeader = ({
  integrations,
}: {
  integrations: readonly Integration[];
}) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const connected = integrations.filter(
    (integration) => integration.connections.length > 0
  );
  const lapsed = connected.filter((integration) => reliedOnLapsed(integration));
  // To sign in to again first: their nerves are the ones to act on.
  const drawn = [
    ...lapsed,
    ...connected.filter((integration) => !lapsed.includes(integration)),
  ];
  const lines = drawn.slice(0, LINES).map((integration) => ({
    id: integration.key,
    attention: lapsed.includes(integration),
  }));
  const count = connected.length;
  const [first] = lapsed;
  const others = lapsed.length - 1;
  let line: string;
  if (first === undefined) {
    line =
      count === 0
        ? t`Pick an app below to connect it. Grasp reaches only what you connect.`
        : t`Everything connected works.`;
  } else if (others === 0) {
    const app = first.name;
    line = t`${app} needs someone to sign in again. Until then, what uses it waits.`;
  } else {
    const app = first.name;
    line = t`${plural(others, { one: `${app} and # other app need someone to sign in again.`, other: `${app} and # other apps need someone to sign in again.` })}`;
  }
  return (
    <Card padding="lg">
      <div {...stylex.props(styles.field)}>
        <div {...stylex.props(styles.drawing)}>
          <IntegrationsNerves
            lines={lines}
            onHold={() => {
              // The card names what needs someone: nothing to show over the drawing.
            }}
            onOpen={(id) => {
              void navigate({
                resetScroll: false,
                search: (last) => ({ ...last, app: id }),
              });
            }}
          />
        </div>
        <div {...stylex.props(styles.words)}>
          <Heading level={2} size="md">
            {count === 0
              ? t`Connect the apps your work runs on`
              : t`${plural(count, { one: "Grasp reaches # app", other: "Grasp reaches # apps" })}`}
          </Heading>
          <Text tone="muted">{line}</Text>
          {first === undefined ? null : (
            <Button
              render={
                <Link
                  from="/integrations/"
                  resetScroll={false}
                  search={(last) => ({ ...last, app: first.key })}
                  to="."
                />
              }
              size="sm"
              variant="ink"
            >
              {t`Sign in again`}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};
