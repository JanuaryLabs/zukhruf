import { useState } from 'react';

import { Diagram, HtmlGraphDiagram } from '@zukhruf/diagram';
import { Button } from '@zukhruf/shadcn';

export function RichContentDiagram({
  className,
  zoom,
}: {
  className: string;
  zoom: number;
}) {
  const [runs, setRuns] = useState(0);
  return (
    <HtmlGraphDiagram
      title="Ask, then run it yourself"
      defaultMode="static"
      className={className}
      viewport={{ zoom }}
      graph={{ colWidth: 260, rowHeight: 170 }}
    >
      <Diagram.Box id="question" row={0} col={0} accent>
        Question
      </Diagram.Box>
      <Diagram.Box id="agent" row={0} col={1}>
        Analysis agent
      </Diagram.Box>
      <Diagram.Box id="database" row={0} col={2} height={124} accent>
        Database
        <Diagram.Content>
          <div className="flex flex-col items-center gap-1.5">
            <Button size="sm" onClick={() => setRuns((count) => count + 1)}>
              Run query
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              {runs} {runs === 1 ? 'run' : 'runs'}
            </span>
          </div>
        </Diagram.Content>
      </Diagram.Box>
      <Diagram.Arrow from="question" to="agent" accent />
      <Diagram.Arrow from="agent" to="database" accent>
        SQL
      </Diagram.Arrow>
    </HtmlGraphDiagram>
  );
}
