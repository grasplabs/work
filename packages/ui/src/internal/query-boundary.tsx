import { Component } from "react";
import type { ReactNode } from "react";

// A query's failure, which the SDK's hooks throw while rendering, caught
// where it happened (a grid's rows, a relation's list), so it shows in
// that part's place rather than the whole screen's. React offers no hook
// for this; the React Compiler leaves classes as they are.

interface BoundaryProps {
  readonly children: ReactNode;
  /** What is read: when it changes (another search), it is read afresh. */
  readonly reading: string;
  /** What shows instead, and how to read again once the query was retried. */
  readonly renderFailure: (error: unknown, again: () => void) => ReactNode;
}

interface BoundaryState {
  readonly failure: { readonly error: unknown } | null;
  readonly reading: string;
}

export class QueryBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failure: null, reading: props.reading };
  }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failure: { error } };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState
  ): Partial<BoundaryState> | null {
    return props.reading === state.reading
      ? null
      : { failure: null, reading: props.reading };
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) {
      return this.props.children;
    }
    return this.props.renderFailure(failure.error, () => {
      // A class's own state: the one way out of a caught failure.
      // oxlint-disable-next-line react/no-set-state -- see above
      this.setState({ failure: null });
    });
  }
}
