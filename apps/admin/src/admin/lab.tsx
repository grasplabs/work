import { stephenOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { StephenStats } from "@grasp-os/shared/admin/onboarding-admin-record";
/**
 * Stephen Lab in the admin: one page for testing and improving Stephen,
 * before customers and after. The loop it serves is the same either way:
 * the lab measures a Stephen on practice companies (scripts/lab/, its runs
 * committed with the change they measured, lab-runs.ts); the change ships
 * as a release through the channels; the companies on it hold their
 * interviews with it, and their numbers, never their words (GRA-329), say
 * how he does with real people. A version is one name in both places
 * (`stephenVersion`, core's onboarding/lab-marks.ts), so the page sets
 * them side by side (`stephenLabOf`, `@grasp-os/shared/admin/stephen-lab`).
 *
 * One number for each question: where he stands in the lab against the
 * version before (a change counts only beyond chance), and how many finish
 * with real people; what needs one of us; then the versions, every
 * organization and the lab's newest runs, one click from each other.
 * Claire is a switch for the whole page, not a second copy of it.
 *
 * Not here, by design: a switch to give one company another Stephen
 * (releases and channels do that, and roll back), flags on what someone
 * said (staff read no word of an interview), and starting a lab run (it
 * needs the local stack and the gateway: `vp run lab`).
 */
import { stephenLabOf } from "@grasp-os/shared/admin/stephen-lab";
import type {
  LabHeadline,
  LabNeed,
  LabOrganization,
  LabVersion,
  StephenLab as Lab,
} from "@grasp-os/shared/admin/stephen-lab";
import { meansOf, shown } from "@grasp-os/shared/lab-compare";
import type { Verdict } from "@grasp-os/shared/lab-compare";
import type { Result, Scores } from "@grasp-os/shared/lab-runs";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link } from "@tanstack/react-router";

import { Figure } from "./interview-parts.tsx";
import { labResults, labScores } from "./lab-runs.ts";
import { EmptySection, Section } from "./section.tsx";
import { unreadWords } from "./views.ts";
import type { Organization } from "./views.ts";
import { formatList } from "./words.ts";

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const day = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** One organization's figures, by its client. */
interface Measured {
  clientId: string;
  name: string;
  stats: StephenStats;
}

/** Each organization's figures, side by side, opening its interviewers. */
const EveryOrganization = ({ measured }: { measured: readonly Measured[] }) => (
  <Section
    description="Each company’s interviews as its own Grasp counts them. A company opens its interviewers."
    title="Every organization"
  >
    <div className="@container border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">Organization</TableHead>
            <TableHead variant="card">Finished</TableHead>
            <TableHead variant="card">Rating</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Minutes
            </TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Left in
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              By voice
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              Stopped
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {measured.map(({ clientId, name, stats }) => (
            <TableRow key={clientId}>
              <TableCell variant="card">
                <Link
                  className="underline-offset-4 hover:underline"
                  params={{ clientId }}
                  search={{ tab: "interviewers" }}
                  to="/organizations/$clientId/interviews"
                >
                  {name}
                </Link>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">{`${stats.held} of ${stats.started}`}</span>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">
                  {stats.rating.count === 0
                    ? "–"
                    : `${oneDecimal.format(stats.rating.average)} (${stats.rating.count})`}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {Math.round(stats.length.employee || stats.length.lead)}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {stats.interviews > 0 ? percent.format(stats.approved) : "–"}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {stats.held > 0 ? percent.format(stats.byVoice) : "–"}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">{stats.stopped}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </Section>
);

/** What a verdict says, in a few words. */
const verdictWords: Record<Verdict, string> = {
  better: "a real change",
  worse: "a real change",
  "no difference": "within what chance moves it",
  "noise not measured": "run it twice to see what chance moves it",
  "not judged": "",
};

/** The version's name, its release name a hover away. */
const VersionName = ({ version }: { version: LabVersion }) => (
  <span
    title={
      version.release === null
        ? `Mark ${version.version}`
        : `Release name ${version.release}, mark ${version.version}`
    }
  >
    {version.name}
  </span>
);

const changeWords = (lab: Lab, headline: LabHeadline): string => {
  const { before, verdict } = headline;
  if (before === null || verdict === null) {
    return "the first version measured this way";
  }
  const points = Math.round((headline.value - before.value) * 100);
  const name =
    lab.versions.find((each) => each.version === before.version)?.name ??
    before.version;
  const signed = points > 0 ? `+${points}` : String(points);
  return `${signed} points since ${name}, ${verdictWords[verdict]}`;
};

/** One number from the lab and one from real people, each saying where it comes from. */
const WhereHeStands = ({ lab }: { lab: Lab }) => {
  const { headline, real } = lab;
  const rated =
    real.rating.count === 0
      ? "nobody rated it yet"
      : `rated ${oneDecimal.format(real.rating.average)} by ${real.rating.count}`;
  return (
    <section
      aria-label="Where he stands"
      className="bg-border grid grid-cols-1 gap-px overflow-hidden rounded-xl border sm:grid-cols-2"
    >
      <Figure
        label={
          headline === null ? "In the lab" : `${headline.label}, in the lab`
        }
        sub={
          headline === null
            ? "No lab run is kept yet: vp run lab bench, and commit its results"
            : changeWords(lab, headline)
        }
        value={headline === null ? "–" : percent.format(headline.value)}
      />
      <Figure
        label="Finished, with real people"
        ring={{ value: real.finished, of: real.started }}
        sub={real.started === 0 ? "no interview started yet" : rated}
        value={`${real.finished} of ${real.started}`}
      />
    </section>
  );
};

/** What needs one of us, or that nothing does. */
const NeedsUs = ({ needs }: { needs: readonly LabNeed[] }) =>
  needs.length === 0 ? (
    <Section description="Nothing needs us." title="Needs us" />
  ) : (
    <Section title="Needs us">
      <ul className="border-t">
        {needs.map((need) => (
          <li className="border-b px-6 py-3 last:border-b-0" key={need.id}>
            {need.text}
          </li>
        ))}
      </ul>
    </Section>
  );

/** A number of the lab, with the hidden companies' after it. */
const labCell = (
  version: LabVersion,
  metric: keyof LabVersion["lab"]
): string => {
  const standing = version.lab[metric];
  if (standing === undefined) {
    return "–";
  }
  return standing.hidden === null
    ? percent.format(standing.value)
    : `${percent.format(standing.value)} (hidden ${percent.format(standing.hidden)})`;
};

/** Every version: what the lab measured of it, and what real people did with it. */
const Versions = ({ versions }: { versions: readonly LabVersion[] }) => (
  <Section
    description="Each Stephen as the lab measured him on practice companies, and as real people met him. A change to him ships as a release; the name is the same in both places."
    title="By version"
  >
    <div className="@container border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">Version</TableHead>
            <TableHead variant="card">Heard</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Right line
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              Supported
            </TableHead>
            <TableHead variant="card">Finished</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              Rating
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              Left in
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => (
            <TableRow key={version.version}>
              <TableCell variant="card">
                <VersionName version={version} />
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">
                  {labCell(version, "heard")}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {labCell(version, "right")}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {labCell(version, "supported")}
                </span>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">
                  {version.real === null
                    ? "–"
                    : `${version.real.finished} of ${version.real.started}`}
                </span>
              </TableCell>
              <TableCell className="hidden @xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {version.real === null || version.real.rating.count === 0
                    ? "–"
                    : `${oneDecimal.format(version.real.rating.average)} (${version.real.rating.count})`}
                </span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="tabular-nums">
                  {version.real?.leftIn === null || version.real === null
                    ? "–"
                    : percent.format(version.real.leftIn)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </Section>
);

const benchWords: Record<Result["bench"], string> = {
  whole: "Whole interviews",
  notes: "Notes",
  ask: "Next line",
  draw: "Drawing",
};

/** A run's means on one line, the hidden set's as they were kept. */
const meansWords = (run: Result | Scores): string =>
  Object.entries("means" in run ? run.means : meansOf(run.cases))
    .map(([metric, value]) => `${metric} ${shown(metric, value)}`)
    .join(", ");

/** The lab's newest runs: what was run, on which set, of which Stephen. */
const Runs = ({ lab }: { lab: Lab }) => {
  if (lab.runs.length === 0) {
    return null;
  }
  const nameOf = (run: Result | Scores): string => {
    const version = run.stephen.talks;
    return (
      lab.versions.find((each) => each.version === version)?.name ?? version
    );
  };
  return (
    <Section
      description="Kept with the change each one measured. Set two side by side with vp run lab compare."
      title="Lab runs"
    >
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Run</TableHead>
              <TableHead variant="card">Version</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                Cases
              </TableHead>
              <TableHead className="hidden @2xl:table-cell" variant="card">
                Numbers
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lab.runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell variant="card">
                  {`${benchWords[run.bench]}, ${run.set === "open" ? "open" : "hidden"} · ${day.format(new Date(run.at))}`}
                </TableCell>
                <TableCell variant="card">{nameOf(run)}</TableCell>
                <TableCell className="hidden @xl:table-cell" variant="card">
                  <span className="tabular-nums">
                    {"means" in run ? run.cases : run.cases.length}
                  </span>
                </TableCell>
                <TableCell className="hidden @2xl:table-cell" variant="card">
                  {meansWords(run)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
};

/** The Lab for Stephen or Claire, across every organization and every run the lab kept. */
export const StephenLab = ({
  organizations,
  interviewer,
  now,
  results = labResults,
  scores = labScores,
}: {
  organizations: readonly Organization[];
  interviewer: Interviewer;
  now: string;
  results?: readonly Result[];
  scores?: readonly Scores[];
}) => {
  const read: LabOrganization[] = organizations.flatMap(({ admin, view }) =>
    view === null
      ? []
      : [{ clientId: admin.client.id, name: admin.client.name, view }]
  );
  const lab = stephenLabOf({
    results,
    scores,
    organizations: read,
    interviewer,
    now,
  });
  const measured: Measured[] = read.flatMap(({ clientId, name, view }) => {
    const stats = stephenOf({
      ...view,
      interviews: view.interviews.filter(
        (interview) => interview.interviewer === interviewer
      ),
    });
    return stats.started === 0 ? [] : [{ clientId, name, stats }];
  });
  const unread = organizations.flatMap(({ admin }) =>
    admin.state === "answered" ? [] : [admin]
  );
  // Read, with no interview started yet by anyone.
  const quiet = read.filter(({ view }) => view.interviews.length === 0).length;
  const notCounted = [
    quiet > 0
      ? `${quiet} ${quiet === 1 ? "organization hasn’t" : "organizations haven’t"} started interviews yet.`
      : "",
    unread.length > 0
      ? `Not read now: ${formatList(unread.map((each) => `${each.client.name} (${unreadWords(each)})`))}.`
      : "",
  ]
    .filter((line) => line !== "")
    .join(" ");
  return (
    <div className="flex flex-col gap-6 text-sm">
      <WhereHeStands lab={lab} />
      <NeedsUs needs={lab.needs} />
      {lab.versions.length === 0 ? null : <Versions versions={lab.versions} />}
      {measured.length === 0 ? (
        <EmptySection>
          No organization has started its interviews yet, so there is nothing of
          real people to show.
        </EmptySection>
      ) : (
        <EveryOrganization measured={measured} />
      )}
      <Runs lab={lab} />
      {notCounted === "" ? null : (
        <Section description={notCounted} title="Not counted" />
      )}
    </div>
  );
};
