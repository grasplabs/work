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
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { texture, textureTint } from "@grasp-os/ui/lib/styles";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId, useRef, useState } from "react";

import type { App, AppConnection, AppTool, AppToolChoice } from "./model.ts";
import { GroupRows } from "./page.tsx";
import { AppMark, GroupSelect, useAppTint } from "./parts.tsx";
import { groupTools } from "./tools.ts";
import { useAppIntegrationWords, useConnectAppWords } from "./words.ts";
import type { AppIntegrationWords, ConnectAppWords } from "./words.ts";

/** What `onConnect` is handed: who uses it. */
export interface ConnectAppChoice {
  forWhom: AppConnection["forWhom"];
}

/** Every prop a ConnectApp takes. */
export interface ConnectAppProps {
  app: App;
  /** Sign in: the host opens the app's sign-in. Return a Promise and Sign in says it is working until it settles. */
  onConnect: (choice: ConnectAppChoice) => unknown;
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
  /**
   * What Grasp may do with each tool when the dialog opens, where the host knows it: connecting a
   * stopped toolkit again (`again`) starts from the old connection's choices, and a tool it left out
   * starts at Never, so connecting again allows nothing the old connection didn't. Without it, each
   * tool starts at its default (reads on, changes off).
   */
  initialTools?: readonly { id: string; choice: AppToolChoice }[];
  /**
   * What the dialog says in place of the tools when the app has none to
   * choose, and so can't be connected: why, as the host knows it.
   */
  noTools?: string;
}

const styles = stylex.create({
  // The dither in the app's colour, from the dialog's top behind its head.
  texture: { insetBlockEnd: "auto", height: "8rem" },
  // The mark on the dialog's own inset, over the title.
  mark: {
    position: "relative",
    display: "flex",
    paddingBlockStart: space["6"],
    paddingInline: space["6"],
  },
  body: { display: "grid", gap: space["4"] },
  // Who uses it: its name, then the switch at its own width.
  who: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["2"],
  },
  label: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  fixed: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  where: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  section: { display: "grid", gap: space["2"] },
  // The consent: small, quiet, in a box of its own height that scrolls.
  consentBox: { borderRadius: radius.base, backgroundColor: colors.muted },
  consentScroll: { maxHeight: "7.5rem" },
  consent: {
    margin: 0,
    paddingBlock: space["3"],
    paddingInline: space["3"],
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    whiteSpace: "pre-wrap",
  },
  // What Grasp may do: its name, the choice for every tool at its end.
  toolsHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  // The group rows reach the dialog's edges, as setting rows do.
  rows: { marginInline: `calc(-1 * ${space.sidePanelPadding})` },
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
      <span
        aria-hidden="true"
        {...stylex.props(
          texture,
          tint !== undefined && textureTint(tint),
          styles.texture
        )}
      />
      <div {...stylex.props(styles.mark)}>
        <AppMark app={app} size="default" />
      </div>
      <DialogHeader>
        <DialogTitle>
          {again ? words.titleAgain(app.name) : words.title(app.name)}
        </DialogTitle>
      </DialogHeader>
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
          onValueChange={(next) => {
            const [chosen] = next;
            if (chosen === "you" || chosen === "everyone") {
              onChange(chosen);
            }
          }}
          value={[forWhom]}
        >
          <ToggleGroupItem value="you">{words.forYou}</ToggleGroupItem>
          <ToggleGroupItem value="everyone">
            {words.forEveryone}
          </ToggleGroupItem>
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
}: ConnectAppProps) => {
  const words = useConnectAppWords();
  const shared = useAppIntegrationWords();
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={size}>
          {again ? shared.connectAgain : shared.connect}
        </Button>
      </DialogTrigger>
      <DialogContent>
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
          <DialogClose>{words.cancel}</DialogClose>
          <Button onClick={() => onConnect({ forWhom })}>
            {words.signIn(app.name)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Where the focus opens: the first control, the switch's chosen side, else Cancel where the host
 * fixes who uses it. Never the consent's scroller, which a sheet would scroll to its end to reveal.
 */
const firstControl = (body: HTMLElement | null) =>
  body?.querySelector<HTMLElement>(
    '[aria-pressed="true"], [aria-checked="true"], [data-pressed]'
  ) ??
  body
    ?.closest("[role=dialog]")
    ?.querySelector<HTMLElement>("[data-slot=dialog-footer] button") ??
  undefined;

/**
 * Each tool as it starts: the host's earlier choice where it gives one (`initialTools`), and Never
 * for a tool it leaves out; with none given, its default, a tool that only reads runs and one that
 * changes something stays off until chosen. A tool that changes something is never Read: an earlier
 * Read for it starts as Write, which asks first.
 */
const defaultsOf = (
  tools: readonly AppTool[],
  initial: ConnectAppConsentProps["initialTools"]
): AppTool[] => {
  const earlier = new Map(
    (initial ?? []).map((each) => [each.id, each.choice])
  );
  return tools.map((tool) => {
    // Connecting again (`initial` given): a tool the old connection left
    // out stays out, so nothing it didn't allow is turned on.
    const fresh = tool.kind === "read" ? "read" : "never";
    const choice =
      earlier.get(tool.id) ?? (initial === undefined ? fresh : "never");
    return {
      ...tool,
      choice: tool.kind === "write" && choice === "read" ? "write" : choice,
    };
  });
};

/** Why there are no tools to choose, when the host says. */
const NoTools = ({ words }: { words: string | undefined }) =>
  words === undefined ? null : (
    <p role="note" {...stylex.props(styles.where)}>
      {words}
    </p>
  );

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
  initialTools,
  noTools,
}: ConnectAppConsentProps) => {
  const words = useConnectAppWords();
  const shared = useAppIntegrationWords();
  const [open, setOpen] = useState(false);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  const [tools, setTools] = useState<readonly AppTool[]>(() =>
    defaultsOf(app.tools ?? [], initialTools)
  );
  const consentId = useId();
  const body = useRef<HTMLDivElement>(null);
  const consentLabel = words.consent;
  const allowsSome = tools.some((tool) => tool.choice !== "never");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTools(defaultsOf(app.tools ?? [], initialTools));
          setForWhom(fixed ?? "you");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size={size}>
          {again ? shared.connectAgain : shared.connect}
        </Button>
      </DialogTrigger>
      <DialogContent initialFocus={() => firstControl(body.current)}>
        <Head app={app} again={again} words={words} />
        <DialogBody>
          <div ref={body} {...stylex.props(styles.body)}>
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
                  style={styles.consentScroll}
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
                allLabel={words.allTools}
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
            ) : (
              <NoTools words={noTools} />
            )}
            {signInAt === undefined ? null : (
              <p {...stylex.props(styles.where)}>{words.signInAt(signInAt)}</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{words.cancel}</DialogClose>
          <Button
            disabled={!allowsSome}
            onClick={() =>
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
            {words.connect}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
