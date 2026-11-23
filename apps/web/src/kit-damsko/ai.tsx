import {
  Attachment,
  AttachmentContent,
  AttachmentGroup,
  AttachmentTitle,
} from "@grasp-os/ui/components/attachment";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@grasp-os/ui/components/chain-of-thought";
import { Chat, ChatMessage, ChatMessages } from "@grasp-os/ui/components/chat";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@grasp-os/ui/components/confirmation";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextTrigger,
} from "@grasp-os/ui/components/context";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
  InlineCitationText,
} from "@grasp-os/ui/components/inline-citation";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@grasp-os/ui/components/marker";
import { Message, MessageContent } from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@grasp-os/ui/components/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@grasp-os/ui/components/prompt-input";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@grasp-os/ui/components/reasoning";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@grasp-os/ui/components/sources";
import {
  StackTrace,
  StackTraceContent,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceFrames,
  StackTraceHeader,
} from "@grasp-os/ui/components/stack-trace";
import { Suggestion, Suggestions } from "@grasp-os/ui/components/suggestion";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
} from "@grasp-os/ui/components/terminal";
import {
  Test,
  TestResults,
  TestResultsContent,
  TestResultsHeader,
  TestResultsSummary,
  TestSuite,
  TestSuiteContent,
  TestSuiteName,
} from "@grasp-os/ui/components/test-results";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@grasp-os/ui/components/tool";
import { Trace, TraceLine, TraceTitle } from "@grasp-os/ui/components/trace";
import { Icon, SearchIcon } from "@grasp-os/ui/lib/icons";

import type { Demos } from "./demo.ts";

// Damsko's AI components, one small use of each, for the local gallery
// (routes/kit_.damsko.tsx).

const noop = (): void => {
  // A demo's control does nothing.
};

const trace = `TypeError: Cannot read properties of undefined (reading 'name')
    at reportName (src/report.ts:12:18)
    at render (src/page.tsx:40:5)`;

export const aiDemos: Demos = {
  attachment: () => (
    <AttachmentGroup aria-label="Files to send">
      <Attachment>
        <AttachmentContent>
          <AttachmentTitle>pricing-2026.pdf</AttachmentTitle>
        </AttachmentContent>
      </Attachment>
    </AttachmentGroup>
  ),
  bubble: () => (
    <Bubble variant="secondary">
      <BubbleContent>Where is the pricing brief?</BubbleContent>
    </Bubble>
  ),
  "chain-of-thought": () => (
    <ChainOfThought>
      <ChainOfThoughtHeader>Searched once and read a file</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        <ChainOfThoughtStep description="pricing" label="Searched the drive" />
        <ChainOfThoughtStep label="Read pricing-2026.pdf" />
      </ChainOfThoughtContent>
    </ChainOfThought>
  ),
  chat: () => (
    <div className="h-40">
      <Chat>
        <ChatMessages>
          <ChatMessage messageId="one">
            <Message>
              <MessageContent>The brief is in the drive.</MessageContent>
            </Message>
          </ChatMessage>
        </ChatMessages>
      </Chat>
    </div>
  ),
  confirmation: () => (
    <Confirmation approval={{ id: "move" }} state="approval-requested">
      <ConfirmationTitle>
        <ConfirmationRequest>Move 3 reports into Archive.</ConfirmationRequest>
      </ConfirmationTitle>
      <ConfirmationActions>
        <ConfirmationAction onClick={noop}>Approve</ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  ),
  context: () => (
    <Context maxTokens={128_000} usedTokens={42_000}>
      <ContextTrigger />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextInputUsage />
        </ContextContentBody>
      </ContextContent>
    </Context>
  ),
  "inline-citation": () => (
    <InlineCitation>
      <InlineCitationText>Prices rose 4% this year.</InlineCitationText>
      <InlineCitationCard>
        <InlineCitationCardTrigger sources={["https://example.com/prices"]} />
        <InlineCitationCardBody>
          <InlineCitationSource
            title="Prices in 2026"
            url="https://example.com/prices"
          />
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  ),
  marker: () => (
    <Marker variant="border">
      <MarkerIcon>
        <Icon icon={SearchIcon} />
      </MarkerIcon>
      <MarkerContent>Searched 8 related files</MarkerContent>
    </Marker>
  ),
  message: () => (
    <Message align="end">
      <MessageContent>Summarise the comments.</MessageContent>
    </Message>
  ),
  "message-scroller": () => (
    <div className="h-24">
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem>
                <Bubble variant="secondary">
                  <BubbleContent>A first message.</BubbleContent>
                </Bubble>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  ),
  "model-selector": () => (
    <ModelSelector>
      <ModelSelectorTrigger>Small</ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorList>
          <ModelSelectorItem value="small">
            <ModelSelectorName>Small</ModelSelectorName>
          </ModelSelectorItem>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  ),
  "prompt-input": () => (
    <PromptInput onSubmit={noop}>
      <PromptInputBody>
        <PromptInputTextarea placeholder="Ask anything" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputSubmit />
      </PromptInputFooter>
    </PromptInput>
  ),
  questionnaire: () => (
    <Questionnaire onSubmit={noop}>
      <QuestionnaireItem name="when">
        <QuestionnaireTitle>When should it run?</QuestionnaireTitle>
        <QuestionnaireChoices>
          <QuestionnaireChoice value="monday">Every Monday</QuestionnaireChoice>
          <QuestionnaireChoice value="daily">Every day</QuestionnaireChoice>
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnaireSubmit>Send</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  ),
  reasoning: () => (
    <Reasoning>
      <ReasoningTrigger />
      <ReasoningContent>The brief names two prices.</ReasoningContent>
    </Reasoning>
  ),
  sources: () => (
    <Sources>
      <SourcesTrigger count={1} />
      <SourcesContent>
        <Source href="https://example.com/prices" title="Prices in 2026" />
      </SourcesContent>
    </Sources>
  ),
  "stack-trace": () => (
    <StackTrace trace={trace}>
      <StackTraceHeader>
        <StackTraceError>
          <StackTraceErrorType />
          <StackTraceErrorMessage />
        </StackTraceError>
      </StackTraceHeader>
      <StackTraceContent>
        <StackTraceFrames />
      </StackTraceContent>
    </StackTrace>
  ),
  suggestion: () => (
    <Suggestions>
      <Suggestion onClick={noop} suggestion="Summarise the comments" />
    </Suggestions>
  ),
  terminal: () => (
    <Terminal output={"$ vp run check:ui\npackages/ui is Damsko's"}>
      <TerminalHeader>
        <TerminalTitle />
      </TerminalHeader>
      <TerminalContent />
    </Terminal>
  ),
  "test-results": () => (
    <TestResults summary={{ passed: 1, failed: 0, skipped: 0, total: 1 }}>
      <TestResultsHeader>
        <TestResultsSummary />
      </TestResultsHeader>
      <TestResultsContent>
        <TestSuite name="ui-sync" status="passed">
          <TestSuiteName />
          <TestSuiteContent>
            <Test
              name="finds nothing when every file is Damsko's"
              status="passed"
            />
          </TestSuiteContent>
        </TestSuite>
      </TestResultsContent>
    </TestResults>
  ),
  tool: () => (
    <Tool>
      <ToolHeader name="search" state="output-available" />
      <ToolContent>
        <ToolInput input={{ query: "pricing" }} />
        <ToolOutput errorText={undefined} output="2 files" />
      </ToolContent>
    </Tool>
  ),
  trace: () => (
    <Trace>
      <TraceLine>
        <TraceTitle>Read pricing-2026.pdf</TraceTitle>
      </TraceLine>
    </Trace>
  ),
};
