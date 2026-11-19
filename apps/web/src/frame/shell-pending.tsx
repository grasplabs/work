import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute } from "@tanstack/react-router";

import { readFolded } from "../fold.ts";
import { AppShell } from "../grasp/app-shell/index.ts";
import { Composer, ComposerAdd } from "../grasp/composer/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import {
  AgentPerson,
  AppPanels,
  Bell,
  Brain,
  BrandGrasp,
  Cable,
  Conversation,
  Cycle,
  Home,
  Icon,
  Projects,
} from "../grasp/icons/index.ts";
import { Sidebar } from "../grasp/sidebar/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { PageLoading } from "./page-states.tsx";
import { wasSignedIn } from "./signed-in-here.ts";

const styles = stylex.create({
  // As the frame's (app-frame.tsx): the window's height, which App shell fills.
  shell: {
    height: "100svh",
  },
  // As the product sidebar's mark (grasp/frame/grasp-sidebar.tsx).
  mark: { [iconVars.size]: grasp.shellMark },
});

/** Does nothing: what the frame's controls do waits for the frame itself. */
const wait = (): void => undefined;

/**
 * The frame while core says who is signed in, as a reload paints it: the
 * sidebar with the product's sections, the card with the page's skeleton,
 * and the chat's bar, in the places the frame puts them, so nothing moves
 * when the frame itself takes over. It shows nothing of the person: no
 * name, chat, App or count, which only come once core has said who is in
 * (signed-in-here.ts). Where the sidebar becomes a section of its own
 * (Settings, an agent, the Brain, an App) it waits empty instead of
 * showing sections it is about to replace. Nothing at all for a browser
 * where nobody was signed in, whom core sends to sign in.
 */
export const ShellPending = () => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  if (!wasSignedIn()) {
    return null;
  }
  const at = (to: string, fuzzy = true) => matchRoute({ to, fuzzy }) !== false;
  const sectioned =
    at("/settings") || at("/brain") || at("/apps/$app") || at("/agents/$agent");
  // Chat's start and a chat's own page have no bar (app-frame.tsx).
  const chatPage = at("/", false) || at("/chats/$chatId");
  const ask = t`Ask Grasp`;
  return (
    <div {...stylex.props(styles.shell)}>
      <AppShell
        bar={at("/", false) ? "none" : "page"}
        dock={
          chatPage ? undefined : (
            <Composer
              activity="disabled"
              compact
              aria-label={ask}
              // The real bar's add and dictate, still, so its foot keeps
              // its shape as it takes over (chat/chat-composer.tsx).
              onDictate={wait}
              onSend={wait}
              placeholder={ask}
              start={<ComposerAdd onAttach={wait} />}
            />
          )
        }
        words={{ closeMenu: t`Close the menu`, menu: t`Menu` }}
        page={chatPage ? "whole" : "padded"}
        sidebar={
          <Sidebar
            aria-label={t`Sidebar`}
            words={{
              fold: t`Show or hide the sidebar`,
              main: t`Main`,
              search: t`Search chats`,
              views: t`Views`,
            }}
            groups={
              sectioned
                ? []
                : [
                    {
                      rows: [
                        {
                          label: t`Chat`,
                          icon: Conversation,
                          render: <Link to="/" />,
                          current: at("/", false),
                        },
                        {
                          label: t`Brain`,
                          icon: Brain,
                          render: <Link to="/brain" />,
                          current: at("/brain"),
                        },
                        {
                          label: t`Projects`,
                          icon: Projects,
                          render: <Link to="/projects" />,
                          current: at("/projects"),
                        },
                        {
                          label: t`Apps`,
                          icon: AppPanels,
                          render: <Link to="/apps" />,
                          current: at("/apps"),
                        },
                        {
                          label: t`Workflows`,
                          icon: Cycle,
                          render: <Link to="/workflows" />,
                          current: at("/workflows"),
                        },
                        {
                          label: t`Agents`,
                          icon: AgentPerson,
                          render: <Link to="/agents" />,
                          current: at("/agents"),
                        },
                        {
                          label: t`Integrations`,
                          icon: Cable,
                          render: <Link to="/integrations" />,
                          current: at("/integrations"),
                        },
                      ],
                    },
                  ]
            }
            guides={false}
            head={
              <span {...stylex.props(styles.mark)}>
                <Icon icon={BrandGrasp} />
              </span>
            }
            onSearch={wait}
            onTabChange={wait}
            open={readFolded("sidebar") !== true}
            tab="home"
            tabs={[
              { value: "home", label: t`Home`, icon: Home },
              { value: "inbox", label: t`Inbox`, icon: Bell },
            ]}
          />
        }
      >
        {chatPage ? null : <PageLoading />}
      </AppShell>
    </div>
  );
};
