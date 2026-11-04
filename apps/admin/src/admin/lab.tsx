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
import type {
  Change,
  LiveGroup,
  RealFigure,
  Tally,
} from "@grasp-os/shared/admin/stephen-live";
import { meansOf, shown } from "@grasp-os/shared/lab-compare";
import type { Verdict } from "@grasp-os/shared/lab-compare";
import type { Result, Scores } from "@grasp-os/shared/lab-runs";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import { Badge } from "@grasp-os/ui/components/badge";
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

/** How a number of real people moved since the Stephen before, in a few words. */
const realChangeWords: Record<Change, string> = {
  better: "better, more than chance",
  worse: "worse, more than chance",
  "within chance": "within chance",
  "too few": "too few to say",
};

/** A real number as the page shows it: a share in percent, a rating to one decimal. */
const realValue = (figure: RealFigure, value: number | null): string => {
  if (value === null) {
    return "–";
  }
  return figure.id === "rating"
    ? oneDecimal.format(value)
    : percent.format(value);
};

/** What a real number with nothing to count yet says: ratings are optional, and a finished interview can hold no notes. */
const emptyWords: Record<RealFigure["id"], string> = {
  finished: "no interview started yet",
  kept: "no notes to count yet",
  rating: "nobody rated yet",
};

/** Where a real number comes from, and how it moved since the Stephen before. */
const realSub = (figure: RealFigure, lab: Lab): string => {
  const now = lab.live?.now.name;
  const before = lab.live?.before?.name;
  if (figure.of === 0) {
    return emptyWords[figure.id];
  }
  const held = now === undefined ? "every interview" : `with ${now}`;
  const counted =
    figure.id === "finished"
      ? held
      : `${held}, ${figure.of} ${figure.id === "rating" ? "rated" : "finished"}`;
  if (
    before === undefined ||
    figure.change === null ||
    figure.before === null
  ) {
    return counted;
  }
  return `${counted}; ${realValue(figure, figure.before)} with ${before}, ${realChangeWords[figure.change]}`;
};

/** Which Stephen people talk with now, and the one waiting in the lab. */
const inUseWords = (lab: Lab): string => {
  const inUse =
    lab.inUse === null
      ? "No interview says which Stephen held it yet."
      : `In use: ${lab.inUse.name}.`;
  const candidate =
    lab.candidate === null
      ? ""
      : ` Candidate: ${lab.candidate.name}, in the lab only.`;
  return `${inUse}${candidate}`;
};

/**
 * Where he stands in five numbers: heard and the right line at hard turns
 * in the lab, then finished, notes kept and rating with real people, each
 * against the Stephen before and saying when the change is within chance.
 */
const WhereHeStands = ({ lab }: { lab: Lab }) => (
  <section aria-label="Where he stands" className="flex flex-col gap-2">
    <p className="text-muted-foreground">{inUseWords(lab)}</p>
    <div className="bg-border grid grid-cols-1 gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-5">
      {lab.figures.length === 0 ? (
        <Figure
          label="In the lab"
          sub="No lab run is kept yet: vp run lab bench, and commit its results"
          value="–"
        />
      ) : (
        lab.figures.map((figure) => (
          <Figure
            key={figure.label}
            label={`${figure.label}, in the lab`}
            sub={changeWords(lab, figure)}
            value={percent.format(figure.value)}
          />
        ))
      )}
      {lab.realFigures.map((figure) =>
        figure.id === "finished" ? (
          <Figure
            key={figure.id}
            label="Finished, with real people"
            ring={{
              value: Math.round((figure.value ?? 0) * figure.of),
              of: figure.of,
            }}
            sub={realSub(figure, lab)}
            value={`${Math.round((figure.value ?? 0) * figure.of)} of ${figure.of}`}
          />
        ) : (
          <Figure
            key={figure.id}
            label={`${figure.label}, with real people`}
            sub={realSub(figure, lab)}
            value={realValue(figure, figure.value)}
          />
        )
      )}
    </div>
  </section>
);

/** What needs one of us, or that nothing does, each opening where it is dealt with. */
const NeedsUs = ({ needs }: { needs: readonly LabNeed[] }) =>
  needs.length === 0 ? (
    <Section description="Nothing needs us." title="Needs us" />
  ) : (
    <Section title="Needs us">
      <ul className="border-t">
        {needs.map((need) => (
          <li className="border-b last:border-b-0" key={need.id}>
            <a
              className="hover:bg-muted/50 block px-6 py-3 transition-colors"
              href={need.href}
            >
              {need.text}
            </a>
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
    id="versions"
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
      id="runs"
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

/** Who finished of who started, as a few words. */
const finishedWords = (tally: Tally | null): string =>
  tally === null || tally.started === 0
    ? "–"
    : `${tally.finished} of ${tally.started}`;

/** The average rating and how many gave one. */
const ratingWords = (tally: Tally | null): string => {
  if (tally === null || tally.ratings.length === 0) {
    return "–";
  }
  const average =
    tally.ratings.reduce((sum, rating) => sum + rating, 0) /
    tally.ratings.length;
  return `${oneDecimal.format(average)} (${tally.ratings.length})`;
};

/** One group's row: its numbers now and before, and what fell beyond chance. */
const LiveRow = ({ group }: { group: LiveGroup }) => (
  <TableRow>
    <TableCell variant="card">
      <span className="flex flex-wrap items-center gap-2">
        {group.label}
        {group.finishedFell ? (
          <Badge variant="attention">Fewer finish</Badge>
        ) : null}
        {group.ratingFell ? (
          <Badge variant="attention">Rated lower</Badge>
        ) : null}
      </span>
    </TableCell>
    <TableCell variant="card">
      <span className="tabular-nums">{finishedWords(group.now)}</span>
    </TableCell>
    <TableCell variant="card">
      <span className="tabular-nums">{finishedWords(group.before)}</span>
    </TableCell>
    <TableCell className="hidden @xl:table-cell" variant="card">
      <span className="tabular-nums">{ratingWords(group.now)}</span>
    </TableCell>
    <TableCell className="hidden @xl:table-cell" variant="card">
      <span className="tabular-nums">{ratingWords(group.before)}</span>
    </TableCell>
  </TableRow>
);

/** Live: real people group by group with the Stephen most talk with now, against the one before. */
const Live = ({ live }: { live: Lab["live"] }) => {
  if (live === null) {
    return null;
  }
  const before = live.before?.name ?? "the one before";
  return (
    <Section
      description={`Real interviews with ${live.now.name}, the Stephen most people talk with now, against ${before}: by voice or typed, lead or team member, and language. A drop is marked only when it is larger than chance, with five interviews or more on each side.`}
      id="live"
      title="Live"
    >
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Group</TableHead>
              <TableHead variant="card">{`Finished, ${live.now.name}`}</TableHead>
              <TableHead variant="card">{`Finished, ${before}`}</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                {`Rating, ${live.now.name}`}
              </TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                {`Rating, ${before}`}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {live.groups.map((group) => (
              <LiveRow group={group} key={group.id} />
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
  channel,
  results = labResults,
  scores = labScores,
}: {
  organizations: readonly Organization[];
  interviewer: Interviewer;
  now: string;
  /** Only the organizations on this release channel; every one without it. */
  channel?: string;
  results?: readonly Result[];
  scores?: readonly Scores[];
}) => {
  const read: LabOrganization[] = organizations.flatMap(({ admin, view }) =>
    view === null || (channel !== undefined && admin.client.channel !== channel)
      ? []
      : [
          {
            clientId: admin.client.id,
            name: admin.client.name,
            view,
            channel: admin.client.channel,
          },
        ]
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
    admin.state === "answered" ||
    (channel !== undefined && admin.client.channel !== channel)
      ? []
      : [admin]
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
      <Live live={lab.live} />
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
