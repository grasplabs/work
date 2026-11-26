import type { ChatSummary } from "@grasp-os/shared/chat";
import type { Project } from "@grasp-os/shared/projects";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyHeader,
  EmptyDescription,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import {
  Icon,
  MessageCircleIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A project's chats: the person's own that they put in it, and nobody
// else's (core's `chats.setProject`, kept in their own Workspace). They
// add one of their chats, or take one out; the chat itself stays theirs,
// in their own list, either way.

const styles = stylex.create({
  // The search over the list, the list under it.
  picker: { display: "grid", gap: space["2"] },
  // The list scrolls inside, so the dialog keeps its size with many chats.
  list: { height: "18rem" },
});

/** Whether `chat` is what `query` names. */
const matches = (chat: ChatSummary, query: string): boolean => {
  const words = query.trim().toLocaleLowerCase();
  return words === "" || chat.title.toLocaleLowerCase().includes(words);
};

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
      <ItemMedia variant="default">
        <Icon icon={MessageCircleIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <TextLink asChild>
            <Link params={{ chatId: chat.id }} to="/chats/$chatId">
              {chat.title}
            </Link>
          </TextLink>
        </ItemTitle>
      </ItemContent>
      {onTakeOut === undefined ? null : (
        <ItemActions>
          <Button disabled={busy} onClick={onTakeOut} size="sm" variant="ghost">
            <Icon icon={MinusIcon} />
            {t`Take out`}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
};

/** Adding one of the person's chats that isn't in the project yet. */
export const AddChat = ({
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
  const [query, setQuery] = useState("");
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
    const added = await adding.run(async (session) => {
      await session.chats.setProject(chatId, project.id);
      return true;
    });
    if (added !== true) {
      // The dialog stays open, with core's reason in it.
      return;
    }
    setOpen(false);
    await router.invalidate({ sync: true });
  };
  const offered = mine?.filter(({ id }) => !inIt.has(id));
  const found = (offered ?? []).filter((chat) => matches(chat, query));
  return (
    <>
      <Button
        onClick={() => {
          // What to offer is read for each opening.
          setMine(undefined);
          setQuery("");
          setOpen(true);
          void readMine();
        }}
        variant="outline"
      >
        <Icon icon={PlusIcon} />
        {t`Add a chat`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Add a chat`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {offered !== undefined && offered.length === 0 ? (
              <Empty size="sm">
                <EmptyHeader>
                  <EmptyDescription>{t`You have no chats to add.`}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div {...stylex.props(styles.picker)}>
                <InputGroup>
                  <InputGroupAddon>
                    <Icon icon={SearchIcon} />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label={t`Find a chat`}
                    onValueChange={setQuery}
                    placeholder={t`Find a chat`}
                    type="search"
                    value={query}
                  />
                </InputGroup>
                <ScrollArea aria-label={t`Your chats`} style={styles.list}>
                  {offered !== undefined && found.length === 0 ? (
                    <Empty size="sm">
                      <EmptyHeader>
                        <EmptyDescription>{t`No chat by that name.`}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <ItemGroup separated aria-label={t`Your chats`}>
                      {found.map((chat) => (
                        <Item key={chat.id} size="sm">
                          <ItemMedia variant="default">
                            <Icon icon={MessageCircleIcon} />
                          </ItemMedia>
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
                              variant="outline"
                            >
                              <Icon icon={PlusIcon} />
                              {t({
                                message: "Add",
                                context: "put in a project",
                              })}
                            </Button>
                          </ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  )}
                </ScrollArea>
              </div>
            )}
            <ErrorText>{listing.failure ?? adding.failure}</ErrorText>
          </DialogBody>
          <DialogFooter>
            <DialogClose>{t`Close`}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** The person's own chats in the project, each with Take out. */
export const ProjectChatList = ({
  chats,
}: {
  chats: readonly ChatSummary[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const takeOut = async (chatId: string): Promise<void> => {
    await run(async (session) => {
      await session.chats.setProject(chatId, null);
    });
    await router.invalidate({ sync: true });
  };
  return (
    <>
      <ItemGroup separated aria-label={t`Your chats`}>
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
      <ErrorText>{failure}</ErrorText>
    </>
  );
};
