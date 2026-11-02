import type { Difference, SettleChoice } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { copyText, useEntrance } from "./setup-parts.tsx";
import type { AiReadiness } from "./setup.ts";

// What only the admin can settle in their onboarding, one item each
// (prototype `components/onboarding/review-parts.tsx`): a step people told
// two ways when nobody could say why, and letting Grasp's mail through
// their mail filter (GRA-968). Microsoft
// 365 filters mail with Exchange Online Protection and Defender, Google
// Workspace with its own rules: either can put mail from a domain it
// doesn't know in spam, and the interview links with it.

/** A way to settle it: the first is the one Stephen would take. */
export interface ReviewChoice {
  id: string;
  label: string;
}

/**
 * Something only the admin can settle, with what they need to settle it:
 * what it is about, anything more it shows, and every way to decide as a
 * button of its own. Once settled it says which way they chose, and that
 * can still be changed.
 */
export const ReviewItem = ({
  title,
  context,
  children,
  choices,
  chosen,
  onChoose,
  onReopen,
}: {
  title: string;
  context: string;
  children?: ReactNode;
  choices: ReviewChoice[];
  /** The choice it was settled with; none while it is open. */
  chosen: ReviewChoice | null;
  onChoose: (choice: ReviewChoice) => void;
  onReopen: () => void;
}) => {
  const { t } = useLingui();
  const settled = chosen !== null;
  const choice = chosen?.label ?? "";
  const settledEntrance = useEntrance(
    chosen?.id ?? "",
    "animate-in fade-in duration-300"
  );
  return (
    <div className="flex flex-col gap-3 border-t py-4 text-left last:border-b">
      <div className="flex flex-col">
        <span className={settled ? "text-muted-foreground" : "font-medium"}>
          {title}
        </span>
        <span className="text-muted-foreground">{context}</span>
      </div>
      {settled ? null : children}
      {chosen === null ? (
        <div className="flex flex-wrap gap-2" key="choices">
          {choices.map((each, at) => (
            <Button
              key={each.id}
              onClick={() => {
                onChoose(each);
              }}
              size="sm"
              variant={at === 0 ? "default" : "outline"}
            >
              {each.label}
            </Button>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            "text-muted-foreground flex items-center gap-2",
            settledEntrance
          )}
          key="settled"
        >
          <CheckIcon
            aria-hidden="true"
            className="text-status-agreed size-4 flex-none"
          />
          <span className="min-w-0 flex-1">{t`Settled: ${choice}`}</span>
          <Button onClick={onReopen} size="sm" variant="ghost">
            {t({ message: "Change", context: "change how it was settled" })}
          </Button>
        </div>
      )}
    </div>
  );
};

/** The ways to settle a difference, the one Stephen would take first. */
const settleChoices: readonly SettleChoice[] = ["both", "first", "other"];

/** One way a step is told, in a card: what is done, and how it was told, never by whom. */
const Way = ({ text, told }: { text: string; told: string }) => (
  <li className="bg-card flex flex-col gap-0.5 rounded-xl border px-3.5 py-3">
    <span className="font-medium">{text}</span>
    <span className="text-muted-foreground text-xs">{told}</span>
  </li>
);

/**
 * A step of a piece of work its people told two ways, and nobody could
 * say why: the two ways side by side, never by whom, and whether both
 * hold or which one does. Settled, it says which; `open` while it is
 * being decided again.
 */
export const DifferenceItem = ({
  difference,
  open,
  onSettle,
  onReopen,
}: {
  difference: Difference;
  open: boolean;
  onSettle: (holds: SettleChoice) => void;
  onReopen: () => void;
}) => {
  const { t } = useLingui();
  const { name, team, way, other, holds } = difference;
  const labels: Record<SettleChoice, string> = {
    both: t`Keep both`,
    first: t`Only the first way`,
    other: t`Only the second way`,
  };
  const choices = settleChoices.map((id) => ({ id, label: labels[id] }));
  return (
    <ReviewItem
      choices={choices}
      chosen={
        open || holds === null ? null : { id: holds, label: labels[holds] }
      }
      context={t`${team}: some do a step another way, and nobody could say why. I keep both ways until you decide.`}
      onChoose={({ id }) => {
        const choice = settleChoices.find((each) => each === id);
        if (choice !== undefined) {
          onSettle(choice);
        }
      }}
      onReopen={onReopen}
      title={t`People do “${name}” in two ways`}
    >
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Way text={way} told={t`The way most told it`} />
        <Way text={other} told={t`The way some told it`} />
      </ul>
    </ReviewItem>
  );
};

/** The sending domain as the admin types it into their filter, with a way to copy it. */
const DomainToCopy = ({ domain }: { domain: string }) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-muted/50 flex items-center gap-2 rounded-lg border py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono">{domain}</code>
      <Button
        onClick={() => {
          void (async () => {
            setCopied(await copyText(domain));
          })();
        }}
        size="sm"
        variant="ghost"
      >
        {copied ? (
          <CheckIcon data-icon="inline-start" />
        ) : (
          <CopyIcon data-icon="inline-start" />
        )}
        {copied ? t`Copied` : t`Copy`}
      </Button>
    </div>
  );
};

/** Numbered steps, short enough to follow in the other window. */
const Steps = ({ steps }: { steps: string[] }) => (
  <ol className="flex list-decimal flex-col gap-1.5 pl-5">
    {steps.map((step) => (
      <li key={step}>{step}</li>
    ))}
  </ol>
);

/**
 * Letting Grasp's mail through: the sending domain, and the few steps that
 * allow it in Microsoft 365 (a mail flow rule that skips spam filtering
 * for it) or Google Workspace (an approved senders list that asks for
 * authentication, which Grasp's signed mail passes). Settled when the
 * admin says it's done.
 */
export const MailItem = ({
  domain,
  settled,
  onSettle,
}: {
  domain: string;
  settled: boolean;
  onSettle: (settled: boolean) => void;
}) => {
  const { t } = useLingui();
  const done: ReviewChoice = { id: "done", label: t`It’s done` };
  return (
    <ReviewItem
      choices={[done]}
      chosen={settled ? done : null}
      context={t`Your people’s interview links come by email from Grasp’s sending domain. Allow it in your mail filter before they go out, so they don’t land in spam.`}
      onChoose={() => {
        onSettle(true);
      }}
      onReopen={() => {
        onSettle(false);
      }}
      title={t`Let Grasp’s mail through`}
    >
      <DomainToCopy domain={domain} />
      <Tabs defaultValue="microsoft">
        <TabsList variant="line">
          <TabsTrigger value="microsoft">Microsoft 365</TabsTrigger>
          <TabsTrigger value="google">Google Workspace</TabsTrigger>
        </TabsList>
        <TabsContent value="microsoft">
          <Steps
            steps={[
              t`In the Exchange admin center, go to Mail flow, then Rules, and add a rule.`,
              t`Apply it if the sender’s domain is ${domain}.`,
              t`As its action, set the spam confidence level (SCL) to “Bypass spam filtering”, then save it.`,
            ]}
          />
        </TabsContent>
        <TabsContent value="google">
          <Steps
            steps={[
              t`In the Google Admin console, go to Apps, then Google Workspace, then Gmail, then Spam, phishing and malware.`,
              t`Under Spam, bypass spam filters for an approved senders list, and add ${domain} to it.`,
              t`Keep “Require sender authentication” on, then save.`,
            ]}
          />
        </TabsContent>
      </Tabs>
    </ReviewItem>
  );
};

/**
 * Where Grasp sends no mail, as on hosting where mail isn't available yet:
 * nothing to let through, so nothing to settle. Says so, and that the
 * links go out by hand.
 */
export const NoMailItem = () => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col border-t py-4 text-left last:border-b">
      <span className="font-medium">{t`Mail isn’t available on this hosting yet`}</span>
      <span className="text-muted-foreground">{t`Grasp can’t email your people their interview links for now. Send each one their link by hand from Interviews.`}</span>
    </div>
  );
};

/**
 * Connecting an AI provider, which only the admin can do: Grasp's AI
 * calls models with the organization's own key (Settings › AI providers).
 * Done once a model is ready for calls, as core says; nothing to tick
 * here. Where the deployment's own gateway still serves models and no
 * provider is connected, nothing needs the admin, and nothing is shown.
 */
export const AiProviderItem = ({ ai }: { ai: AiReadiness }) => {
  const { t } = useLingui();
  const title = t`Connect an AI provider`;
  if (ai.ready && ai.providers.length === 0) {
    return null;
  }
  if (ai.ready) {
    const names = formatList(ai.providers);
    return (
      <div className="flex flex-col gap-3 border-t py-4 text-left last:border-b">
        <span className="text-muted-foreground">{title}</span>
        <div className="text-muted-foreground flex items-center gap-2">
          <CheckIcon
            aria-hidden="true"
            className="text-status-agreed size-4 flex-none"
          />
          <span className="min-w-0 flex-1">{t`Connected: ${names}`}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t py-4 text-left last:border-b">
      <div className="flex flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{t`Grasp’s AI works with your organization’s own AI provider key, such as Anthropic, OpenAI or Mistral AI. Connect one and choose a model, then come back here.`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          nativeButton={false}
          render={<Link to="/settings/ai-providers" />}
          size="sm"
        >
          {t`Connect a provider`}
        </Button>
      </div>
    </div>
  );
};
