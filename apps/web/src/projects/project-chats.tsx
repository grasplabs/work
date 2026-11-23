import type { ChatSummary } from "@grasp-os/shared/chat";
import type { Project } from "@grasp-os/shared/projects";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import {
  Icon,
  MessageCircleIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink, useRouter } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A project's chats: the person's own that they put in it, and nobody
// else's (core's `chats.setProject`, kept in their own Workspace). They
// add one of their chats, or take one out; the chat itself stays theirs,
// in their own list, either way. A chat opens as every link to one does
// (`/?chat=`), in the chat screen, which this leaves as it is.

const styles = stylex.create({
  // The search over the list, the list under it.
  picker: { display: "grid", gap: space["2"] },
  // The list scrolls inside, so the dialog keeps its size with many chats.
  list: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "18rem",
  },
});

/** Whether `chat` is what `query` names. */
const matches = (chat: ChatSummary, query: string): boolean => {
  const words = query.trim().toLocaleLowerCase();
  return words === "" || chat.title.toLocaleLowerCase().includes(words);
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
    const done = await adding.run(async (session) => {
      await session.chats.setProject(chatId, project.id);
      return true;
    });
    if (done === true) {
      setOpen(false);
      await router.invalidate({ sync: true });
    }
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
        <Trans>Add a chat</Trans>
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Add a chat</Trans>
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {offered !== undefined && offered.length === 0 ? (
              <Empty size="sm">
                <EmptyHeader>
                  <EmptyDescription>
                    <Trans>You have no chats to add.</Trans>
                  </EmptyDescription>
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
                  <InputGroupClear aria-label={t`Clear the search`} />
                </InputGroup>
                {/* Its height on a box of the page's own: the area fills it. */}
                <div {...stylex.props(styles.list)}>
                  <ScrollArea>
                    {offered !== undefined && found.length === 0 ? (
                      <Empty size="sm">
                        <EmptyHeader>
                          <EmptyDescription>
                            <Trans>No chat by that name.</Trans>
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <ItemGroup aria-label={t`Your chats`}>
                        {found.map((chat, index) => (
                          <Fragment key={chat.id}>
                            {index === 0 ? null : <ItemSeparator />}
                            <Item size="sm">
                              <ItemMedia>
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
                                  variant="secondary"
                                >
                                  <Icon icon={PlusIcon} />
                                  <Trans context="put in a project">Add</Trans>
                                </Button>
                              </ItemActions>
                            </Item>
                          </Fragment>
                        ))}
                      </ItemGroup>
                    )}
                  </ScrollArea>
                </div>
              </div>
            )}
            <ErrorText>{listing.failure ?? adding.failure}</ErrorText>
          </DialogBody>
          <DialogFooter>
            <DialogClose>
              <Trans>Close</Trans>
            </DialogClose>
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
    const done = await run(async (session) => {
      await session.chats.setProject(chatId, null);
      return true;
    });
    if (done === true) {
      await router.invalidate({ sync: true });
    }
  };
  return (
    <>
      <ItemGroup aria-label={t`Your chats`}>
        {chats.map((chat, index) => {
          const { title } = chat;
          return (
            <Fragment key={chat.id}>
              {index === 0 ? null : <ItemSeparator />}
              <Item size="sm">
                <ItemMedia>
                  <Icon icon={MessageCircleIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    <Link asChild>
                      <RouterLink search={{ chat: chat.id }} to="/">
                        {title}
                      </RouterLink>
                    </Link>
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={t`Take ${title} out of the project`}
                    disabled={busy}
                    onClick={() => {
                      void takeOut(chat.id);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <Icon icon={MinusIcon} />
                    <Trans>Take out</Trans>
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          );
        })}
      </ItemGroup>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};
