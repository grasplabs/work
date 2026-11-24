import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@grasp-os/ui/components/code-block";

// Code a workflow's page shows as it is (a run's result, a definition, a
// version's source): Damsko's code block with its language's name, or a
// file name, over it, the button that copies it exactly, and Show more
// when it is long.

export const Code = ({
  code,
  language,
  languageLabel,
  title,
  lineNumbers = false,
}: {
  code: string;
  language: string;
  /** What names the code in its header, where the language's name would not do. */
  languageLabel?: string;
  /** A file name over the code; the language's name stands without it. */
  title?: string;
  lineNumbers?: boolean;
}) => (
  <CodeBlock
    language={language}
    {...(languageLabel === undefined ? {} : { languageLabel })}
  >
    <CodeBlockHeader>
      <CodeBlockTitle>{title}</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton value={code} />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent lineNumbers={lineNumbers}>{code}</CodeBlockContent>
  </CodeBlock>
);
