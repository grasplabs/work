import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@grasp-os/ui/components/code-block";

// A value as JSON, as the Inbox and a decision's page show what a run
// passed or what a start begins with: all of it, wrapped, its lines
// numbered, with its title (or the language's name) and a copy button
// over it.

export const JsonBlock = ({
  value,
  title,
}: {
  value: unknown;
  /** What it is ("What it starts with"); the language's name stands alone without one. */
  title?: string;
}) => {
  const json = JSON.stringify(value, undefined, 2);
  return (
    <CodeBlock language="json" size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={json} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap>
        {json}
      </CodeBlockContent>
    </CodeBlock>
  );
};
