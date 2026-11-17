import type { ChatSummary } from "@grasp-os/shared/chat";
import type { Project } from "@grasp-os/shared/projects";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Chat, Plus } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";

// A project's chats: the person's own that they put in it, and nobody
// else's (core's `chats.setProject`, kept in their own Workspace). They
// add one of their chats, or take one out; the chat itself stays theirs,
// in their own list, either way.

const styles = stylex.create({
  tab: {
    display: "grid",
    gap: grasp.space3,
  },
  bar: {
    display: "flex",
    justifyContent: "flex-end",
  },
});

/** A chat's row: its link, and taking it out of the project. */
const ChatRow = ({
  chat,
  onTakeOut,
  busy,
}: {
  chat: ChatSummary;
  onTakeOut?: () => void;
  busy: boolean;
}) => {
  const { t } = useLingui();
  return (
    <Item size="sm">
      <ItemMedia icon={Chat} iconLook="inline" />
      <ItemContent>
        <ItemTitle>
          <RouterLink params={{ chatId: chat.id }} to="/chats/$chatId">
            {chat.title}
          </RouterLink>
        </ItemTitle>
      </ItemContent>
      {onTakeOut === undefined ? null : (
        <ItemActions>
          <Button disabled={busy} onClick={onTakeOut} size="sm" variant="ghost">
            {t`Take out`}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
};

/** Adding one of the person's chats that isn't in the project yet. */
const AddChat = ({
  project,
  filed,
}: {
  project: Project;
  filed: readonly ChatSummary[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<ChatSummary[]>();
  const listing = useCoreAction();
  const adding = useCoreAction();
  const inIt = new Set(filed.map(({ id }) => id));
  const readMine = async (): Promise<void> => {
    const listed = await listing.run(
      async (session) => await session.chats.list()
    );
    setMine(listed ?? []);
  };
  const add = async (chatId: string): Promise<void> => {
    await adding.run(async (session) => {
      await session.chats.setProject(chatId, project.id);
    });
    setOpen(false);
    await router.invalidate();
  };
  const offered = mine?.filter(({ id }) => !inIt.has(id));
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          // What to offer is read for each opening.
          setMine(undefined);
          setOpen(true);
          void readMine();
        }}
        variant="quiet"
      >
        {t`Add a chat`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add a chat`}</DialogTitle>
          <DialogBody>
            {offered !== undefined && offered.length === 0 ? (
              <Empty size="inline">{t`You have no chats to add.`}</Empty>
            ) : (
              <ItemGroup aria-label={t`Your chats`} separated>
                {(offered ?? []).map((chat) => (
                  <Item key={chat.id} size="sm">
                    <ItemMedia icon={Chat} iconLook="inline" />
                    <ItemContent>
                      <ItemTitle>{chat.title}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        disabled={adding.busy}
                        onClick={() => {
                          void add(chat.id);
                        }}
                        size="sm"
                        variant="quiet"
                      >
                        {t({ message: "Add", context: "put in a project" })}
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
            <ErrorText>{listing.failure ?? adding.failure}</ErrorText>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Close`}</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** The project's Chats tab: the person's own chats in it. */
export const ProjectChats = ({
  project,
  chats,
}: {
  project: Project;
  chats: readonly ChatSummary[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const takeOut = async (chatId: string): Promise<void> => {
    await run(async (session) => {
      await session.chats.setProject(chatId, null);
    });
    await router.invalidate();
  };
  return (
    <div {...stylex.props(styles.tab)}>
      <div {...stylex.props(styles.bar)}>
        <AddChat filed={chats} project={project} />
      </div>
      {chats.length === 0 ? (
        <Empty size="inline">
          {t`None of your chats are in it. Only you see the chats you put here.`}
        </Empty>
      ) : (
        <ItemGroup aria-label={t`Your chats`} separated>
          {chats.map((chat) => (
            <ChatRow
              busy={busy}
              chat={chat}
              key={chat.id}
              onTakeOut={() => {
                void takeOut(chat.id);
              }}
            />
          ))}
        </ItemGroup>
      )}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
