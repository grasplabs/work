import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { canReconnect } from "./connect-dialog.tsx";
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

/**
 * What this person can do about an app whose connection ran out, as core
 * decides it: sign in again (their own, or a shared Microsoft or Google
 * one for an admin); for an admin, disconnect a shared one that can't be
 * signed in to again (a Composio toolkit) and connect it anew, from its
 * Sheet; or nothing, when only an admin can.
 */
export type Fix = "sign-in" | "reconnect" | "none";

export const fixOf = (
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): Fix => {
  const lapsed = integration.connections.find(
    ({ status }) => status === "needs_reauth"
  );
  if (lapsed === undefined) {
    return "none";
  }
  if (canReconnect(lapsed, integration.offered, identity)) {
    return "sign-in";
  }
  return isAdmin(identity.role) && !identity.staff ? "reconnect" : "none";
};

/** The card's one line under its title: what needs someone, and who. */
const Line = ({
  count,
  first,
  others,
  fix,
}: {
  count: number;
  first: Integration | undefined;
  others: number;
  fix: Fix;
}): string => {
  const { t } = useLingui();
  if (first === undefined) {
    return count === 0
      ? t`Pick an app below to connect it. Grasp reaches only what you connect.`
      : t`Everything connected works.`;
  }
  const app = first.name;
  if (others > 0) {
    return t`${plural(others, { one: `${app} and # other app need someone to sign in again.`, other: `${app} and # other apps need someone to sign in again.` })}`;
  }
  if (fix === "sign-in") {
    return t`${app} needs someone to sign in again. Until then, what uses it waits.`;
  }
  if (fix === "reconnect") {
    return t`${app} stopped working. Disconnect it and connect it again; until then, what uses it waits.`;
  }
  return t`An admin needs to connect ${app} again. Until then, what uses it waits.`;
};

/** The header card, over every app's tile. */
export const IntegrationsHeader = ({
  integrations,
  identity,
}: {
  integrations: readonly Integration[];
  identity: Pick<Identity, "role" | "staff">;
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
  const lapsedApp = first?.name ?? "";
  const others = lapsed.length - 1;
  const fix = first === undefined ? "none" : fixOf(first, identity);
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
          <Text tone="muted">
            <Line count={count} first={first} fix={fix} others={others} />
          </Text>
          {first === undefined || fix === "none" ? null : (
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
              {fix === "sign-in" ? t`Sign in again` : t`Open ${lapsedApp}`}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};
