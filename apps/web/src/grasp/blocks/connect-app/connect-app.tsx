// Connect app: connecting an app (app-integration's panel and page open it from their Connect), in a
// dialog of the same family as the panel, growing from the Connect button that opened it. One screen:
//
//   head          the dither in the app's own colour, its mark, "Connect Microsoft 365"
//   Who uses it   one switch of two: Just you | Everyone (the host's word in its place where it fixes it)
//   where         one quiet line: "You'll sign in at microsoft.com."
//
// The foot ends the dialog: Cancel, "Sign in to Microsoft 365", at its end. On a phone the dialog is
// a bottom sheet and the two share its width.
//
//   <ConnectApp app={m365} signInAt="microsoft.com" onConnect={signIn} />
//
// ConnectAppConsent is the same dialog for an app a third party holds (a Composio toolkit): the same
// head, then the host's consent as written, word for word, in a quiet scroller of its own height, then
// what Grasp may do with each tool, by group, and Cancel, Connect. The host records the consent it
// was handed back and the tools chosen.
//
//   <ConnectAppConsent app={hubspot} forWhom="everyone" consent={consentText} onConnect={connect} />
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../../dialog";
import { ScrollArea } from "../../scroll-area";
import { Texture } from "../../texture/texture";
import { Toggle, ToggleGroup } from "../../toggle";
import { grasp } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type {
  App,
  AppConnection,
  AppTool,
  AppToolChoice,
} from "../app-integration/model";
import { GroupRows } from "../app-integration/page";
import { AppMark, GroupSelect, useAppTint } from "../app-integration/parts";
import { groupTools } from "../app-integration/tools";
import { appIntegrationWords } from "../app-integration/words";
import type { AppIntegrationWords } from "../app-integration/words";

/** Every word the dialog shows or says, beside the app's own (app-integration/words.ts). */
export interface ConnectAppWords {
  title: (app: string) => string;
  titleAgain: (app: string) => string;
  whoUses: string;
  forYou: string;
  forEveryone: string;
  /** Where the sign-in happens, in one line. */
  signInAt: (host: string) => string;
  cancel: string;
  signIn: (app: string) => string;
  /**
   * ConnectAppConsent's: the consent's label, the choice for every tool at once, and its Connect.
   * Optional, so a catalogue from before them still holds; left out, they are English.
   */
  consent?: string;
  allTools?: string;
  connect?: string;
}

/** ConnectAppConsent's own words in English, where a catalogue from before them leaves them out. */
const consentWords = {
  consent: "Consent",
  allTools: "All tools",
  connect: "Connect",
};

export const connectAppWords: ConnectAppWords = {
  title: (app) => `Connect ${app}`,
  titleAgain: (app) => `Connect ${app} again`,
  whoUses: "Who uses it",
  forYou: "Just you",
  forEveryone: "Everyone",
  signInAt: (host) => `You'll sign in at ${host}.`,
  cancel: "Cancel",
  signIn: (app) => `Sign in to ${app}`,
  ...consentWords,
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    connectApp: ConnectAppWords;
  }
}

/** What `onConnect` is handed: who uses it. */
export interface ConnectAppChoice {
  forWhom: AppConnection["forWhom"];
}

/** Every prop a ConnectApp takes. */
export interface ConnectAppProps {
  app: App;
  /** Sign in: the host opens the app's sign-in. */
  onConnect: (choice: ConnectAppChoice) => void;
  /** Where the sign-in happens ("microsoft.com"), said in one line. Without it, no line. */
  signInAt?: string;
  /** The trigger's size: `xs` in a panel's bar, `sm` on a page. @default "sm" */
  size?: "xs" | "sm";
  /** The app was connected and stopped working: Connect again. */
  again?: boolean;
  /**
   * Who uses it, where the host fixes it (a Composio toolkit is always for everyone): its word in
   * place of the switch.
   */
  forWhom?: AppConnection["forWhom"];
  words?: Partial<ConnectAppWords>;
  appWords?: Partial<AppIntegrationWords>;
}

/** What ConnectAppConsent's `onConnect` is handed: who uses it, each tool's choice, and the consent shown. */
export interface ConnectAppConsentChoice {
  forWhom: AppConnection["forWhom"];
  /** Every tool of `app.tools` with what Grasp may do with it; `never` for those left off. */
  tools: readonly { id: string; choice: AppToolChoice }[];
  /** The consent exactly as it was shown, for the host to record. */
  consent: string;
}

/** Every prop a ConnectAppConsent takes. */
export interface ConnectAppConsentProps extends Omit<
  ConnectAppProps,
  "onConnect"
> {
  /**
   * The consent, as the host wrote it: shown word for word, never changed or translated here (the
   * host records the exact text consented to). It scrolls in its own quiet box.
   */
  consent: string;
  /**
   * Connect: the host records the choice and opens the sign-in. Return a Promise and Connect says it
   * is working until it settles, and failed if it fails.
   */
  onConnect: (choice: ConnectAppConsentChoice) => unknown;
}

const styles = stylex.create({
  // The dither in the app's colour, from the dialog's top behind its head.
  texture: { insetBlockEnd: "auto", height: "8rem" },
  // The mark on the dialog's own inset, over the title.
  mark: {
    position: "relative",
    display: "flex",
    paddingBlockStart: grasp.space6,
    paddingInline: grasp.space6,
  },
  body: { display: "grid", gap: grasp.space4 },
  // Who uses it: its name, then the switch at its own width.
  who: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  label: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  fixed: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  where: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  section: { display: "grid", gap: grasp.space2 },
  // The consent: small, quiet, in a box of its own height that scrolls.
  consentBox: { borderRadius: grasp.corner, backgroundColor: grasp.soft },
  consentScroll: { maxHeight: "7.5rem" },
  consent: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space3,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    whiteSpace: "pre-wrap",
  },
  // What Grasp may do: its name, the choice for every tool at its end.
  toolsHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  // The group rows reach the dialog's edges, as setting rows do.
  rows: { marginInline: `calc(-1 * ${grasp.inspectorInset})` },
});

/** The head every connect dialog shares: the dither in the app's colour, its mark, the title. */
const Head = ({
  app,
  again,
  words,
}: {
  app: App;
  again: boolean;
  words: ConnectAppWords;
}) => {
  const tint = useAppTint(app);
  return (
    <>
      <Texture tint={tint} layout={styles.texture} />
      <div {...stylex.props(styles.mark)}>
        <AppMark app={app} size="md" />
      </div>
      <DialogTitle>
        {again ? words.titleAgain(app.name) : words.title(app.name)}
      </DialogTitle>
    </>
  );
};

/** Who uses it: a switch of two, or the host's word where it fixes it. */
const WhoUses = ({
  fixed,
  forWhom,
  onChange,
  words,
}: {
  fixed: AppConnection["forWhom"] | undefined;
  forWhom: AppConnection["forWhom"];
  onChange: (forWhom: AppConnection["forWhom"]) => void;
  words: ConnectAppWords;
}) => {
  const labelId = useId();
  return (
    <div {...stylex.props(styles.who)}>
      <p id={labelId} {...stylex.props(styles.label)}>
        {words.whoUses}
      </p>
      {fixed === undefined ? (
        <ToggleGroup
          aria-labelledby={labelId}
          value={[forWhom]}
          onValueChange={(next) => {
            const [chosen] = next;
            if (chosen === "you" || chosen === "everyone") {
              onChange(chosen);
            }
          }}
        >
          <Toggle value="you">{words.forYou}</Toggle>
          <Toggle value="everyone">{words.forEveryone}</Toggle>
        </ToggleGroup>
      ) : (
        <p {...stylex.props(styles.fixed)}>
          {fixed === "everyone" ? words.forEveryone : words.forYou}
        </p>
      )}
    </div>
  );
};

/** Connect an app: who uses it and where you'll sign in, on one screen from its Connect button. */
export const ConnectApp = ({
  app,
  onConnect,
  signInAt,
  size = "sm",
  again = false,
  forWhom: fixed,
  words: given,
  appWords,
}: ConnectAppProps) => {
  const words = useWords("connectApp", connectAppWords, given);
  const shared = useWords("appIntegration", appIntegrationWords, appWords);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  return (
    <Dialog>
      <DialogTrigger variant="ink" size={size}>
        {again ? shared.connectAgain : shared.connect}
      </DialogTrigger>
      <DialogContent closeLabel={shared.close}>
        <Head app={app} again={again} words={words} />
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            <WhoUses
              fixed={fixed}
              forWhom={forWhom}
              onChange={setForWhom}
              words={words}
            />
            {signInAt === undefined ? null : (
              <p {...stylex.props(styles.where)}>{words.signInAt(signInAt)}</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{words.cancel}</DialogAction>
          {/* A dialog action like Cancel, so the two stand at one size side by side. */}
          <DialogAction
            variant="ink"
            action={() => {
              onConnect({ forWhom });
            }}
          >
            {words.signIn(app.name)}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Each tool at its default: a tool that only reads runs; one that changes something stays off until chosen. */
const defaultsOf = (tools: readonly AppTool[]): AppTool[] =>
  tools.map((tool) => ({
    ...tool,
    choice: tool.kind === "read" ? "read" : "never",
  }));

/** What Grasp may do with the tools: every tool at once, then each group, opening to its tools. */
const ToolPicker = ({
  tools,
  label,
  allLabel,
  appWords,
  onChange,
}: {
  tools: readonly AppTool[];
  label: string;
  allLabel: string;
  appWords: AppIntegrationWords;
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const labelId = useId();
  const [all] = groupTools(tools.map((tool) => ({ ...tool, group: allLabel })));
  return (
    <section aria-labelledby={labelId} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.toolsHead)}>
        <p id={labelId} {...stylex.props(styles.label)}>
          {label}
        </p>
        {all === undefined ? null : (
          <GroupSelect
            group={all}
            label={allLabel}
            words={appWords}
            onChange={(choice) => {
              onChange(
                tools.map((tool) => ({
                  id: tool.id,
                  choice:
                    choice === "read" && tool.kind === "write"
                      ? "never"
                      : choice,
                }))
              );
            }}
          />
        )}
      </div>
      <div {...stylex.props(styles.rows)}>
        <GroupRows
          tools={tools}
          editable
          connected
          words={appWords}
          onChange={onChange}
        />
      </div>
    </section>
  );
};

/**
 * Connect an app a third party holds (a Composio toolkit): who uses it, the consent as written, and
 * what Grasp may do with each tool, on one screen from its Connect button.
 */
export const ConnectAppConsent = ({
  app,
  consent,
  onConnect,
  signInAt,
  size = "sm",
  again = false,
  forWhom: fixed,
  words: given,
  appWords,
}: ConnectAppConsentProps) => {
  const words = useWords("connectApp", connectAppWords, given);
  const shared = useWords("appIntegration", appIntegrationWords, appWords);
  const [open, setOpen] = useState(false);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  const [tools, setTools] = useState<readonly AppTool[]>(() =>
    defaultsOf(app.tools ?? [])
  );
  const consentId = useId();
  const consentLabel = words.consent ?? consentWords.consent;
  const allowsSome = tools.some((tool) => tool.choice !== "never");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTools(defaultsOf(app.tools ?? []));
          setForWhom(fixed ?? "you");
        }
      }}
    >
      <DialogTrigger variant="ink" size={size}>
        {again ? shared.connectAgain : shared.connect}
      </DialogTrigger>
      <DialogContent closeLabel={shared.close}>
        <Head app={app} again={again} words={words} />
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            <WhoUses
              fixed={fixed}
              forWhom={forWhom}
              onChange={setForWhom}
              words={words}
            />
            <section
              aria-labelledby={consentId}
              {...stylex.props(styles.section)}
            >
              <p id={consentId} {...stylex.props(styles.label)}>
                {consentLabel}
              </p>
              {/* As the host wrote it, word for word: it records the text consented to. Named, so the keys can scroll it. */}
              <div {...stylex.props(styles.consentBox)}>
                <ScrollArea
                  aria-label={consentLabel}
                  layout={styles.consentScroll}
                >
                  <p dir="auto" {...stylex.props(styles.consent)}>
                    {consent}
                  </p>
                </ScrollArea>
              </div>
            </section>
            {tools.length > 0 ? (
              <ToolPicker
                tools={tools}
                label={shared.mayDo}
                allLabel={words.allTools ?? consentWords.allTools}
                appWords={shared}
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
            ) : null}
            {signInAt === undefined ? null : (
              <p {...stylex.props(styles.where)}>{words.signInAt(signInAt)}</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{words.cancel}</DialogAction>
          <DialogAction
            variant="ink"
            disabled={!allowsSome}
            action={() =>
              onConnect({
                forWhom,
                tools: tools.map((tool) => ({
                  id: tool.id,
                  choice: tool.choice,
                })),
                consent,
              })
            }
          >
            {words.connect ?? consentWords.connect}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
