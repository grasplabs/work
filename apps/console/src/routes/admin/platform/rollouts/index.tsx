import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AdminPage } from "../../../../admin/page.tsx";
import { Panel } from "../../../../admin/panel.tsx";
import {
  PlatformNav,
  platformCrumb,
  rolloutStatusWords,
  startRolloutId,
  useCompanyNames,
} from "../../../../admin/platform-nav.tsx";
import { Quiet } from "../../../../admin/release-parts.tsx";
import { formatTime } from "../../../../releases/format.ts";
import {
  fetchRollouts,
  startRolloutFn,
} from "../../../../rollout/functions.ts";
import type {
  RolloutOptions,
  RolloutSummary,
} from "../../../../rollout/queries.ts";
import { startRequestOf } from "../../../../rollout/start-request.ts";
import type {
  RolloutKind,
  ScopeKind,
} from "../../../../rollout/start-request.ts";
import { useRolloutAction } from "../../../../rollout/use-action.ts";

/** Whom a rollout reaches after ring 0, as the form offers it. */
const scopes: { value: ScopeKind; label: string }[] = [
  { value: "ring", label: "One ring" },
  { value: "client", label: "One client" },
  { value: "all", label: "Every client, ring by ring" },
];

/** What a rollout takes to clients, as the form offers it. */
const kinds: { value: RolloutKind; label: string }[] = [
  { value: "release", label: "A release" },
  { value: "secrets", label: "Secrets only" },
];

/** The form's text field `name`, trimmed. */
const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** `count` clients, in words. */
const clientsOf = (count: number): string =>
  count === 1 ? "1 client" : `${count} clients`;

/** Starting a rollout: a release or the secrets alone, and whom it reaches after ring 0. */
const StartRollout = ({ options }: { options: RolloutOptions }) => {
  const navigate = useNavigate();
  const names = useCompanyNames();
  const { busy, failure, run } = useRolloutAction();
  // Only rings past the first can be chosen: every rollout reaches that
  // one first, whatever else it's for.
  const later = options.rings.filter(({ ring }) => ring !== options.firstRing);
  const [what, setWhat] = useState<RolloutKind>("release");
  const [kind, setKind] = useState<ScopeKind>("ring");
  const [ring, setRing] = useState<number | null>(null);
  const chosenRing = ring ?? later[0]?.ring ?? options.firstRing;
  const ringItems = later.map((each) => ({
    value: each.ring,
    label: `Ring ${each.ring} (${clientsOf(each.clients)})`,
  }));
  const [newest] = options.releases;
  if (newest === undefined) {
    return (
      <Quiet>
        No release is imported yet, so there is nothing to roll out.
      </Quiet>
    );
  }
  const start = (form: FormData) => {
    void run(async () => {
      const result = await startRolloutFn({
        data: startRequestOf({
          what,
          releaseId: textOf(form, "releaseId"),
          scope: kind,
          ring: chosenRing,
          clientId: textOf(form, "clientId"),
          pastFirstRing: later.length > 0,
        }),
      });
      if (result.done !== null) {
        await navigate({
          to: "/admin/platform/rollouts/$rolloutId",
          params: { rolloutId: result.done },
        });
      }
      return result;
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        start(new FormData(event.currentTarget));
      }}
      className="flex flex-col gap-4 border-t px-5 py-4"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">What</legend>
        <div className="flex flex-wrap gap-2">
          {kinds.map((each) => (
            <Button
              key={each.value}
              type="button"
              size="sm"
              variant={what === each.value ? "default" : "outline"}
              aria-pressed={what === each.value}
              onClick={() => {
                setWhat(each.value);
              }}
            >
              {each.label}
            </Button>
          ))}
        </div>
      </fieldset>
      {what === "secrets" ? (
        <p className="text-muted-foreground">
          Each client gets the shared secrets in Secrets Store now, on the
          release it runs, all traffic at once. Copy a rotated secret there
          first with the Deploy grasp-os-ops workflow, secrets only.
        </p>
      ) : (
        <label htmlFor="rollout-release" className="flex flex-col gap-1">
          <span className="font-medium">Release</span>
          <Input
            id="rollout-release"
            name="releaseId"
            list="release-ids"
            required
            defaultValue={newest.id}
          />
          <datalist id="release-ids">
            {options.releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.notes}
              </option>
            ))}
          </datalist>
        </label>
      )}
      {later.length === 0 ? (
        <p className="text-muted-foreground">
          {`Only ring ${options.firstRing} has active clients, so this reaches only our own deployments.`}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <span id="rollout-scope" className="font-medium">
            Then
          </span>
          <Select
            items={scopes}
            value={kind}
            onValueChange={(value: ScopeKind | null) => {
              if (value !== null) {
                setKind(value);
              }
            }}
          >
            <SelectTrigger aria-labelledby="rollout-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => (
                <SelectItem key={scope.value} value={scope.value}>
                  {scope.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">
            Ring {options.firstRing} comes first, then this once you approve it.
          </span>
        </div>
      )}
      {later.length > 0 && kind === "all" ? (
        <ul className="text-muted-foreground flex flex-col gap-1">
          {options.rings.map((each) => (
            <li key={each.ring}>
              {`Ring ${each.ring}: ${clientsOf(each.clients)}`}
            </li>
          ))}
        </ul>
      ) : null}
      {later.length > 0 && kind === "ring" ? (
        <div className="flex flex-col gap-1">
          <span id="rollout-ring" className="font-medium">
            Ring
          </span>
          <Select
            items={ringItems}
            value={chosenRing}
            onValueChange={(value: number | null) => {
              if (value !== null) {
                setRing(value);
              }
            }}
          >
            <SelectTrigger aria-labelledby="rollout-ring">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ringItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {later.length > 0 && kind === "client" ? (
        <label htmlFor="rollout-client" className="flex flex-col gap-1">
          <span className="font-medium">Client</span>
          <Input
            id="rollout-client"
            name="clientId"
            list="client-ids"
            required
          />
          <datalist id="client-ids">
            {options.clientIds.map((clientId) => (
              <option key={clientId} value={clientId}>
                {names.get(clientId) ?? clientId}
              </option>
            ))}
          </datalist>
        </label>
      ) : null}
      <div className="flex items-center gap-4">
        <Button type="submit" size="sm" disabled={busy}>
          Start rollout
        </Button>
        {failure === null ? null : (
          <p role="alert" className="text-destructive">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
};

/** Every rollout, the latest first, each opening its own page. */
const EveryRollout = ({ rollouts }: { rollouts: RolloutSummary[] }) => (
  <Panel
    description="The latest first. A rollout opens its own page, where it is approved, paused, cancelled or rolled back."
    title="Every rollout"
  >
    {rollouts.length === 0 ? (
      <Quiet>No rollouts yet.</Quiet>
    ) : (
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Started (UTC)</TableHead>
              <TableHead variant="card">Release</TableHead>
              <TableHead variant="card">Status</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                Ring
              </TableHead>
              <TableHead className="hidden @2xl:table-cell" variant="card">
                Started by
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rollouts.map((rollout) => (
              <TableRow key={rollout.id}>
                <TableCell variant="card">
                  <Link
                    className="tabular-nums underline-offset-4 hover:underline"
                    params={{ rolloutId: rollout.id }}
                    to="/admin/platform/rollouts/$rolloutId"
                  >
                    {formatTime(rollout.createdAt)}
                  </Link>
                </TableCell>
                <TableCell variant="card">
                  {rollout.kind === "secrets" ? (
                    "Secrets only"
                  ) : (
                    <span className="font-mono text-xs">
                      {rollout.releaseId ?? ""}
                    </span>
                  )}
                </TableCell>
                <TableCell variant="card">
                  <span
                    className={cn(
                      rollout.status === "failed" && "text-status-attention"
                    )}
                  >
                    {rolloutStatusWords[rollout.status]}
                  </span>
                </TableCell>
                <TableCell className="hidden @xl:table-cell" variant="card">
                  <span className="tabular-nums">{rollout.ring}</span>
                </TableCell>
                <TableCell className="hidden @2xl:table-cell" variant="card">
                  <span className="text-muted-foreground">
                    {rollout.startedBy}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </Panel>
);

/**
 * Every rollout, and the form to start one: the console's Rollouts page,
 * under Platform. A rollout reaches ring 0 first, then waits for someone
 * at Grasp to approve the rest.
 */
const RolloutsPage = () => {
  const { rollouts, options } = Route.useLoaderData();
  return (
    <AdminPage
      description="A rollout takes a release, or new shared secrets, to the companies: ring 0 first, then the rest once someone at Grasp approves it."
      parents={[platformCrumb]}
      title="Rollouts"
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        <div className="scroll-mt-20" id={startRolloutId}>
          <Panel
            description="A release, or the shared secrets alone, and whom it reaches after ring 0."
            title="Start a rollout"
          >
            <StartRollout options={options} />
          </Panel>
        </div>
        <EveryRollout rollouts={rollouts} />
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/admin/platform/rollouts/")({
  loader: async () => await fetchRollouts(),
  component: RolloutsPage,
});
