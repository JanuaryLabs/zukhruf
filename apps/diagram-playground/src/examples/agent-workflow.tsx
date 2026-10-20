import {
  Diagram,
  type DiagramViewport,
  SvgGraphDiagram,
} from '@zukhruf/diagram';

export type AgentWorkflowDiagramProps = {
  className: string;
  viewport: DiagramViewport;
};

export function AgentWorkflowDiagram({
  className,
  viewport,
}: AgentWorkflowDiagramProps) {
  return (
    <SvgGraphDiagram
      title="Issue triage"
      showHeader={false}
      defaultMode="static"
      accent="neutral"
      className={className}
      viewport={viewport}
    >
      <Diagram.Group
        id="documentation"
        row={2}
        col={3}
        colSpan={5}
        label="DOCUMENTATION"
        labelAlign="start"
        labelSide="bottom"
        texture="hatch"
      >
        <Diagram.Box
          id="docs-change"
          row={2}
          col={4}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          <Diagram.Line>Implement</Diagram.Line>
          <Diagram.Line>docs change</Diagram.Line>
        </Diagram.Box>
      </Diagram.Group>
      <Diagram.Box
        id="issue"
        row={1}
        col={0}
        frame="filled"
        caption="Human"
        captionSide="top"
        captionFrame
      >
        Issue
      </Diagram.Box>
      <Diagram.Box
        id="identify"
        row={1}
        col={1}
        texture="none"
        caption="LLM Call"
        captionSide="top"
        captionFrame
      >
        Identify type
      </Diagram.Box>
      <Diagram.Junction id="triage-trunk" row={1} col={2} hidden />
      <Diagram.Arrow from="issue" to="identify" lineStyle="dotted" />
      <Diagram.Wire from="identify" to="triage-trunk" />
      <Diagram.Group
        id="bug"
        row={0}
        col={3}
        colSpan={5}
        label="BUG"
        labelAlign="start"
        texture="hatch"
      >
        <Diagram.Box
          id="reproduce"
          row={0}
          col={3}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          Reproduce
        </Diagram.Box>
        <Diagram.Box
          id="create-fix"
          row={0}
          col={4}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          Create fix
        </Diagram.Box>
        <Diagram.Box
          id="review-fix"
          row={0}
          col={6}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          Review fix
        </Diagram.Box>
      </Diagram.Group>
      <Diagram.Group
        id="feature"
        row={1}
        col={3}
        colSpan={5}
        label="FEATURE"
        labelAlign="start"
        texture="hatch"
      >
        <Diagram.Box
          id="analyze"
          row={1}
          col={3}
          texture="none"
          caption="Agent"
          captionSide="top"
          captionFrame
        >
          <Diagram.Line>Analyze</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="implement"
          row={1}
          col={4}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          <Diagram.Line>Implement</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="review-feature"
          row={1}
          col={5}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          <Diagram.Line>Review</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="merge"
          row={1}
          col={6}
          frame="filled"
          caption="Human"
          captionSide="top"
          captionFrame
        >
          Merge
        </Diagram.Box>
        <Diagram.Box
          id="backports"
          row={1}
          col={7}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
        >
          Backports
        </Diagram.Box>
      </Diagram.Group>
      <Diagram.Arrow from="triage-trunk" to="analyze" />
      <Diagram.Arrow
        from="triage-trunk"
        to="reproduce"
        exitSide="top"
        entrySide="left"
      />
      <Diagram.Arrow from="reproduce" to="create-fix" labelFrame>
        Reproduced
      </Diagram.Arrow>
      <Diagram.Arrow from="create-fix" to="review-fix" />
      <Diagram.Arrow
        from="review-fix"
        to="create-fix"
        lineStyle="dotted"
        exitSide="bottom"
        entrySide="bottom"
        labelFrame
      >
        Revise
      </Diagram.Arrow>
      <Diagram.Arrow from="review-fix" to="merge" />
      <Diagram.Arrow
        from="triage-trunk"
        to="docs-change"
        exitSide="bottom"
        entrySide="left"
      />
      <Diagram.Arrow
        from="docs-change"
        to="merge"
        lineStyle="dotted"
        exitSide="right"
        entrySide="bottom"
      />
      <Diagram.Arrow from="analyze" to="implement" />
      <Diagram.Arrow from="implement" to="review-feature" />
      <Diagram.Arrow
        from="review-feature"
        to="implement"
        lineStyle="dotted"
        exitSide="bottom"
        entrySide="bottom"
        labelFrame
      >
        Revise
      </Diagram.Arrow>
      <Diagram.Arrow from="review-feature" to="merge" lineStyle="dotted" />
      <Diagram.Arrow from="merge" to="backports" lineStyle="dotted" />
    </SvgGraphDiagram>
  );
}
