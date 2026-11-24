import { ChatConcept } from "./chat-concept.tsx";
import type { Concept, ConceptProps } from "./concept-props.ts";
import { StepsConcept } from "./steps-concept.tsx";

/** The setup's first three steps as concept `concept`: a conversation, calm steps, or steps Stephen says. */
export const ConceptSetup = ({
  concept,
  ...props
}: ConceptProps & { concept: Concept }) => {
  if (concept === "a") {
    const { foot: _foot, ...rest } = props;
    return <ChatConcept {...rest} />;
  }
  return <StepsConcept {...props} speaks={concept === "c"} />;
};
