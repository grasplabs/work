import type { AppVersion } from "@grasp-os/shared/apps";
import { maxFailedStarts } from "@grasp-os/shared/workflows";
import type {
  RunsPage,
  OutlineNode,
  ParamValue,
  StepOutline,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowParam,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { i18n } from "@lingui/core";
import { msg, plural, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CogIcon,
  PlayIcon,
  RepeatIcon,
  SparklesIcon,
  SplitIcon,
  UserIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import {
  NotLoadedState,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { RunsLog } from "../workflows/runs.tsx";

// One workflow: its steps in plain words, read from its code; its
// parameters as a form, for the App's builders; a Test that dry-runs it
// with the values set now; and its history, the runs and, for builders,
// the App's versions. Core checks every call; the page offers only what
// core says the person may do.

/**
 * Who does a step, as the prototype's three types say it
 * (`components/builder/flow-step.tsx`): an agent where a model answers,
 * a person where it waits for one. Plain code and waiting for time or an
 * event say neither, so they show no one.
 */
const Doer = ({ kind }: { kind: StepOutline["kind"] }) => {
  if (kind === "ai") {
    return (
      <Badge>
        <SparklesIcon data-icon="inline-start" />
        <Trans context="who does a step">Agent</Trans>
      </Badge>
    );
  }
  if (kind === "decision") {
    return (
      <Badge variant="outline">
        <UserIcon data-icon="inline-start" />
        <Trans context="who does a step">Person</Trans>
      </Badge>
    );
  }
  return null;
};

/** One step, as a card: its number, what it does, who does it, and its name. */
const StepCard = ({ step, n }: { step: StepOutline; n: number }) => {
  const { t } = useLingui();
  const { name, key } = step;
  return (
    <li className="bg-card flex flex-col gap-1.5 rounded-xl border px-4 py-3 shadow-xs">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground tabular-nums">{n}</span>
        <span className="min-w-0 flex-1 font-medium">{step.description}</span>
        <Doer kind={step.kind} />
        {step.sideEffect ? (
          <Badge variant="outline">
            <Trans>Changes something</Trans>
          </Badge>
        ) : null}
      </span>
      <span className="text-muted-foreground text-xs">
        {key === undefined ? name : t`${name}, per ${key}`}
      </span>
    </li>
  );
};

/**
 * The steps' numbers in the order they are written, through branches
 * (their steps, then what runs otherwise) and loops, as the prototype
 * numbers a workflow's steps once from first to last.
 */
const stepNumbers = (
  nodes: readonly OutlineNode[]
): ReadonlyMap<StepOutline, number> => {
  const numbers = new Map<StepOutline, number>();
  const visit = (each: readonly OutlineNode[]): void => {
    for (const node of each) {
      if (node.type === "step") {
        numbers.set(node, numbers.size + 1);
      } else {
        visit(node.steps);
        if (node.type === "branch") {
          visit(node.otherwise);
        }
      }
    }
  };
  visit(nodes);
  return numbers;
};

/** The key of an outline node among its siblings. */
const keyOf = (node: OutlineNode): string =>
  node.type === "step" ? node.name : `${node.type}:${node.line}`;

/**
 * Steps, and the branches and loops around them, in the order they run:
 * each step a card, a branch or a loop a block of its own around its
 * steps, as the prototype's overview draws them in blocks. Read only.
 */
const Outline = ({
  nodes,
  numbers,
}: {
  nodes: OutlineNode[];
  /** Each step's number, counted once through the whole workflow. */
  numbers: ReadonlyMap<StepOutline, number>;
}) => {
  const { t } = useLingui();
  return (
    <ol className="flex flex-col gap-2">
      {nodes.map((node) => {
        if (node.type === "step") {
          return (
            <StepCard
              key={keyOf(node)}
              n={numbers.get(node) ?? 0}
              step={node}
            />
          );
        }
        if (node.type === "loop") {
          return (
            <li
              className="bg-muted/50 flex flex-col gap-3 rounded-xl border border-dashed p-3"
              key={keyOf(node)}
            >
              <span className="flex items-center gap-2 font-medium">
                <RepeatIcon aria-hidden="true" className="size-4" />
                {node.header === ""
                  ? t`Repeats, once per item:`
                  : t`Repeats, ${ph({ items: node.header })}:`}
              </span>
              <Outline nodes={node.steps} numbers={numbers} />
            </li>
          );
        }
        return (
          <li
            className="bg-muted/50 flex flex-col gap-3 rounded-xl border border-dashed p-3"
            key={keyOf(node)}
          >
            {/* Core leaves the condition out for those who don't build. */}
            <span className="flex items-center gap-2 font-medium">
              <SplitIcon aria-hidden="true" className="size-4" />
              {node.condition === ""
                ? t`Only when a condition holds:`
                : t`If ${ph({ condition: node.condition })}:`}
            </span>
            <Outline nodes={node.steps} numbers={numbers} />
            {node.otherwise.length === 0 ? null : (
              <>
                <span className="font-medium">
                  <Trans>Otherwise:</Trans>
                </span>
                <Outline nodes={node.otherwise} numbers={numbers} />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
};

const Steps = ({ steps }: { steps: WorkflowDetail["steps"] }) => {
  const { t } = useLingui();
  if (!steps.ok) {
    const { message } = steps;
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        {t`The steps can't be read from this workflow's code: ${message}`}
      </p>
    );
  }
  if (steps.outline.steps.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>It has no steps.</Trans>
      </p>
    );
  }
  return (
    <Outline
      nodes={steps.outline.steps}
      numbers={stepNumbers(steps.outline.steps)}
    />
  );
};

/** How many digits after the point an amount of `currency` has. */
const fractionDigits = (currency: string | undefined): number =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "EUR",
  }).resolvedOptions().maximumFractionDigits ?? 2;

/**
 * A value as its field shows it: money in whole units of its currency
 * (core keeps minor units), anything else as it is.
 */
const shownValue = (param: WorkflowParam, value: ParamValue): string =>
  param.kind === "money" && typeof value === "number"
    ? String(value / 10 ** fractionDigits(param.currency))
    : String(value);

/**
 * What a field's text sets: money in minor units, numbers as numbers,
 * anything else as text. Core checks the value either way.
 */
const valueOf = (param: WorkflowParam, text: string): ParamValue => {
  if (param.kind === "money") {
    return Math.round(Number(text) * 10 ** fractionDigits(param.currency));
  }
  return param.kind === "number" ? Number(text) : text;
};

const isNumeric = (param: WorkflowParam): boolean =>
  param.kind === "money" || param.kind === "number";

/** An amount as typed: digits, and after a point, more of them. */
const amountPattern = /^-?\d+(?:\.(?<fraction>\d+))?$/u;

/**
 * Why a field's text isn't a value of its parameter's kind, where the page
 * can tell: an amount with more decimals than its currency has is refused,
 * never rounded. Core checks every value again.
 */
const inputError = (param: WorkflowParam, text: string): string | undefined => {
  const typed = text.trim();
  if (typed === "") {
    return undefined;
  }
  if (param.kind === "money") {
    const amount = amountPattern.exec(typed);
    if (amount === null) {
      return i18n._(msg`Enter an amount, such as 12.50.`);
    }
    const digits = fractionDigits(param.currency);
    const decimals = amount.groups?.fraction?.length ?? 0;
    if (decimals > digits) {
      const currency = param.currency ?? i18n._(msg`this currency`);
      return digits === 0
        ? i18n._(msg`An amount in ${currency} has no decimals.`)
        : i18n._(
            msg`An amount in ${currency} has at most ${plural(digits, { one: "# decimal", other: "# decimals" })}.`
          );
    }
    return undefined;
  }
  if (param.kind === "number" && Number.isNaN(Number(typed))) {
    return i18n._(msg`Enter a number.`);
  }
  return undefined;
};

/** One parameter's field, saved on its own. */
const ParamField = ({
  app,
  workflow,
  param,
  editable,
  onSaved,
}: {
  app: string;
  workflow: string;
  param: WorkflowParam;
  editable: boolean;
  onSaved: (param: WorkflowParam) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const stored = param.value ?? param.default;
  const current = shownValue(param, stored);
  const [draft, setDraft] = useState(current);
  const [saved, setSaved] = useState(false);
  const id = `param-${param.name}`;
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const invalid = inputError(param, draft);
  const fallback =
    param.currency === undefined
      ? shownValue(param, param.default)
      : `${shownValue(param, param.default)} ${param.currency}`;
  const save = async (): Promise<void> => {
    setSaved(false);
    const updated = await run(
      async (session) =>
        await session.workflows.params.set(
          app,
          workflow,
          param.name,
          valueOf(param, draft)
        )
    );
    if (updated !== undefined) {
      onSaved(updated);
      setSaved(true);
    }
  };
  return (
    <form
      aria-labelledby={labelId}
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <span className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor={id} id={labelId}>
          {param.label}
        </label>
        {param.sensitive ? (
          <Badge variant="destructive">
            <Trans>Sensitive</Trans>
          </Badge>
        ) : null}
      </span>
      <div className="flex gap-2">
        <Input
          aria-describedby={invalid === undefined ? undefined : errorId}
          aria-invalid={invalid !== undefined}
          disabled={!editable}
          id={id}
          inputMode={isNumeric(param) ? "decimal" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          value={draft}
        />
        {editable ? (
          <Button
            // By value, not text: "5000.0" is the 5000 already set.
            disabled={
              busy ||
              draft.trim() === "" ||
              invalid !== undefined ||
              valueOf(param, draft) === stored
            }
            type="submit"
          >
            <Trans>Save</Trans>
          </Button>
        ) : null}
      </div>
      {invalid === undefined ? null : (
        <p className="text-destructive text-sm" id={errorId}>
          {invalid}
        </p>
      )}
      <span className="text-muted-foreground text-xs">
        {t`Default: ${fallback}`}
      </span>
      {saved ? (
        <output className="text-sm">
          <Trans>Saved.</Trans>
        </output>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

const Parameters = ({
  app,
  workflow,
  params,
  editable,
}: {
  app: string;
  workflow: string;
  params: WorkflowParam[];
  editable: boolean;
}) => {
  // What core returned for each parameter saved here, over what the page
  // loaded with; each field keeps its own text.
  const [saved, setSaved] = useState<ReadonlyMap<string, WorkflowParam>>(
    new Map()
  );
  const { t } = useLingui();
  if (params.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>It has no parameters.</Trans>
      </p>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        {editable
          ? t`A change applies to runs that start after it: runs already going keep the values they started with. Each change is recorded, without its value.`
          : t`Grasp staff can read parameters, not change them.`}
      </p>
      {params.map((loaded) => (
        <ParamField
          app={app}
          editable={editable}
          key={loaded.name}
          onSaved={(param) => {
            setSaved((previous) => new Map([...previous, [param.name, param]]));
          }}
          param={saved.get(loaded.name) ?? loaded}
          workflow={workflow}
        />
      ))}
    </div>
  );
};

/** Dry-runs the workflow, and shows what each of its tests' runs did. */
const TestButton = ({ app, workflow }: { app: string; workflow: string }) => {
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [tested, setTested] = useState<WorkflowDryRun>();
  const { t } = useLingui();
  const test = async (): Promise<void> => {
    setOpen(true);
    setTested(undefined);
    const result = await run(
      async (session) => await session.workflows.test(app, workflow)
    );
    setTested(result);
  };
  return (
    <>
      <Button
        disabled={busy}
        onClick={() => {
          void test();
        }}
        variant="outline"
      >
        <PlayIcon data-icon="inline-start" />
        {busy ? t`Testing…` : t`Test`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-svh overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t`Test of ${workflow}`}</DialogTitle>
            <DialogDescription>
              <Trans>
                Runs the workflow&apos;s own test cases with the values set now.
                Nothing is changed: what it would change is listed instead.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          {busy ? (
            <p className="text-sm">
              <Trans>Testing…</Trans>
            </p>
          ) : null}
          <ErrorText>{failure}</ErrorText>
          {tested === undefined ? null : <DryRunReports tested={tested} />}
        </DialogContent>
      </Dialog>
    </>
  );
};

const DryRunReports = ({ tested }: { tested: WorkflowDryRun }) => {
  const { t } = useLingui();
  const { version } = tested;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t`Version ${version}`}</p>
      {tested.runs.map((dryRun, index) => (
        // Tests may share a name; their order is the tests' own.
        <section
          className="flex flex-col gap-2"
          key={`${index}:${dryRun.name}`}
        >
          <h3 className="font-medium">
            {dryRun.status === "completed"
              ? t`${ph({ run: dryRun.name })}: completed`
              : t`${ph({ run: dryRun.name })}: failed`}
          </h3>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
            {dryRun.report}
          </pre>
        </section>
      ))}
    </div>
  );
};

const Versions = ({ versions }: { versions: Loaded<AppVersion[]> }) => {
  if (versions.state !== "ready") {
    return <NotLoaded page={versions} />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Version</Trans>
          </TableHead>
          <TableHead>
            <Trans>What changed</Trans>
          </TableHead>
          <TableHead>
            <Trans>Committed</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.data.map((version) => (
          <TableRow key={version.version}>
            <TableCell>{version.version}</TableCell>
            <TableCell>{version.message}</TableCell>
            <TableCell>{formatDateTime(version.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const WorkflowView = ({
  detail,
  runs,
  versions,
  model,
}: {
  detail: WorkflowDetail;
  runs: Loaded<RunsPage>;
  versions: Loaded<AppVersion[]> | undefined;
  model: string | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const { summary, steps, params, setsParams } = detail;
  const { t } = useLingui();
  const { version } = summary;
  const owner = summary.owner.name ?? summary.owner.userId;
  // As many as core sent, "+" where it had more.
  const runCount =
    runs.state === "ready" && runs.data.runs.length > 0
      ? `${runs.data.runs.length}${runs.data.more ? "+" : ""}`
      : undefined;
  return (
    <Tabs defaultValue="steps">
      {/* As the prototype's workflow page: the title with where it is and
          who owns it, its one action beside it, and the tabs under them. */}
      <div className="flex flex-col gap-3 border-b px-6 pt-5">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="flex min-w-0 grow basis-96 flex-col gap-2">
            <h1 className="text-2xl font-medium tracking-tight">
              {summary.workflow}
            </h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2">
              <Badge
                render={
                  <Link
                    params={{ engine: summary.app }}
                    to="/engines/$engine"
                  />
                }
                variant="outline"
              >
                <CogIcon data-icon="inline-start" />
                {summary.appName}
              </Badge>
              <Badge variant="outline">
                <Trans>Version {version}</Trans>
              </Badge>
              <span className="text-xs">
                {summary.owner.userId === identity.userId
                  ? t`Owned by you`
                  : t`Owned by ${owner}`}
              </span>
            </div>
            {summary.scheduleStopped ? (
              <p className="text-destructive">
                {t`Its schedule stopped: its run failed to start ${maxFailedStarts} times in a row. It starts again when its schedule is set under Parameters, or when a new version of the App is made current.`}
              </p>
            ) : null}
          </div>
          {params === null ? null : (
            <TestButton app={summary.app} workflow={summary.workflow} />
          )}
        </div>
        <TabsList variant="line">
          <TabsTrigger value="steps">
            <Trans context="tab of a workflow">Steps</Trans>
          </TabsTrigger>
          {params === null ? null : (
            <TabsTrigger value="parameters">
              <Trans context="tab of a workflow">Parameters</Trans>
            </TabsTrigger>
          )}
          <TabsTrigger value="runs">
            <Trans context="tab listing the runs of workflows">Runs</Trans>
            {runCount === undefined ? null : (
              <span className="text-muted-foreground tabular-nums">
                {" "}
                {runCount}
              </span>
            )}
          </TabsTrigger>
          {versions === undefined ? null : (
            <TabsTrigger value="versions">
              <Trans context="tab of a workflow">Versions</Trans>
            </TabsTrigger>
          )}
        </TabsList>
      </div>
      <TabsContent value="steps">
        <div className="mx-auto w-full max-w-5xl p-6">
          <Steps steps={steps} />
        </div>
      </TabsContent>
      {/* Kept while another tab shows: what was saved or typed stays. */}
      {params === null ? null : (
        <TabsContent keepMounted value="parameters">
          <div className="mx-auto w-full max-w-5xl p-6">
            <Parameters
              app={summary.app}
              editable={setsParams}
              params={params}
              workflow={summary.workflow}
            />
          </div>
        </TabsContent>
      )}
      <TabsContent value="runs">
        <div className="mx-auto w-full max-w-5xl p-6">
          {runs.state === "ready" ? (
            <RunsLog
              me={identity.userId}
              model={model}
              more={runs.data.more}
              runs={runs.data.runs}
              withWorkflow={false}
            />
          ) : (
            <NotLoadedState page={runs} />
          )}
        </div>
      </TabsContent>
      {versions === undefined ? null : (
        <TabsContent value="versions">
          <div className="mx-auto w-full max-w-5xl p-6">
            <Versions versions={versions} />
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
};

const WorkflowPage = () => {
  const { detail, runs, versions, model } = Route.useLoaderData();
  const { app, workflow } = Route.useParams();
  const { t } = useLingui();
  const crumbs = [
    { label: t`Workflows`, to: "/workflows" },
    { label: workflow },
  ] as const;
  if (detail.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={crumbs}
        icon={WorkflowIcon}
        notFound={t`Workflow not found`}
        page={detail}
      />
    );
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex flex-col text-sm">
        <WorkflowView
          // Another workflow starts with its own forms and test.
          key={`${app}/${workflow}`}
          detail={detail.data}
          model={model}
          runs={runs}
          versions={versions}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$app/$workflow")({
  pendingComponent: PageLoading,
  // The workflow and its runs are read on their own, and the App's
  // versions only for those who build it: each says on its own why it
  // failed.
  loader: async ({ context: { core }, params: { app, workflow } }) => {
    const [detail, runs, models] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflows.get(app, workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflows.runs({ app, workflow })
      ),
      // The model a fix in chat asks with; without one, none is offered.
      loadFromCore(core, async (session) => await session.chats.models()),
    ]);
    const builds = detail.state === "ready" && detail.data.params !== null;
    const versions = builds
      ? await loadFromCore(
          core,
          async (session) => await session.apps.versions.list(app)
        )
      : undefined;
    return {
      detail,
      runs,
      versions,
      model: models.state === "ready" ? models.data[0] : undefined,
    };
  },
  component: WorkflowPage,
});
