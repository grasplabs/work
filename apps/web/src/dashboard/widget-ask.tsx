import type { CustomWidget, WidgetMade } from "@grasp-os/shared/widgets";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Asking Grasp for a widget, as the prototype's board does: from the empty
// card for a new one (`makeWidget`, widget-board.tsx), and from a made
// widget's sparkle to change it (`changeWidget`), which keeps its place.
// Either way core has the model write it and checks it against what the
// person may see; the page only shows what came back, and what Grasp said
// of the nearest thing it could make.

/**
 * What the person asks Grasp, and Grasp's answer: `ask` sends it, `onMade`
 * takes the widget that came back, and `onDone` closes the form, unless
 * Grasp said something of it, which stays to be read. `onBusy` follows
 * while Grasp makes it.
 */
export const WidgetAsk = ({
  label,
  placeholder,
  ask,
  onMade,
  onDone,
  onBusy,
}: {
  label: string;
  placeholder: string;
  ask: (session: Session, asked: string) => Promise<WidgetMade>;
  onMade: (widget: CustomWidget) => void;
  onDone: () => void;
  onBusy?: (busy: boolean) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const [request, setRequest] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const requestId = useId();
  const send = async () => {
    const asked = request.trim();
    if (asked === "" || busy) {
      return;
    }
    setNote(null);
    onBusy?.(true);
    const result = await run(async (session) => await ask(session, asked));
    onBusy?.(false);
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
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Field>
        <FieldLabel htmlFor={requestId}>{label}</FieldLabel>
        <Textarea
          disabled={busy}
          id={requestId}
          maxLength={500}
          onChange={(event) => {
            setRequest(event.target.value);
          }}
          placeholder={placeholder}
          value={request}
        />
      </Field>
      <ErrorText>{failure}</ErrorText>
      {note === null ? null : (
        <output className="text-muted-foreground">{note}</output>
      )}
      <Button disabled={busy || request.trim() === ""} type="submit">
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {busy ? <Trans>Grasp is making it…</Trans> : <Trans>Ask Grasp</Trans>}
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
}: {
  widget: CustomWidget;
  onChanged: (widget: CustomWidget) => void;
  onBusy: (busy: boolean) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const label = t`Change with Grasp`;
  const { title } = widget.view;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button aria-label={label} size="icon-sm" variant="ghost" />
              }
            />
          }
        >
          <SparklesIcon />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80">
        <PopoverHeader>
          <PopoverTitle>{t`Change ${title}`}</PopoverTitle>
        </PopoverHeader>
        <WidgetAsk
          ask={async (session, asked) =>
            await session.dashboard.changeWidget(widget.id, asked)
          }
          label={t`What should change?`}
          onBusy={onBusy}
          onDone={() => {
            setOpen(false);
          }}
          onMade={onChanged}
          placeholder={t`Show only the failed runs.`}
        />
      </PopoverContent>
    </Popover>
  );
};
