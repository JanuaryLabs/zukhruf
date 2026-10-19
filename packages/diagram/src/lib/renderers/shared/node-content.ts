import type { DiagramGraphIR } from '../../model/diagram-ir.ts';

export function rejectNodeContent(ir: DiagramGraphIR, output: string) {
  if (ir.nodes.some((node) => node.content !== undefined)) {
    throw new Error(
      `Diagram.Content needs HtmlGraphDiagram; ${output} draws text only.`,
    );
  }
}
