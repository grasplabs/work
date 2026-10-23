/**
 * One integration to build, whole, ported from the prototype
 * (grasplabs/prototype `components/admin/integration-build.tsx`): what
 * the app is, as the agent's plan says, who asked for it, the build's
 * steps with where a person at Grasp decides, what the console knows of
 * its work, and the one action that fits where it stands. Each action is
 * a move of the build's own (src/builds/functions.ts), audited as the
 * staff member who pressed it; the page is read again after it, whether
 * it moved the build or someone else had first.
 *
 * Not here, as the console doesn't record them: a build Grasp decided
 * not to make (the prototype's Won't build), the agent's session, time,
 * cost and tests (there is no agent yet), and the release and rollout
 * after the merge.
 */
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { BuildErrorCode } from "../builds/builds.ts";
import {
  approvePlanFn,
  confirmCredentialsFn,
  requestBuildFn,
  sendBackPlanFn,
} from "../builds/functions.ts";
import type { BuildChange, BuildRecord } from "../builds/functions.ts";
import type { BuildPlan } from "../builds/plan.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { needsGrasp, stepsOf } from "./integration-builds.ts";
import type { IntegrationRow, StepState } from "./integration-builds.ts";
import {
  reasonLine,
  signInWords,
  stepLines,
  stepWords,
  waitingLine,
} from "./integration-words.ts";
import { formatDate, plural } from "./words.ts";

/** Where Grasp's code lives, so a build's pull request and merge open there. */
const repository = "https://github.com/grasplabs/work";

/** What staff read when a move on a build is refused, by its code. */
const refusals: Readonly<Record<BuildErrorCode, string>> = {
  invalid_app:
    "Grasp can’t build an app by that name yet: its key must start with a letter a to z and hold only those letters, digits and dashes, and its name be at most 64 characters.",
  unknown_build: "There’s no build of that app.",
  note_required: "Say what the next plan should change.",
  wrong_stage:
    "The build moved on since this page was read. It shows where it stands now.",
  invalid_plan: "That plan isn’t one a person may approve.",
  wrong_branch: "That pull request isn’t on the build’s own branch.",
  wrong_pull_request: "That isn’t the build’s pull request.",
};

/** A move on a build, the page read again after it either way. */
const useBuildAction = () => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const move = async (change: () => Promise<BuildChange>): Promise<void> => {
    await run(
      async () =>
        await thenRefresh(change, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  return { busy, failure, move };
};

/** Why the last move failed, under its buttons. */
const Failure = ({ failure }: { failure: string | null }) =>
  failure === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {failure}
    </p>
  );

const segment: Record<StepState | "waits", string> = {
  done: "bg-foreground",
  now: "bg-foreground/45",
  waits: "bg-status-attention",
  later: "bg-border",
};

/** The build's steps as a short bar: done, in hand, waiting on Grasp, not yet. */
export const BuildBar = ({
  row,
  label,
}: {
  row: IntegrationRow;
  label: string;
}) => {
  const waits = needsGrasp(row);
  return (
    <span className="flex w-28 gap-0.5">
      <span className="sr-only">{label}</span>
      {stepsOf(row).map((each) => (
        <span
          aria-hidden
          className={cn(
            "h-1 flex-1 rounded-full",
            segment[each.state === "now" && waits ? "waits" : each.state]
          )}
          data-step={each.state}
          key={each.step}
        />
      ))}
    </span>
  );
};

/** A part of the build's sheet under a line, with its title. */
const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3 border-b p-4">
    <h3 className="font-medium">{title}</h3>
    {children}
  </section>
);

/** A link that opens elsewhere, in a new tab. */
const OutLink = ({ href, children }: { href: string; children: string }) => (
  <a
    className="inline-flex w-fit max-w-full items-center gap-1 underline-offset-4 hover:underline"
    href={href}
    rel="noopener noreferrer"
    target="_blank"
  >
    <span className="truncate">{children}</span>
    <ExternalLinkIcon
      aria-hidden
      className="text-muted-foreground size-3.5 flex-none"
    />
    <span className="sr-only">(opens in a new tab)</span>
  </a>
);

/** The build's pull request on GitHub. */
export const pullRequestUrl = (number: number): string =>
  `${repository}/pull/${number}`;

/**
 * Build it, confirmed first: Grasp's agent works on a branch of its own,
 * against a stand-in for the app, and never sees a company's data or
 * production secrets.
 */
export const BuildIt = ({ row }: { row: IntegrationRow }) => {
  const [open, setOpen] = useState(false);
  const { busy, failure, move } = useBuildAction();
  const count = row.asks.length;
  const reach =
    count <= 1
      ? "Built once, it is there for the company that asked, and for every company after."
      : `Built once, it is there for all ${count} companies that asked, and for every company after.`;
  return (
    <>
      <Button
        className="relative"
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        Build it
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Build ${row.name} into the platform?`}</AlertDialogTitle>
            <AlertDialogDescription
              render={<div className="flex flex-col gap-2" />}
            >
              <p>
                Grasp’s agent writes the connection on a branch of its own and
                opens a pull request, which a person at Grasp reviews before
                anything is merged. You approve its plan first.
              </p>
              <p>
                {`It works against a stand-in for ${row.name}: it never sees a company’s data or production secrets.`}
              </p>
              <p>{reach}</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure failure={failure} />
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                void move(
                  async () =>
                    await requestBuildFn({
                      data: { app: row.key, name: row.name },
                    })
                );
              }}
            >
              Build it
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The plan, as a person approves it: each action reading or changing, its hosts, how it signs in, its docs. */
const PlanParts = ({ plan }: { plan: BuildPlan }) => (
  <>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">Signs in with</dt>
      <dd>{signInWords[plan.signIn]}</dd>
      <dt className="text-muted-foreground">Reaches</dt>
      <dd className="flex min-w-0 flex-col">
        {plan.hosts.map((host) => (
          <span className="truncate font-mono text-xs leading-5" key={host}>
            {host}
          </span>
        ))}
      </dd>
      <dt className="text-muted-foreground">Docs</dt>
      <dd className="flex min-w-0 flex-col">
        {plan.docs.map((doc) => (
          <OutLink href={doc} key={doc}>
            {doc.replace("https://", "")}
          </OutLink>
        ))}
      </dd>
    </dl>
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Its actions</span>
      <ul className="flex flex-col gap-2">
        {plan.actions.map((action) => (
          <li
            className="flex items-start justify-between gap-3"
            key={action.action}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-xs leading-5">
                {action.action}
              </span>
              <span className="text-pretty">{action.description}</span>
              <span className="text-muted-foreground truncate text-xs">
                {action.hosts.join(", ")}
              </span>
            </span>
            <Badge variant={action.changes ? "outline" : "secondary"}>
              {action.changes ? "Changes" : "Reads"}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  </>
);

/** Approve the plan the person read, or send it back with what to change. */
const DecidePlan = ({ build }: { build: BuildRecord }) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { busy, failure, move } = useBuildAction();
  const round = build.planRound;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            void move(
              async () =>
                await approvePlanFn({ data: { app: build.app, round } })
            );
          }}
          size="sm"
        >
          Approve the plan
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setOpen(true);
          }}
          size="sm"
          variant="outline"
        >
          Send back
        </Button>
      </div>
      <Failure failure={open ? null : failure} />
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Send the plan for ${build.name} back?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Say what the next plan should change. The agent reads it and
              writes the plan again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="What the next plan should change"
            maxLength={2000}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder="For example: only what reads employees"
            value={note}
          />
          <Failure failure={failure} />
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button
              disabled={busy || note.trim() === ""}
              onClick={() => {
                void move(
                  async () =>
                    await sendBackPlanFn({
                      data: { app: build.app, round, note },
                    })
                );
              }}
            >
              Send back
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The person says Grasp is registered with the app and its keys are in Secrets Store; the keys never pass here. */
const CredentialsAdded = ({ build }: { build: BuildRecord }) => {
  const [open, setOpen] = useState(false);
  const { busy, failure, move } = useBuildAction();
  return (
    <>
      <Button
        className="w-fit"
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        Credentials registered
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Are ${build.name}’s keys in Secrets Store?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Only say so once Grasp is registered with the app and its client
              id and secret are in the console’s Secrets Store. They are never
              typed here, and the agent never sees them: it goes on to write the
              connection against a stand-in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure failure={failure} />
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                void move(
                  async () =>
                    await confirmCredentialsFn({ data: { app: build.app } })
                );
              }}
            >
              Credentials registered
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The one thing to do where the build stands, with what a person needs to know to do it. */
const Actions = ({ row }: { row: IntegrationRow }) => {
  const { build } = row;
  if (build === null) {
    return (
      <div className="flex flex-col gap-3 border-b p-4">
        <p className="text-pretty">
          Build it starts Grasp’s agent on a branch of its own. You approve its
          plan before it writes anything.
        </p>
        <div>
          <BuildIt row={row} />
        </div>
      </div>
    );
  }
  switch (build.stage) {
    case "plan_ready": {
      return build.plan === null ? null : (
        <div className="flex flex-col gap-3 border-b p-4">
          <span className="text-muted-foreground text-xs">
            {`The agent’s plan, round ${build.planRound}`}
          </span>
          <PlanParts plan={build.plan} />
          <DecidePlan build={build} />
        </div>
      );
    }
    case "credentials": {
      return (
        <div className="flex flex-col gap-3 border-b p-4">
          <p className="text-pretty">
            {`Register Grasp as an app with ${build.name}, with a test account, and put its client id and secret in the console’s Secrets Store. The agent tests against a stand-in and never sees them.`}
          </p>
          <CredentialsAdded build={build} />
        </div>
      );
    }
    case "researching": {
      return build.planNote === null ? null : (
        <div className="flex flex-col gap-1.5 border-b p-4">
          <span className="text-muted-foreground text-xs">
            {`Plan ${build.planRound} was sent back with`}
          </span>
          <p className="text-pretty whitespace-pre-line">{build.planNote}</p>
        </div>
      );
    }
    case "in_review": {
      return build.pullRequest === null ? null : (
        <div className="flex flex-col gap-3 border-b p-4">
          <Button
            className="w-fit"
            nativeButton={false}
            render={
              <a
                aria-label={`Open pull request #${build.pullRequest}, in a new tab`}
                href={pullRequestUrl(build.pullRequest)}
                rel="noopener noreferrer"
                target="_blank"
              />
            }
            size="sm"
          >
            Open the pull request
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
        </div>
      );
    }
    case "needs_person": {
      return (
        <div className="flex flex-col gap-1.5 border-b p-4">
          <p className="text-status-attention text-pretty">
            {reasonLine(build.reason)}
          </p>
          <p className="text-muted-foreground text-xs">
            The console can’t start a stopped build again yet: look at its run
            and its branch.
          </p>
        </div>
      );
    }
    case "asked":
    case "writing":
    case "merged": {
      return null;
    }
    default: {
      return build.stage satisfies never;
    }
  }
};

/** The build's steps, in order, with where a person at Grasp decides. */
const BuildSteps = ({ row }: { row: IntegrationRow }) => {
  const steps = stepsOf(row);
  const waits = needsGrasp(row);
  return (
    <ol className="flex flex-col">
      {steps.map((each, index) => {
        const now = each.state === "now";
        let mark = "border-border border";
        if (each.state === "done") {
          mark = "bg-foreground text-background";
        } else if (now) {
          mark = waits
            ? "border-status-attention border-2"
            : "border-foreground border-2";
        }
        return (
          <li
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3"
            data-state={each.state}
            key={each.step}
          >
            <span className="flex flex-col items-center">
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 flex-none items-center justify-center rounded-full",
                  mark
                )}
              >
                {each.state === "done" ? (
                  <CheckIcon className="size-2.5" />
                ) : null}
              </span>
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "my-1 w-px flex-1",
                    each.state === "done" ? "bg-foreground" : "bg-border"
                  )}
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 pb-3">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    each.state === "later" && "text-muted-foreground",
                    now && "font-medium"
                  )}
                >
                  {stepWords[each.step]}
                </span>
                {each.person ? <Badge variant="outline">A person</Badge> : null}
              </span>
              {now ? (
                <span
                  className={cn(
                    "text-xs",
                    waits ? "text-status-attention" : "text-muted-foreground"
                  )}
                >
                  {stepLines[each.step]}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** What the agent's work has, until there is an agent to do it. */
const notYet = "Not yet";

/** A term and what the console knows of it. */
const Fact = ({ term, children }: { term: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{term}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
);

/** What the console knows of the build's work, and what waits on the agent. */
const Details = ({ build }: { build: BuildRecord }) => {
  const rounds = build.planRound;
  return (
    <Part title="Details">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact term="Started">
          {`${formatDate(build.createdAt)} by ${build.requestedBy}`}
        </Fact>
        <Fact term="Plans">
          {rounds === 0
            ? "None yet"
            : `${rounds} ${plural(rounds, "round", "rounds")}`}
        </Fact>
        <Fact term="Approved">
          {build.approvedBy === null
            ? notYet
            : `${build.approvedAt === null ? "" : `${formatDate(build.approvedAt)} by `}${build.approvedBy}`}
        </Fact>
        <Fact term="Branch">
          {build.branch === null ? (
            notYet
          ) : (
            <span className="block truncate font-mono text-xs leading-5">
              {build.branch}
            </span>
          )}
        </Fact>
        <Fact term="Pull request">
          {build.pullRequest === null ? (
            notYet
          ) : (
            <OutLink href={pullRequestUrl(build.pullRequest)}>
              {`#${build.pullRequest} on GitHub`}
            </OutLink>
          )}
        </Fact>
        <Fact term="Merged as">
          {build.mergeCommitSha === null ? (
            notYet
          ) : (
            <OutLink href={`${repository}/commit/${build.mergeCommitSha}`}>
              {build.mergeCommitSha.slice(0, 7)}
            </OutLink>
          )}
        </Fact>
        <Fact term="Agent session">{notYet}</Fact>
        <Fact term="Worked">{notYet}</Fact>
        <Fact term="Cost so far">{notYet}</Fact>
        <Fact term="Tests">{notYet}</Fact>
      </dl>
    </Part>
  );
};

/** The build's parts under its title: what to do, what it is, who asked, its steps and its details. */
export const BuildParts = ({ row }: { row: IntegrationRow }) => {
  const { build } = row;
  return (
    <>
      <Actions row={row} />
      {build?.plan === null ||
      build?.plan === undefined ||
      build.stage === "plan_ready" ? null : (
        <Part title="What it is">
          <PlanParts plan={build.plan} />
        </Part>
      )}
      <Part title="Who asked">
        {row.asks.length === 0 ? (
          <p className="text-muted-foreground">No company asks for it now.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {row.asks.map((ask) => (
              <li className="flex flex-col gap-0.5" key={ask.org}>
                <Link
                  className="w-fit font-medium underline-offset-4 hover:underline"
                  params={{ clientId: ask.org }}
                  to="/admin/organizations/$clientId/integrations"
                >
                  {ask.orgName}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {`Asked on ${formatDate(ask.on)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Part>
      <Part title="The build">
        <BuildSteps row={row} />
      </Part>
      {build === null ? null : <Details build={build} />}
    </>
  );
};

/** One app to build, whole. */
export const BuildDetail = ({ row }: { row: IntegrationRow }) => {
  const line = waitingLine(row);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{row.name}</SheetTitle>
        <SheetDescription>
          {needsGrasp(row) ? (
            <span className="text-status-attention">{line}</span>
          ) : (
            line
          )}
        </SheetDescription>
      </SheetHeader>
      <BuildParts row={row} />
    </>
  );
};
