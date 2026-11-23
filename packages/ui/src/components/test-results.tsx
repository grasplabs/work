// TestResults: a test run an assistant made:
// a Trace with a TraceCollapsible for the run, whose line counts what passed and failed, and
// one for each suite, open when it has a failure; each test a TraceLine, a failed one opening on its
// error on the code surface.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <TestResults summary={{ passed: 12, failed: 1, skipped: 1, total: 14, duration: 1840 }}>
//     <TestResultsHeader />
//     <TestResultsContent>
//       <TestSuite name="payment.test.ts" status="failed">
//         <TestSuiteName>
//           <TestSuiteStats passed={1} failed={1} />
//         </TestSuiteName>
//         <TestSuiteContent>
//           <Test name="charges the saved card" status="passed" duration={41} />
//           <Test name="retries a declined card" status="failed">
//             <TestError>
//               <TestErrorMessage>Expected 2 charge attempts, received 1</TestErrorMessage>
//               <TestErrorStack>at retry (src/payment.test.ts:58:22)</TestErrorStack>
//             </TestError>
//           </Test>
//         </TestSuiteContent>
//       </TestSuite>
//     </TestResultsContent>
//   </TestResults>
//
// Every status is said in words as well as by its mark and colour: a failed line in red with a
// cross and Failed said after it, a skipped test's name read "Skipped …", the counts in the run's
// and the suites' lines. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CheckIcon,
  CircleMinusIcon,
  FileCodeIcon,
  FlaskConicalIcon,
  Icon,
  XIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { codeStyles } from "../lib/styles";
import { colors, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { Progress } from "./progress";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";
import type { TraceLineStatus } from "./trace";

/** Where a test or a suite stands: passed, failed, skipped, or still running. */
export type TestResultStatus = "passed" | "failed" | "skipped" | "running";

/** A run's counts, and how long it took. */
export interface TestResultsCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** In milliseconds. */
  duration?: number;
}

/** Every prop a TestResults takes. */
export interface TestResultsProps {
  /** Its TestResultsHeader, then its TestResultsContent. */
  children: ReactNode;
  /** The run's counts, which its header says ("Ran 14 tests, 2 failed"), and its duration. */
  summary?: TestResultsCounts;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open on its suites at first.
   * @default true when a test failed
   */
  defaultOpen?: boolean;
  /** Runs when the run's line opens or closes it. */
  onOpenChange?: (open: boolean) => void;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TestResultsHeader takes. */
export interface TestResultsHeaderProps {
  /**
   * What the run's line says, after the flask.
   * @default a TestResultsSummary and a TestResultsDuration
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestResultsSummary takes. */
export interface TestResultsSummaryProps {
  /**
   * The run's counts.
   * @default the summary in words, from the catalogue's testResults.ran ("Ran 14 tests, 2 failed")
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestResultsDuration takes. */
export interface TestResultsDurationProps {
  /**
   * How long the run took. Not drawn without one here or in the summary.
   * @default the summary's duration ("1.84s")
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestResultsProgress takes. */
export interface TestResultsProgressProps {
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a TestResultsContent takes. */
export interface TestResultsContentProps {
  /** What opens under the run's line: its TestSuites, or its Tests, and a TestResultsProgress. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestSuite takes. */
export interface TestSuiteProps {
  /** Its TestSuiteName, then its TestSuiteContent. */
  children: ReactNode;
  /** The suite's name: its file ("payment.test.ts"). */
  name: string;
  /** Where the suite stands: `failed` when one of its tests failed. */
  status: TestResultStatus;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open on its tests at first.
   * @default true when it failed
   */
  defaultOpen?: boolean;
  /** Runs when the suite's line opens or closes it. */
  onOpenChange?: (open: boolean) => void;
}

/** Every prop a TestSuiteName takes. */
export interface TestSuiteNameProps {
  /** What stands in the suite's line after its name: a TestSuiteStats. */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestSuiteStats takes. */
export interface TestSuiteStatsProps {
  /** @default 0 */
  passed?: number;
  /** @default 0 */
  failed?: number;
  /** @default 0 */
  skipped?: number;
  /**
   * The counts.
   * @default the counts in words, from the catalogue's testResults.stats ("3 passed, 1 failed")
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestSuiteContent takes. */
export interface TestSuiteContentProps {
  /** Its Tests. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a Test takes. */
export interface TestProps {
  /** The test's name ("retries a declined card"). */
  name: string;
  /** Where the test stands. */
  status: TestResultStatus;
  /** How long it took, in milliseconds. */
  duration?: number;
  /** What its line opens on: a TestError. Without it the test is a line that does not open. */
  children?: ReactNode;
  /**
   * Open on its error at first.
   * @default false
   */
  defaultOpen?: boolean;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestStatus takes. */
export interface TestStatusProps {
  /**
   * The test's mark.
   * @default a tick when it passed, a cross when it failed, a struck circle when skipped, a dot while it runs
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestName takes. */
export interface TestNameProps {
  /**
   * The test's name.
   * @default its name, read "Skipped …" when it was skipped
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestDuration takes. */
export interface TestDurationProps {
  /**
   * How long the test took. Not drawn without one here or on the Test.
   * @default the Test's duration ("41ms")
   */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestError takes. */
export interface TestErrorProps {
  /** Its TestErrorMessage and TestErrorStack. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestErrorMessage takes. */
export interface TestErrorMessageProps {
  /** What the assertion said ("Expected 2 charge attempts, received 1"). */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TestErrorStack takes. */
export interface TestErrorStackProps {
  /** Where it failed: the stack, as text. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  root: {
    display: "grid",
    minWidth: 0,
  },
  // A failure's error, on the code surface (codeStyles): mono text that wraps.
  error: {
    display: "grid",
    rowGap: space["2"],
  },
  errorMessage: {
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  errorStack: {
    margin: 0,
    fontFamily: "inherit",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: colors.mutedForeground,
  },
});

/** A test's mark by its status; while it runs, Trace's running dot. */
const marks: Record<TestResultStatus, IconData | null> = {
  passed: CheckIcon,
  failed: XIcon,
  skipped: CircleMinusIcon,
  running: null,
};

/** A test's or a suite's status as its line's. */
const lineStatus = (status: TestResultStatus): TraceLineStatus | undefined => {
  if (status === "failed") {
    return "error";
  }
  return status === "running" ? "running" : undefined;
};

const SummaryContext = createContext<TestResultsCounts | undefined>(undefined);
const SuiteContext = createContext<{
  name: string;
  status: TestResultStatus;
}>({ name: "", status: "passed" });
const TestContext = createContext<{
  name: string;
  status: TestResultStatus;
  duration: number | undefined;
}>({ name: "", status: "passed", duration: undefined });

/** The run's counts, in words. */
export const TestResultsSummary = ({
  children,
  style,
}: TestResultsSummaryProps) => {
  const words = useI18n().testResults;
  const summary = use(SummaryContext);
  if (children === undefined && summary === undefined) {
    return null;
  }
  return (
    <TraceTitle style={style}>
      {children ??
        (summary === undefined
          ? null
          : words.ran(summary.total, summary.failed, summary.skipped))}
    </TraceTitle>
  );
};

/** How long the run took, quiet after its counts. */
export const TestResultsDuration = ({
  children,
  style,
}: TestResultsDurationProps) => {
  const words = useI18n().testResults;
  const duration = use(SummaryContext)?.duration;
  if (children === undefined && duration === undefined) {
    return null;
  }
  return (
    <TraceDescription style={style}>
      {children ?? (duration === undefined ? null : words.duration(duration))}
    </TraceDescription>
  );
};

/** The run's line, after the flask: the trigger that opens its suites. In red when a test failed. */
export const TestResultsHeader = ({
  children,
  style,
}: TestResultsHeaderProps) => {
  const summary = use(SummaryContext);
  const failed = (summary?.failed ?? 0) > 0;
  return (
    <TraceCollapsibleTrigger style={style}>
      <TraceLine status={failed ? "error" : undefined}>
        <TraceIcon>
          <Icon icon={FlaskConicalIcon} />
        </TraceIcon>
        {children ?? (
          <>
            <TestResultsSummary />
            <TestResultsDuration />
          </>
        )}
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

/** How many tests passed of how many, as a bar: green when all did, red when one failed. */
export const TestResultsProgress = ({ style }: TestResultsProgressProps) => {
  const words = useI18n().testResults;
  const summary = use(SummaryContext);
  if (summary === undefined || summary.total === 0) {
    return null;
  }
  const label = words.progress(summary.passed, summary.total);
  return (
    <Progress
      value={summary.passed}
      max={summary.total}
      label={label}
      getAriaValueText={() => label}
      variant={summary.failed > 0 ? "destructive" : "success"}
      size="sm"
      style={style}
    />
  );
};

/** What opens under the run's line: its suites, in a Trace. */
export const TestResultsContent = ({
  children,
  style,
}: TestResultsContentProps) => (
  <TraceCollapsibleContent>
    <Trace style={style}>{children}</Trace>
  </TraceCollapsibleContent>
);

/** The suite's line, after the file's mark: the trigger that opens its tests. */
export const TestSuiteName = ({ children, style }: TestSuiteNameProps) => {
  const { name, status } = use(SuiteContext);
  return (
    <TraceCollapsibleTrigger style={style}>
      <TraceLine status={lineStatus(status)}>
        <TraceIcon>
          <Icon icon={FileCodeIcon} />
        </TraceIcon>
        <TraceTitle>{name}</TraceTitle>
        {children}
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

/** A suite's counts, quiet after its name. */
export const TestSuiteStats = ({
  passed = 0,
  failed = 0,
  skipped = 0,
  children,
  style,
}: TestSuiteStatsProps) => {
  const words = useI18n().testResults;
  return (
    <TraceDescription style={style}>
      {children ?? words.stats(passed, failed, skipped)}
    </TraceDescription>
  );
};

/** What opens under the suite's line: its tests, in a Trace. */
export const TestSuiteContent = ({
  children,
  style,
}: TestSuiteContentProps) => (
  <TraceCollapsibleContent>
    <Trace style={style}>{children}</Trace>
  </TraceCollapsibleContent>
);

/** A suite of tests: its line, opening on its tests. Open at first when it failed. */
export const TestSuite = ({
  children,
  name,
  status,
  open,
  defaultOpen,
  onOpenChange,
}: TestSuiteProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <SuiteContext value={{ name, status }}>
    <TraceCollapsible
      open={open}
      defaultOpen={defaultOpen ?? status === "failed"}
      onOpenChange={onOpenChange}
    >
      {children}
    </TraceCollapsible>
  </SuiteContext>
);

/** The test's mark: a tick, a cross, a struck circle, or the running dot. */
export const TestStatus = ({ children, style }: TestStatusProps) => {
  const { status } = use(TestContext);
  const icon = marks[status];
  return (
    <TraceIcon style={style}>
      {children ?? (icon === null ? undefined : <Icon icon={icon} />)}
    </TraceIcon>
  );
};

/** The test's name; a skipped one's says so. */
export const TestName = ({ children, style }: TestNameProps) => {
  const words = useI18n().testResults;
  const { name, status } = use(TestContext);
  return (
    <TraceTitle style={style}>
      {children ?? (status === "skipped" ? words.skipped(name) : name)}
    </TraceTitle>
  );
};

/** How long the test took, quiet after its name. */
export const TestDuration = ({ children, style }: TestDurationProps) => {
  const words = useI18n().testResults;
  const { duration } = use(TestContext);
  if (children === undefined && duration === undefined) {
    return null;
  }
  return (
    <TraceDescription style={style}>
      {children ?? (duration === undefined ? null : words.duration(duration))}
    </TraceDescription>
  );
};

/** One test: its mark, its name and its duration; a failed one opens on its error. */
export const Test = ({
  name,
  status,
  duration,
  children,
  defaultOpen = false,
  style,
}: TestProps) => {
  const line = (
    <TraceLine status={lineStatus(status)} style={style}>
      <TestStatus />
      <TestName />
      <TestDuration />
    </TraceLine>
  );
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <TestContext value={{ name, status, duration }}>
      {children === undefined ? (
        line
      ) : (
        <TraceCollapsible defaultOpen={defaultOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </TestContext>
  );
};

/** A failed test's error, on the code surface: its message, then its stack. */
export const TestError = ({ children, style }: TestErrorProps) => (
  <div
    data-slot="test-error"
    {...stylex.props(codeStyles.surface, codeStyles.text, styles.error, style)}
  >
    {children}
  </div>
);

/** What the assertion said. */
export const TestErrorMessage = ({
  children,
  style,
}: TestErrorMessageProps) => (
  <p
    data-slot="test-error-message"
    {...stylex.props(styles.errorMessage, style)}
  >
    {children}
  </p>
);

/** Where the test failed, muted under the message. */
export const TestErrorStack = ({ children, style }: TestErrorStackProps) => (
  <pre data-slot="test-error-stack" {...stylex.props(styles.errorStack, style)}>
    {children}
  </pre>
);

/** A test run: its line, opening on its suites. Open at first when a test failed. */
export const TestResults = ({
  children,
  summary,
  open,
  defaultOpen,
  onOpenChange,
  style,
}: TestResultsProps) => (
  <div data-slot="test-results" {...stylex.props(styles.root, style)}>
    <Trace>
      <SummaryContext value={summary}>
        <TraceCollapsible
          open={open}
          defaultOpen={defaultOpen ?? (summary?.failed ?? 0) > 0}
          onOpenChange={onOpenChange}
        >
          {children}
        </TraceCollapsible>
      </SummaryContext>
    </Trace>
  </div>
);
