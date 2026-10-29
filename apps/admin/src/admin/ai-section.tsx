/**
 * A client's AI on its Setup's Status tab (src/admin/setup.tsx): where it
 * runs, in plain words from the residency catalog's entries for the
 * routes its core reports (src/clients/model-transport.ts); the transport
 * in force and its failover, and where that comes from; who processes its
 * AI; how each transport last fared; the keys its transport names that
 * its core lacks; a check now, which makes one small call through its
 * gateway; and changing the transport, which reaches its core with its
 * next deploy.
 */
import {
  processingWords,
  subprocessorsOf,
} from "@grasp-os/shared/model-residency";
import type { ModelResidency } from "@grasp-os/shared/model-transport";
import type { ModelTransportReport } from "@grasp-os/shared/model-transport-report";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Await } from "@tanstack/react-router";
import { useState } from "react";

import {
  checkModelTransportFn,
  setModelTransportFn,
} from "../clients/functions.ts";
import type { ClientModelTransport } from "../clients/model-transport.ts";
import { useSettingsAction } from "../clients/use-action.ts";
import { formatTime } from "../releases/format.ts";
import { thenRefresh } from "../use-action.ts";
import { ApplySettings } from "./setup-actions.tsx";
import type { Refresh } from "./setup-actions.tsx";
import { Body, Facts, Failure, Quiet, SetupSection } from "./setup-parts.tsx";
import { TransportForm } from "./transport-form.tsx";
import type { TransportChoice } from "./transport-form.tsx";
import {
  kindWords,
  residencyWords,
  sourceWords,
  transportWords,
} from "./transport-words.ts";

/** A time core recorded, in milliseconds, as the admin shows times; `never` for none. */
const whenOf = (at: number | null): string =>
  at === null ? "never" : `${formatTime(new Date(at))} UTC`;

/** How one transport last fared, in a sentence: metadata only. */
const healthWords = (
  health: ModelTransportReport["health"][number]
): string => {
  const failed =
    health.lastFailedAt === null
      ? "never failed"
      : `last failed ${whenOf(health.lastFailedAt)} (${[
          health.lastFailure,
          health.lastStatus === null ? null : `status ${health.lastStatus}`,
        ]
          .filter((part) => part !== null)
          .join(", ")})`;
  return `${health.transport}: last worked ${whenOf(health.lastOkAt)}, ${failed}.`;
};

/** A probe's outcome, in a sentence: metadata only. */
const probeWords = (
  probe: NonNullable<ModelTransportReport["probe"]>
): string => {
  const how = [
    probe.transport === null ? null : `through ${probe.transport}`,
    probe.region === null ? null : `in ${probe.region}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return probe.ok
    ? `${probe.model} answered ${how} in ${String(Math.round(probe.ms))} ms.`
    : `${probe.model} failed${how === "" ? "" : ` ${how}`}: ${probe.error ?? "unknown"}, after ${String(Math.round(probe.ms))} ms.`;
};

/** What the transport in force is, as its core reports it or else as the admin sets it. */
const inForceWords = (ai: ClientModelTransport): string => {
  const { config } = ai.configured.effective;
  if (ai.report === null) {
    return transportWords(config.primary);
  }
  return ai.report.primary === null
    ? "None it can read"
    : kindWords[ai.report.primary];
};

/** Its failover in force, in words; `Off` for none. */
const failoverWords = (ai: ClientModelTransport): string => {
  const failover =
    ai.report === null
      ? ai.configured.effective.config.failover.map(transportWords)
      : ai.report.failover.map((kind) => kindWords[kind]);
  return failover.length === 0 ? "Off" : failover.join(", then ");
};

/** What its AI is reached through and may run where, as facts. */
const AiFacts = ({
  ai,
  residency,
}: {
  ai: ClientModelTransport;
  residency: ModelResidency;
}) => {
  const missing = ai.report?.missingKeys ?? [];
  return (
    <Facts
      rows={[
        { label: "Reaches models through", value: inForceWords(ai) },
        { label: "Fails over to", value: failoverWords(ai) },
        {
          label: "Set by",
          value: sourceWords(ai.configured.effective.source, residency),
        },
        { label: "Where AI may run", value: residencyWords[residency] },
        ...(missing.length === 0
          ? []
          : [
              {
                label: "Missing keys",
                value: `${missing.join(", ")}: not in MODEL_PROVIDER_KEYS, so calls that need them are refused.`,
                attention: true,
              },
            ]),
      ]}
    />
  );
};

/** Who processes its AI, from its routes' catalog entries. */
const Subprocessors = ({ ai }: { ai: ClientModelTransport }) => {
  const subprocessors = subprocessorsOf(ai.entries);
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">Who processes its AI</h3>
      {subprocessors.length === 0 ? (
        <p className="text-muted-foreground">
          Nobody outside its own deployment.
        </p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {subprocessors.map((party) => (
            <li key={`${party.name}-${party.role}`}>
              {`${party.name}: ${party.role}, ${party.location}.`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** How each of its transports last fared, as its core reports it. */
const Health = ({ report }: { report: ModelTransportReport | null }) =>
  report === null ? null : (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">How each way fared</h3>
      {report.health.length === 0 ? (
        <p className="text-muted-foreground">No call has gone out yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {report.health.map((health) => (
            <li key={health.transport}>{healthWords(health)}</li>
          ))}
        </ul>
      )}
    </div>
  );

/** Asking its core again, with a probe call, and what came of it. */
const CheckNow = ({
  clientId,
  checked,
  onChecked,
}: {
  clientId: string;
  /** What the last check read; null before one. */
  checked: ClientModelTransport | null;
  onChecked: (checked: ClientModelTransport | null) => void;
}) => {
  const { busy, failure, run } = useSettingsAction();
  const probe = checked?.report?.probe ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy}
          onClick={() => {
            void run(async () => {
              onChecked(await checkModelTransportFn({ data: { clientId } }));
              return { refused: null };
            });
          }}
          size="sm"
          variant="outline"
        >
          Check now
        </Button>
        <span className="text-muted-foreground">
          Asks its core again, and makes one small model call through its
          gateway.
        </span>
        <Failure failure={failure} />
      </div>
      {probe === null ? null : <p>{probeWords(probe)}</p>}
      {checked !== null && checked.report === null ? (
        <p className="text-muted-foreground">
          Its core couldn&apos;t be asked.
        </p>
      ) : null}
    </div>
  );
};

/** Where its AI runs and how, and changing it. */
const AiDetails = ({
  clientId,
  read,
  active,
  configPending,
  pinned,
  refresh,
}: {
  clientId: string;
  read: ClientModelTransport;
  active: boolean;
  configPending: boolean;
  pinned: string | null;
  refresh: Refresh;
}) => {
  const [checked, setChecked] = useState<ClientModelTransport | null>(null);
  const [saved, setSaved] = useState(false);
  const saving = useSettingsAction();
  const ai = checked ?? read;
  const residency = ai.report?.residency ?? ai.configured.residency;
  const { setting } = ai.configured;
  const save = (choice: TransportChoice | null) => {
    setChecked(null);
    void saving.run(async () => {
      const result = await thenRefresh(
        async () =>
          await setModelTransportFn({
            data: {
              clientId,
              transport:
                choice === null
                  ? null
                  : {
                      primary: choice.primary,
                      failover: choice.failover,
                      residency: choice.euOnly ? "eu" : "global",
                    },
            },
          }),
        refresh
      );
      setSaved(result.refused === null);
      return result;
    });
  };
  return (
    <>
      <Body>
        <p>{processingWords(ai.entries, residency)}</p>
        {ai.report === null ? (
          <p className="text-muted-foreground">
            {active
              ? "Its core couldn't be asked: this is what the admin sets for it, not what it reports."
              : "Not live yet: this is what it will be given."}
          </p>
        ) : null}
      </Body>
      <AiFacts ai={ai} residency={residency} />
      <Body>
        <Subprocessors ai={ai} />
        <Health report={ai.report} />
        {active ? (
          <CheckNow
            checked={checked}
            clientId={clientId}
            onChecked={setChecked}
          />
        ) : null}
        <Collapsible>
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            Change how it reaches models
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3">
              <TransportForm
                busy={saving.busy}
                current={setting}
                defaultWords="Back to the default"
                euOnly={setting?.residency === "eu"}
                failure={saving.failure}
                id={`ai-${clientId}`}
                // Keyed by what's saved: it starts again from it after each change.
                key={JSON.stringify(setting)}
                offerEuOnly={ai.configured.residency === "global"}
                onSave={save}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Body>
      {saved ? (
        <>
          <Quiet>Saved. It reaches its core with its next deploy.</Quiet>
          <ApplySettings
            active={active}
            clientId={clientId}
            configPending={configPending}
            pinned={pinned}
            refresh={refresh}
          />
        </>
      ) : null}
    </>
  );
};

/**
 * Its AI, its core read live and not awaited: the section shows once it
 * answers (or couldn't be asked), as the quota policy's does.
 */
export const AiSection = ({
  clientId,
  ai,
  active,
  configPending,
  pinned,
  refresh,
}: {
  clientId: string;
  ai: Promise<ClientModelTransport | null>;
  active: boolean;
  configPending: boolean;
  pinned: string | null;
  refresh: Refresh;
}) => (
  <Await fallback={null} promise={ai}>
    {(read) => (
      <SetupSection
        description="Where its AI runs, how its core reaches its models, and who processes them. Its core keeps every call within its hosting policy."
        title="AI"
      >
        {read === null ? (
          <Quiet>Its AI couldn&apos;t be read.</Quiet>
        ) : (
          <AiDetails
            active={active}
            clientId={clientId}
            configPending={configPending}
            pinned={pinned}
            read={read}
            refresh={refresh}
          />
        )}
      </SetupSection>
    )}
  </Await>
);
