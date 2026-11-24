import { failureText } from "@grasp-os/shared/errors";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
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
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import type { App, AppConnection, AppTool, AppToolChoice } from "./model.ts";
import { GroupRows } from "./page.tsx";
import { AppMark, GroupSelect, useAppTint } from "./parts.tsx";
import { groupTools } from "./tools.ts";
import { useAppWords } from "./words.ts";

// Connecting an app, from the Connect of its panel or its page, in
// Damsko's Dialog. One screen:
//
//   head          the app's mark on a wash of its own colour, "Connect Microsoft 365"
//   Who uses it   one switch of two: Just you | Everyone (the host's word in
//                 its place where it fixes it)
//   where         one quiet line: "You'll sign in at microsoft.com."
//
// The foot ends the dialog: Cancel, then "Sign in to Microsoft 365", busy
// while the host starts the sign-in (a second press does nothing), and why
// it failed in the dialog, above the foot.
//
// ConnectAppConsent is the same dialog for an app a third party holds (a
// Composio toolkit): the same head, then the host's consent as written,
// word for word, in a quiet scroller of its own height, then what Grasp
// may do with each tool, by group, and Cancel, Connect. The host records
// the consent it was handed back and the tools chosen. Connecting a stopped
// one again says first that it makes a new connection beside the stopped
// one, which stays until it is disconnected (`AgainNote`).

/** What `onConnect` is handed: who uses it. */
export interface ConnectAppChoice {
  forWhom: AppConnection["forWhom"];
}

/** Every prop a ConnectApp takes. */
interface ConnectAppProps {
  app: App;
  /**
   * Sign in: the host opens the app's sign-in. The button is busy until it
   * settles; where it fails, the dialog says why.
   */
  onConnect: (choice: ConnectAppChoice) => Promise<void>;
  /** Where the sign-in happens ("microsoft.com"), said in one line. Without it, no line. */
  signInAt?: string;
  /** The trigger's size: `xs` in a panel's bar, `sm` on a page. */
  size?: "xs" | "sm";
  /** The app was connected and stopped working: Connect again. */
  again?: boolean;
  /**
   * Who uses it, where the host fixes it (a Composio toolkit is always for
   * everyone): its word in place of the switch.
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

const styles = stylex.create({
  // A wash of the app's colour, from the dialog's top behind its head.
  head: (tint: string) => ({
    marginBlockStart: `calc(-1 * ${space["6"]})`,
    marginInline: `calc(-1 * ${space["6"]})`,
    paddingBlockStart: space["6"],
    paddingInline: space["6"],
    backgroundImage: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 22%, transparent), transparent)`,
  }),
  mark: { display: "flex", paddingBlockEnd: space["3"] },
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
  consentScroll: { display: "grid", maxHeight: "7.5rem" },
  consent: {
    margin: 0,
    padding: space["3"],
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
  // The group rows reach the dialog's edges, as a list's rows do.
  rows: { marginInline: `calc(-1 * ${space.tableCellInline})` },
});

/** The head every connect dialog shares: a wash of the app's colour, its mark, the title. */
const Head = ({ app, again }: { app: App; again: boolean }) => {
  const { t } = useLingui();
  const tint = useAppTint(app);
  const { name } = app;
  return (
    <DialogHeader>
      {/* Without a colour of its own, the mint. */}
      <div {...stylex.props(styles.head(tint ?? colors.mint))}>
        <div {...stylex.props(styles.mark)}>
          <AppMark app={app} size="default" />
        </div>
        <DialogTitle>
          {again ? t`Connect ${name} again` : t`Connect ${name}`}
        </DialogTitle>
      </div>
    </DialogHeader>
  );
};

/** Who uses it: a switch of two, or the host's word where it fixes it. */
const WhoUses = ({
  fixed,
  forWhom,
  onChange,
}: {
  fixed: AppConnection["forWhom"] | undefined;
  forWhom: AppConnection["forWhom"];
  onChange: (forWhom: AppConnection["forWhom"]) => void;
}) => {
  const { t } = useLingui();
  const forYou = t`Just you`;
  const forEveryone = t`Everyone`;
  return (
    <div {...stylex.props(styles.who)}>
      <p aria-hidden="true" {...stylex.props(styles.label)}>
        {t`Who uses it`}
      </p>
      {fixed === undefined ? (
        <ToggleGroup
          aria-label={t`Who uses it`}
          onValueChange={(next) => {
            const [chosen] = next;
            if (chosen === "you" || chosen === "everyone") {
              onChange(chosen);
            }
          }}
          value={[forWhom]}
        >
          <ToggleGroupItem value="you">{forYou}</ToggleGroupItem>
          <ToggleGroupItem value="everyone">{forEveryone}</ToggleGroupItem>
        </ToggleGroup>
      ) : (
        <p {...stylex.props(styles.fixed)}>
          {fixed === "everyone" ? forEveryone : forYou}
        </p>
      )}
    </div>
  );
};

/** Where the sign-in happens, in one quiet line. */
const SignInAt = ({ host }: { host: string | undefined }) => {
  const { t } = useLingui();
  return host === undefined ? null : (
    <p {...stylex.props(styles.where)}>
      {t({
        message: `You’ll sign in at ${host}.`,
        comment:
          "{host} is the web address of the sign-in page, e.g. login.microsoftonline.com.",
      })}
    </p>
  );
};

/**
 * Why the dialog's action failed, said in the dialog: `press` runs the
 * host's work for the action's Button, which is busy until it settles and
 * then says it failed, and keeps why; `clear` forgets it as the dialog
 * opens again.
 */
const usePressFailure = () => {
  const [failure, setFailure] = useState<string>();
  const press = async (work: () => Promise<void>): Promise<void> => {
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
  };
  const said =
    failure === undefined ? null : (
      <Alert variant="destructive">
        <AlertDescription>{failure}</AlertDescription>
      </Alert>
    );
  return {
    press,
    said,
    clear: () => {
      setFailure(undefined);
    },
  };
};

/**
 * Connecting a stopped app again, said before its consent: a new
 * connection, beside the stopped one, which stays until it is
 * disconnected, starting fresh (consented to again, read in the Brain by
 * nobody until someone chooses), as core makes it.
 */
export const AgainNote = () => {
  const words = useAppWords();
  return (
    <Alert>
      <AlertDescription>{words.connectAgainNote}</AlertDescription>
    </Alert>
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
  const { t } = useLingui();
  const words = useAppWords();
  const [open, setOpen] = useState(false);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  const { press, said, clear } = usePressFailure();
  const { name } = app;
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setForWhom(fixed ?? "you");
          clear();
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size={size}>
          {again ? words.connectAgain : words.connect}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <Head again={again} app={app} />
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            <WhoUses fixed={fixed} forWhom={forWhom} onChange={setForWhom} />
            <SignInAt host={signInAt} />
            {said}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            onClick={async () => {
              await press(async () => {
                await onConnect({ forWhom });
              });
            }}
            size="sm"
          >
            {t`Sign in to ${name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Each tool as it starts: from the host's earlier choices where it gives
 * them (`initialTools`), a tool they leave out staying off, as it was;
 * else its default, a tool that only reads runs and one that changes
 * something stays off until chosen. A tool that changes something is never
 * Read: an earlier Read for it starts as Write, which asks first.
 */
const defaultsOf = (
  tools: readonly AppTool[],
  initial: readonly { id: string; choice: AppToolChoice }[] | undefined
): AppTool[] => {
  const earlier = new Map(
    (initial ?? []).map((each) => [each.id, each.choice])
  );
  return tools.map((tool) => {
    const fallback =
      initial === undefined && tool.kind === "read" ? "read" : "never";
    const choice = earlier.get(tool.id) ?? fallback;
    return {
      ...tool,
      choice: tool.kind === "write" && choice === "read" ? "write" : choice,
    };
  });
};

/** What Grasp may do with the tools: every tool at once, then each group, opening to its tools. */
const ToolPicker = ({
  tools,
  onChange,
}: {
  tools: readonly AppTool[];
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const { t } = useLingui();
  const words = useAppWords();
  const labelId = useId();
  const allLabel = t`All tools`;
  const [all] = groupTools(tools.map((tool) => ({ ...tool, group: allLabel })));
  return (
    <section aria-labelledby={labelId} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.toolsHead)}>
        <p id={labelId} {...stylex.props(styles.label)}>
          {words.mayDo}
        </p>
        {all === undefined ? null : (
          <GroupSelect
            group={all}
            label={allLabel}
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
          connected
          editable
          onChange={onChange}
          query=""
          tools={tools}
        />
      </div>
    </section>
  );
};

/**
 * Connect an app a third party holds (a Composio toolkit): who uses it, the
 * consent as written, and what Grasp may do with each tool, on one screen
 * from its Connect button.
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
}: Omit<ConnectAppProps, "onConnect"> & {
  /**
   * The consent, as the host wrote it: shown word for word, never changed
   * or translated here (the host records the exact text consented to). It
   * scrolls in its own quiet box.
   */
  consent: string;
  /**
   * Connect: the host records the choice and opens the sign-in. Connect is
   * busy until it settles; where it fails, the dialog says why.
   */
  onConnect: (choice: ConnectAppConsentChoice) => Promise<void>;
  /**
   * What Grasp may do with each tool when the dialog opens, where the host
   * knows it: connecting a stopped toolkit again (`again`) starts from the
   * old connection's choices. A tool left out starts off, as the old
   * connection had it.
   */
  initialTools?: readonly { id: string; choice: AppToolChoice }[];
}) => {
  const { t } = useLingui();
  const words = useAppWords();
  const [open, setOpen] = useState(false);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  const [tools, setTools] = useState<readonly AppTool[]>(() =>
    defaultsOf(app.tools ?? [], initialTools)
  );
  const { press, said, clear } = usePressFailure();
  const consentId = useId();
  const consentLabel = t`Consent`;
  const allowsSome = tools.some((tool) => tool.choice !== "never");
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTools(defaultsOf(app.tools ?? [], initialTools));
          setForWhom(fixed ?? "you");
          clear();
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size={size}>
          {again ? words.connectAgain : words.connect}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <Head again={again} app={app} />
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            {again ? <AgainNote /> : null}
            <WhoUses fixed={fixed} forWhom={forWhom} onChange={setForWhom} />
            <section
              aria-labelledby={consentId}
              {...stylex.props(styles.section)}
            >
              <p id={consentId} {...stylex.props(styles.label)}>
                {consentLabel}
              </p>
              {/* As the host wrote it, word for word: it records the text consented to. Named, so the keys can scroll it. */}
              <div {...stylex.props(styles.consentBox)}>
                <div {...stylex.props(styles.consentScroll)}>
                  <ScrollArea aria-label={consentLabel}>
                    <p dir="auto" {...stylex.props(styles.consent)}>
                      {consent}
                    </p>
                  </ScrollArea>
                </div>
              </div>
            </section>
            {tools.length > 0 ? (
              <ToolPicker
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
                tools={tools}
              />
            ) : null}
            <SignInAt host={signInAt} />
            {said}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            disabled={!allowsSome}
            onClick={async () => {
              await press(async () => {
                await onConnect({
                  forWhom,
                  tools: tools.map((tool) => ({
                    id: tool.id,
                    choice: tool.choice,
                  })),
                  consent,
                });
              });
            }}
            size="sm"
          >
            {t`Connect`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
