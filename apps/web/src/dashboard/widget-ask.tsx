import type {
  CustomWidget,
  WidgetMade,
  WidgetProgress,
} from "@grasp-os/shared/widgets";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Thought } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";

/** The most a request may say: core takes no longer. */
const MAX_REQUEST = 500;

const styles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
  },
});

// Asking Grasp for a widget, as the prototype's board does: from the empty
// card for a new one (`makeWidget`, widget-board.tsx), and from a made
// widget's sparkle to change it (`changeWidget`), which keeps its place.
// Either way core has the model write it and checks it against what the
// person may see; the page only shows what came back, and what Grasp said
// of the nearest thing it could make.

/** How Grasp is getting on, from the ask to its answer: `null` once it is back, or before. */
export type OnProgress = (progress: WidgetProgress | null) => void;

/**
 * What the person asks Grasp, and Grasp's answer: `ask` sends it, with
 * where core tells how it goes, `onMade` takes the widget that came back,
 * and `onDone` closes the form, unless Grasp said something of it, which
 * stays to be read. `onBusy` follows while Grasp makes it, and
 * `onProgress` each stage core tells of.
 */
export const WidgetAsk = ({
  label,
  placeholder,
  ask,
  onMade,
  onDone,
  onBusy,
  onProgress,
}: {
  label: string;
  placeholder: string;
  ask: (
    session: Session,
    asked: string,
    onProgress: (progress: WidgetProgress) => void
  ) => Promise<WidgetMade>;
  onMade: (widget: CustomWidget) => void;
  onDone: () => void;
  onBusy?: (busy: boolean) => void;
  onProgress?: OnProgress;
}) => {
  const { busy, failure, run } = useCoreAction();
  const [request, setRequest] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { t } = useLingui();
  const send = async () => {
    const asked = request.trim();
    if (asked === "" || busy) {
      return;
    }
    setNote(null);
    onBusy?.(true);
    onProgress?.(null);
    const result = await run(
      async (session) =>
        await ask(session, asked, (progress) => {
          onProgress?.(progress);
        })
    );
    onBusy?.(false);
    onProgress?.(null);
    if (result === undefined) {
      return;
    }
    setRequest("");
    onMade(result.widget);
    // What Grasp says of the nearest thing it made stays to be read; else
    // the form closes on the widget it made.
    if (result.note === null) {
      onDone();
    } else {
      setNote(result.note);
    }
  };
  return (
    <form
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Field disabled={busy}>
        <FieldLabel>{label}</FieldLabel>
        <Textarea
          maxLength={MAX_REQUEST}
          onValueChange={setRequest}
          placeholder={placeholder}
          value={request}
        />
      </Field>
      <ErrorText>{failure}</ErrorText>
      {note === null ? null : (
        <output>
          <Text tone="muted">{note}</Text>
        </output>
      )}
      <Button
        disabled={busy || request.trim() === ""}
        type="submit"
        variant="ink"
      >
        {busy ? t`Grasp is making it…` : t`Ask Grasp`}
      </Button>
    </form>
  );
};

/**
 * A made widget's sparkle, beside its title on the board: asks Grasp to
 * change it (`changeWidget`); `onChanged` takes it as it is now.
 */
export const ChangeWidget = ({
  widget,
  onChanged,
  onBusy,
  onProgress,
}: {
  widget: CustomWidget;
  onChanged: (widget: CustomWidget) => void;
  onBusy: (busy: boolean) => void;
  onProgress: OnProgress;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const label = t`Change with Grasp`;
  const { title } = widget.view;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        icon={Thought}
        aria-label={label}
        size="xs"
        variant="ghost"
      />
      <PopoverContent>
        <PopoverTitle>{t`Change ${title}`}</PopoverTitle>
        <WidgetAsk
          ask={async (session, asked, progress) =>
            await session.dashboard.changeWidget(widget.id, asked, progress)
          }
          label={t`What should change?`}
          onBusy={onBusy}
          onDone={() => {
            setOpen(false);
          }}
          onMade={onChanged}
          onProgress={onProgress}
          placeholder={t`Show only the failed runs.`}
        />
      </PopoverContent>
    </Popover>
  );
};
