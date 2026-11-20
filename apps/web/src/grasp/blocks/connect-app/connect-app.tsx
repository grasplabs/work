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
import { Texture } from "../../texture/texture";
import { Toggle, ToggleGroup } from "../../toggle";
import { grasp } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App, AppConnection } from "../app-integration/model";
import { AppMark, useAppTint } from "../app-integration/parts";
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
}

export const connectAppWords: ConnectAppWords = {
  title: (app) => `Connect ${app}`,
  titleAgain: (app) => `Connect ${app} again`,
  whoUses: "Who uses it",
  forYou: "Just you",
  forEveryone: "Everyone",
  signInAt: (host) => `You'll sign in at ${host}.`,
  cancel: "Cancel",
  signIn: (app) => `Sign in to ${app}`,
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
});

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
  const tint = useAppTint(app);
  const [forWhom, setForWhom] = useState<AppConnection["forWhom"]>(
    fixed ?? "you"
  );
  const labelId = useId();
  return (
    <Dialog>
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
        <DialogBody>
          <div {...stylex.props(styles.body)}>
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
                      setForWhom(chosen);
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
