import {
  Diagram,
  type DiagramViewport,
  SvgGraphDiagram,
} from '@zukhruf/diagram';

export function FlowEffectsDiagram({
  className,
  viewport,
}: {
  className: string;
  viewport: DiagramViewport;
}) {
  return (
    <SvgGraphDiagram
      title="From question to answer"
      effects="flow"
      controls
      defaultMode="reveal"
      className={className}
      viewport={viewport}
      graph={{ colWidth: 260, rowHeight: 160 }}
    >
      <Diagram.Box id="question" row={1} col={0} accent texture="none">
        Question
      </Diagram.Box>
      <Diagram.Box id="agent" row={1} col={1} accent texture="none">
        Analysis agent
      </Diagram.Box>
      <Diagram.Box id="data" row={0} col={2} texture="none">
        Database
      </Diagram.Box>
      <Diagram.Box id="context" row={2} col={2} texture="none">
        Business context
      </Diagram.Box>
      <Diagram.Box id="answer" row={1} col={3} accent texture="none">
        Answer
      </Diagram.Box>
      <Diagram.Arrow from="question" to="agent" accent />
      <Diagram.Arrow from="agent" to="data" accent />
      <Diagram.Arrow from="agent" to="context" accent />
      <Diagram.Arrow from="data" to="answer" accent />
      <Diagram.Arrow from="context" to="answer" accent />
    </SvgGraphDiagram>
  );
}
