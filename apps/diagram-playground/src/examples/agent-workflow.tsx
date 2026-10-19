import {
  Diagram,
  type DiagramViewport,
  SvgGraphDiagram,
} from '@zukhruf/diagram';

export type AgentWorkflowDiagramProps = {
  className: string;
  viewport: DiagramViewport;
};

const ROW_H = 300;
const NODE_H = 100;
const NODE_FONT = 16;
const CAPTION_FONT = 13;

const LANE_COL_START = 3;
const LANE_COL_END = 7;
const LANE_PAD_X = 24;

const BUG = 0;
const FEATURE = 1;
const DOCS = 2;

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
      graph={{
        columns: [200, 300, 110, 300, 300, 300, 260, 300],
        rowHeight: ROW_H,
      }}
    >
      <Diagram.Group
        id="bug"
        label="BUG"
        labelAlign="start"
        texture="hatch"
        rowStart={BUG}
        rowEnd={BUG}
        colStart={LANE_COL_START}
        colEnd={LANE_COL_END}
        tightY
        // tightY fits the node boxes only, so the bottom padding is what keeps
        // the Revise return route inside the lane. Re-measure it if that edge's
        // stubDistance changes.
        padding={{ top: 64, right: LANE_PAD_X, bottom: 84, left: LANE_PAD_X }}
      >
        <Diagram.Box
          id="reproduce"
          row={BUG}
          col={3}
          width={260}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          Reproduce
        </Diagram.Box>
        <Diagram.Box
          id="create-fix"
          row={BUG}
          col={4.5}
          width={260}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          Create fix
        </Diagram.Box>
        <Diagram.Box
          id="review-fix"
          row={BUG}
          col={6}
          width={260}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          Review fix
        </Diagram.Box>
      </Diagram.Group>

      <Diagram.Group
        id="feature"
        label="FEATURE"
        labelAlign="start"
        texture="hatch"
        rowStart={FEATURE}
        rowEnd={FEATURE}
        colStart={LANE_COL_START}
        colEnd={LANE_COL_END}
        tightY
        padding={{ top: 64, right: LANE_PAD_X, bottom: 82, left: LANE_PAD_X }}
      >
        <Diagram.Box
          id="analyze"
          row={FEATURE}
          col={3}
          width={185}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          <Diagram.Line>Analyze</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="implement"
          row={FEATURE}
          col={4}
          width={260}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          <Diagram.Line>Implement</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="review-feature"
          row={FEATURE}
          col={5}
          width={250}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          <Diagram.Line>Review</Diagram.Line>
          <Diagram.Line>feature</Diagram.Line>
        </Diagram.Box>
        <Diagram.Box
          id="merge"
          row={FEATURE}
          col={6}
          width={175}
          height={NODE_H}
          fontSize={NODE_FONT}
          frame="filled"
          caption="Human"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          Merge
        </Diagram.Box>
        <Diagram.Box
          id="backports"
          row={FEATURE}
          col={7}
          width={250}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          Backports
        </Diagram.Box>
      </Diagram.Group>

      <Diagram.Group
        id="documentation"
        label="DOCUMENTATION"
        labelAlign="start"
        labelSide="bottom"
        texture="hatch"
        rowStart={DOCS}
        rowEnd={DOCS}
        colStart={LANE_COL_START}
        colEnd={LANE_COL_END}
        tightY
        padding={{ top: 64, right: LANE_PAD_X, bottom: 64, left: LANE_PAD_X }}
      >
        <Diagram.Box
          id="docs-change"
          row={DOCS}
          col={4}
          width={260}
          height={NODE_H}
          fontSize={NODE_FONT}
          texture="none"
          caption="Workspace agent"
          captionSide="top"
          captionFrame
          captionFontSize={CAPTION_FONT}
        >
          <Diagram.Line>Implement</Diagram.Line>
          <Diagram.Line>docs change</Diagram.Line>
        </Diagram.Box>
      </Diagram.Group>

      <Diagram.Box
        id="issue"
        row={FEATURE}
        col={0}
        width={130}
        height={NODE_H}
        fontSize={NODE_FONT}
        frame="filled"
        caption="Human"
        captionSide="top"
        captionFrame
        captionFontSize={CAPTION_FONT}
      >
        Issue
      </Diagram.Box>
      <Diagram.Box
        id="identify"
        row={FEATURE}
        col={1}
        width={240}
        height={NODE_H}
        fontSize={NODE_FONT}
        texture="none"
        caption="LLM Call"
        captionSide="top"
        captionFrame
        captionFontSize={CAPTION_FONT}
      >
        Identify type
      </Diagram.Box>

      <Diagram.Junction
        id="triage-trunk"
        row={FEATURE}
        col={2}
        width={1}
        height={1}
        hidden
      />
      <Diagram.Guide
        id="merge-rail"
        orientation="vertical"
        target="merge"
        anchor="center"
      />

      <Diagram.Arrow from="issue" to="identify" lineStyle="dotted" />

      <Diagram.Wire
        from="identify"
        to="triage-trunk"
        exitSide="right"
        entrySide="left"
        entryGap={0}
        route="straight"
      />
      <Diagram.Arrow
        from="triage-trunk"
        to="reproduce"
        exitSide="top"
        entrySide="left"
      />
      <Diagram.Arrow
        from="triage-trunk"
        to="analyze"
        exitSide="right"
        entrySide="left"
        route="straight"
      />
      <Diagram.Arrow
        from="triage-trunk"
        to="docs-change"
        exitSide="bottom"
        entrySide="left"
      />

      <Diagram.Arrow
        from="reproduce"
        to="create-fix"
        labelFrame
        labelFontSize={CAPTION_FONT}
        labelT={0.5}
      >
        Reproduced
      </Diagram.Arrow>
      <Diagram.Arrow from="create-fix" to="review-fix" />
      <Diagram.Arrow
        from="review-fix"
        to="create-fix"
        lineStyle="dotted"
        exitSide="bottom"
        entrySide="bottom"
        stubDistance={58}
        labelFrame
        labelFontSize={CAPTION_FONT}
        labelT={0.5}
      >
        Revise
      </Diagram.Arrow>

      <Diagram.Arrow from="analyze" to="implement" />
      <Diagram.Arrow from="implement" to="review-feature" />
      <Diagram.Arrow
        from="review-feature"
        to="implement"
        lineStyle="dotted"
        exitSide="bottom"
        entrySide="bottom"
        stubDistance={58}
        labelFrame
        labelFontSize={CAPTION_FONT}
        labelT={0.5}
      >
        Revise
      </Diagram.Arrow>
      <Diagram.Arrow from="review-feature" to="merge" lineStyle="dotted" />
      <Diagram.Arrow from="merge" to="backports" lineStyle="dotted" />

      <Diagram.Arrow
        from="review-fix"
        to="merge"
        exitSide="bottom"
        exitOffset={0}
        entrySide="top"
        route="straight"
      />
      <Diagram.Arrow
        from="docs-change"
        to="merge"
        lineStyle="dotted"
        exitSide="right"
        entrySide="bottom"
      >
        <Diagram.Waypoint
          guide="merge-rail"
          target="docs-change"
          anchor="right"
        />
        <Diagram.Waypoint guide="merge-rail" target="merge" anchor="bottom" />
      </Diagram.Arrow>
    </SvgGraphDiagram>
  );
}
