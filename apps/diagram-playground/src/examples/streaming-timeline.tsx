import {
  Diagram,
  type DiagramViewport,
  SvgTimelineDiagram,
} from '@zukhruf/diagram';

export type StreamingTimelineDiagramProps = {
  className: string;
  viewport: DiagramViewport;
};

export function StreamingTimelineDiagram({
  className,
  viewport,
}: StreamingTimelineDiagramProps) {
  return (
    <SvgTimelineDiagram
      title="Durable stream handoff"
      showHeader={false}
      defaultMode="static"
      className={className}
      viewport={viewport}
    >
      <Diagram.Lane id="browser">BROWSER</Diagram.Lane>
      <Diagram.Lane id="request" accent>
        <Diagram.Line>API</Diagram.Line>
        <Diagram.Line>REQUEST</Diagram.Line>
      </Diagram.Lane>
      <Diagram.Lane id="model">MODEL</Diagram.Lane>

      <Diagram.Signal from="browser" to="request" accent boxed>
        POST message
      </Diagram.Signal>
      <Diagram.Signal from="request" to="model" accent boxed>
        <Diagram.Line>Generate with</Diagram.Line>
        <Diagram.Line>durable stream</Diagram.Line>
      </Diagram.Signal>
      <Diagram.Signal from="browser" to="request" dim>
        Disconnect
      </Diagram.Signal>
      <Diagram.Signal from="model" to="request" dim>
        <Diagram.Line>Output continues</Diagram.Line>
        <Diagram.Line>without the client</Diagram.Line>
      </Diagram.Signal>

      <Diagram.Frame label="ON RECONNECT">
        <Diagram.Signal from="browser" to="request" accent boxed>
          Replay from cursor
        </Diagram.Signal>
      </Diagram.Frame>
    </SvgTimelineDiagram>
  );
}
