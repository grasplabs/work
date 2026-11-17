import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { useGlobalChat } from "../chat/global-chat.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "../grasp/empty/index.ts";
import { People, Spinner } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ItemBar } from "./item-shell.tsx";
import type { Crumb } from "./site-header.tsx";

// Something new Build it made (an App, a workflow), while Grasp's agent
// builds its first version beside it in the chat: one calm state in place
// of the App's preview or the workflow's Flow, which never shows what is
// half made, broken or empty meanwhile, and a bar with its name alone.
// What is set up comes in once its first version works, as each page
// tells from real signals (the App's preview running, the workflow's
// draft passing) with Grasp's turn over. Only a turn that ended without
// one says so, with Try again, which asks the chat.

const styles = stylex.create({
  // In place of the preview or the Flow, on the page's soft ground.
  place: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: grasp.space6,
    backgroundColor: grasp.soft,
  },
});

/** Where something new stands: ready, being set up, or not set up once Grasp's turn ended without a version that works. */
export type SetUp = "ready" | "setting-up" | "failed";

/**
 * Share, off while Grasp sets it up, with why beside it on every width, as
 * a disabled button's reason stands (Grasp UI's tooltip never opens on a
 * button that is off). Still reached by the keys, so its reason is read.
 */
const ShareOnceReady = () => {
  const { t } = useLingui();
  const why = useId();
  return (
    <>
      <Text element="span" id={why} size="xs" tone="muted">
        {t`Share once it's ready`}
      </Text>
      <Button
        aria-describedby={why}
        disabled
        focusableWhenDisabled
        icon={People}
        size="sm"
        variant="ink"
      >
        {t`Share with your team`}
      </Button>
    </>
  );
};

/** The bar while Grasp sets it up: the way back, its name, "Setting up", and Share off. */
export const SettingUpBar = ({ back, name }: { back: Crumb; name: string }) => {
  const { t } = useLingui();
  return (
    <ItemBar
      actions={<ShareOnceReady />}
      back={back}
      name={name}
      state={<Badge>{t`Setting up`}</Badge>}
    />
  );
};

/**
 * In place of what is set up: "Setting up {name}…" while Grasp builds it,
 * or, once its turn ended without a version that works (`failed`), that
 * it isn't ready yet, with Try again, asked in the chat.
 */
export const SettingUp = ({
  name,
  failed,
}: {
  name: string;
  failed: boolean;
}) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  return (
    <div {...stylex.props(styles.place)}>
      {failed ? (
        <Empty tone="danger">
          <EmptyHeader>
            <EmptyMedia />
            <EmptyTitle>{t`${name} isn't ready yet`}</EmptyTitle>
            <EmptyDescription>{t`Grasp couldn't finish setting it up this time.`}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                void chat.ask(t`Try again to set up ${name}.`);
              }}
            >
              {t`Try again`}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia icon={Spinner} />
            <EmptyTitle>{t`Setting up ${name}…`}</EmptyTitle>
            <EmptyDescription>{t`Grasp is building it. This takes a minute or two.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
};

/**
 * Over a preview that broke while Grasp's turn still runs: a write on the
 * way, never the error itself, which the next write's start tries again.
 */
export const Updating = ({ name }: { name: string }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.place)}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Spinner} />
          <EmptyTitle>{t`Updating ${name}…`}</EmptyTitle>
          <EmptyDescription>{t`Grasp is still working on it.`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
};
