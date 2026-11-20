// Connect app: connecting an app (app-integration's panel and page open it from their Connect), in a
// dialog of the same family as the panel, growing from the Connect button that opened it:
//
//   head      the dither in the app's own colour, its mark, "Connect HubSpot" and its description
//   What Grasp may do   one summary line ("Read everything, ask before changes"); Change opens the
//             same group rows as the app's page, inline
//   Who uses it         one Select
//   Consent   the provider's text as written, word for word (the host records it), small, quiet and
//             scrolling, the provider named in the section's label
//
// The foot is pinned: Cancel, Connect.
//
//   <ConnectApp app={hubspot} provider="Composio" consent={consentText} onConnect={connect} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { Button } from "../../button";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../../dialog";
import { PanelSection } from "../../panel-section";
import { ScrollArea } from "../../scroll-area";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../select";
import { Texture } from "../../texture/texture";
import { grasp } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type {
  App,
  AppConnection,
  AppTool,
  AppToolChoice,
} from "../app-integration/model";
import { GroupRows } from "../app-integration/page";
import { AppMark, useAppTint } from "../app-integration/parts";
import { appIntegrationWords } from "../app-integration/words";
import type { AppIntegrationWords } from "../app-integration/words";

/** Every word the dialog shows or says, beside the app's own (app-integration/words.ts). */
export interface ConnectAppWords {
  title: (app: string) => string;
  titleAgain: (app: string) => string;
  /** What Grasp may do, in one line, as the tools stand. */
  summaryAll: string;
  summaryRead: string;
  summaryNone: string;
  summaryMixed: string;
  change: string;
  done: string;
  whoUses: string;
  forEveryone: string;
  forYou: string;
  /** The consent's section, naming who keeps the access. */
  consentFrom: (provider: string) => string;
  cancel: string;
  connect: string;
}

export const connectAppWords: ConnectAppWords = {
  title: (app) => `Connect ${app}`,
  titleAgain: (app) => `Connect ${app} again`,
  summaryAll: "Read everything, ask before changes",
  summaryRead: "Read everything, change nothing",
  summaryNone: "Nothing yet",
  summaryMixed: "Set group by group",
  change: "Change",
  done: "Done",
  whoUses: "Who uses it",
  forEveryone: "Everyone in the organization",
  forYou: "Just you",
  consentFrom: (provider) => `Consent · ${provider}`,
  cancel: "Cancel",
  connect: "Connect",
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    connectApp: ConnectAppWords;
  }
}

/** What `onConnect` is handed: what Grasp may do with each tool, and who uses it. */
export interface ConnectAppChoice {
  tools: readonly { id: string; choice: AppToolChoice }[];
  forWhom: AppConnection["forWhom"];
}

/** Every prop a ConnectApp takes. */
export interface ConnectAppProps {
  app: App;
  /** Who keeps the access ("Composio", or Grasp's own connector): named over the consent. */
  provider: string;
  /**
   * The consent, as written: shown word for word, never translated (the host records the exact
   * text consented to).
   */
  consent: string;
  /** Connect: the host opens the app's sign-in. */
  onConnect: (choice: ConnectAppChoice) => void;
  /** The trigger's size: `xs` in a panel's bar, `sm` on a page. @default "sm" */
  size?: "xs" | "sm";
  /** The app was connected and stopped working: Connect again. */
  again?: boolean;
  /**
   * Who uses it, where the host fixes it (a Composio toolkit is always for everyone): its word in
   * place of the Select.
   */
  forWhom?: AppConnection["forWhom"];
  words?: Partial<ConnectAppWords>;
  appWords?: Partial<AppIntegrationWords>;
}

const styles = stylex.create({
  // The dither in the app's colour, from the dialog's top behind its head.
  texture: { insetBlockEnd: "auto", height: "10rem" },
  // The mark on the dialog's own inset, over the title.
  mark: {
    position: "relative",
    display: "flex",
    paddingBlockStart: grasp.space6,
    paddingInline: grasp.space6,
  },
  description: { whiteSpace: "pre-line" },
  sections: {
    display: "grid",
    gap: grasp.space5,
    marginInline: `calc(-1 * ${grasp.inspectorInset})`,
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
    paddingInline: grasp.inspectorInset,
  },
  summary: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
  },
  groups: { maxHeight: "16rem" },
  who: { paddingBlock: grasp.space1, paddingInline: grasp.space1 },
  // Who uses it, fixed by the host: its word on the section's inset.
  fixed: { paddingBlock: grasp.space2, paddingInline: grasp.inspectorInset },
  consentScroll: { maxHeight: "7rem" },
  consent: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    whiteSpace: "pre-wrap",
  },
});

/** Each tool at its default: reads run, changes ask first. */
const defaultsOf = (tools: readonly AppTool[]): AppTool[] =>
  tools.map((tool) => ({
    ...tool,
    choice: tool.kind === "read" ? "read" : "write",
  }));

/** What Grasp may do, in one line, from how the tools stand. */
const summaryOf = (tools: readonly AppTool[], words: ConnectAppWords) => {
  if (tools.every((tool) => tool.choice === "never")) {
    return words.summaryNone;
  }
  const reads = tools.filter((tool) => tool.kind === "read");
  const writes = tools.filter((tool) => tool.kind === "write");
  if (
    reads.every((tool) => tool.choice === "read") &&
    writes.every((tool) => tool.choice === "write")
  ) {
    return words.summaryAll;
  }
  if (
    reads.every((tool) => tool.choice === "read") &&
    writes.every((tool) => tool.choice === "never")
  ) {
    return words.summaryRead;
  }
  return words.summaryMixed;
};

/** Connect an app: what Grasp may do, who uses it, and the consent, in one dialog from its Connect button. */
export const ConnectApp = ({
  app,
  provider,
  consent,
  onConnect,
  size = "sm",
  again = false,
  forWhom: fixed,
  words: given,
  appWords,
}: ConnectAppProps) => {
  const words = useWords("connectApp", connectAppWords, given);
  const shared = useWords("appIntegration", appIntegrationWords, appWords);
  const tint = useAppTint(app);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [tools, setTools] = useState<readonly AppTool[]>(() =>
    defaultsOf(app.tools ?? [])
  );
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "everyone"
  );
  const consentId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setChanging(false);
          setTools(defaultsOf(app.tools ?? []));
        }
      }}
    >
      <DialogTrigger variant="ink" size={size}>
        {again ? shared.connectAgain : shared.connect}
      </DialogTrigger>
      <DialogContent closeLabel={shared.close}>
        <Texture tint={tint} layout={styles.texture} />
        <div {...stylex.props(styles.mark)}>
          <AppMark app={app} size="md" />
        </div>
        <DialogTitle>
          {again ? words.titleAgain(app.name) : words.title(app.name)}
        </DialogTitle>
        <DialogDescription>
          <span {...stylex.props(styles.description)}>{app.description}</span>
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.sections)}>
            {tools.length > 0 ? (
              <PanelSection label={shared.mayDo} card={changing}>
                {changing ? (
                  <ScrollArea aria-label={shared.mayDo} layout={styles.groups}>
                    <GroupRows
                      tools={tools}
                      editable
                      connected
                      words={shared}
                      onChange={(changes) => {
                        const next = new Map(
                          changes.map((change) => [change.id, change.choice])
                        );
                        setTools(
                          tools.map((tool) => ({
                            ...tool,
                            choice: next.get(tool.id) ?? tool.choice,
                          }))
                        );
                      }}
                    />
                  </ScrollArea>
                ) : null}
                {/* The summary as a plain line, Change at its end; open, Done there closes the rows. */}
                <div {...stylex.props(styles.summaryRow)}>
                  {changing ? (
                    <span />
                  ) : (
                    <p {...stylex.props(styles.summary)}>
                      {summaryOf(tools, words)}
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-expanded={changing}
                    onClick={() => {
                      setChanging(!changing);
                    }}
                  >
                    {changing ? words.done : words.change}
                  </Button>
                </div>
              </PanelSection>
            ) : null}
            <PanelSection label={words.whoUses}>
              {fixed === undefined ? (
                <div {...stylex.props(styles.who)}>
                  <Select
                    value={forWhom}
                    items={[
                      { value: "everyone", label: words.forEveryone },
                      { value: "you", label: words.forYou },
                    ]}
                    onValueChange={(value) => {
                      if (value === "everyone" || value === "you") {
                        setForWhom(value);
                      }
                    }}
                  >
                    <SelectTrigger
                      variant="text"
                      size="sm"
                      aria-label={words.whoUses}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              ) : (
                <div {...stylex.props(styles.fixed)}>
                  <p {...stylex.props(styles.summary)}>
                    {fixed === "everyone" ? words.forEveryone : words.forYou}
                  </p>
                </div>
              )}
            </PanelSection>
            <PanelSection label={words.consentFrom(provider)}>
              {/* As written, word for word: the host records the text consented to. Named, so the keys can scroll it. */}
              <ScrollArea
                aria-label={words.consentFrom(provider)}
                layout={styles.consentScroll}
              >
                <p
                  id={consentId}
                  lang="en"
                  dir="ltr"
                  {...stylex.props(styles.consent)}
                >
                  {consent}
                </p>
              </ScrollArea>
            </PanelSection>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{words.cancel}</DialogAction>
          {/* A dialog action like Cancel, so the two stand at one size side by side. */}
          <DialogAction
            variant="ink"
            action={() => {
              onConnect({
                tools: tools.map((tool) => ({
                  id: tool.id,
                  choice: tool.choice,
                })),
                forWhom,
              });
            }}
          >
            {words.connect}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
