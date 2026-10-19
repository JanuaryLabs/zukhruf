import { cn } from 'cn';
import { Maximize2, StretchHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { type DiagramViewport } from '@zukhruf/diagram';
import { Button } from '@zukhruf/shadcn';

import { AgentWorkflowDiagram } from './examples/agent-workflow.tsx';
import { FlowEffectsDiagram } from './examples/flow-effects.tsx';
import { HomelabReferenceDiagram } from './examples/homelab-reference.tsx';
import { RichContentDiagram } from './examples/rich-content.tsx';
import { StreamingTimelineDiagram } from './examples/streaming-timeline.tsx';

const ZOOM_LEVELS = [0.75, 1, 1.25, 1.5, 1.75] as const;
const DEFAULT_ZOOM_INDEX = 1;
type ViewportFit = NonNullable<DiagramViewport['fit']>;

type ExampleProps = { className: string; viewport: Required<DiagramViewport> };

const EXAMPLE_KEYS = [
  'homelab',
  'workflow',
  'timeline',
  'flow',
  'rich',
] as const;
type ExampleKey = (typeof EXAMPLE_KEYS)[number];

function zoomAt(index: number): number {
  const level = ZOOM_LEVELS[index];
  if (level === undefined) {
    throw new RangeError(`No zoom level at index ${index}`);
  }
  return level;
}

const EXAMPLES: Record<
  ExampleKey,
  { label: string; blurb: string; render: (props: ExampleProps) => ReactNode }
> = {
  flow: {
    label: 'Flow effects',
    blurb:
      'Signals follow the connections as a question becomes an answer. Switch modes below the diagram.',
    render: (props: ExampleProps) => <FlowEffectsDiagram {...props} />,
  },
  homelab: {
    label: 'Homelab topology',
    blurb: 'Grouped graph layout with icons, tones and routed guides.',
    render: (props: ExampleProps) => <HomelabReferenceDiagram {...props} />,
  },
  workflow: {
    label: 'Agent workflow',
    blurb: 'Swimlane graph with filled nodes and framed captions.',
    render: (props: ExampleProps) => <AgentWorkflowDiagram {...props} />,
  },
  timeline: {
    label: 'Streaming timeline',
    blurb: 'Timeline layout with boxed signals, a frame and multi-line lanes.',
    render: (props: ExampleProps) => <StreamingTimelineDiagram {...props} />,
  },
  rich: {
    label: 'Rich content',
    blurb:
      'HTML output: a box holds a real button with its own state. Natural size; scrolls when narrow.',
    render: (props: ExampleProps) => (
      <RichContentDiagram
        className={props.className}
        zoom={props.viewport.zoom}
      />
    ),
  },
};

export function Playground() {
  const [example, setExample] = useState<ExampleKey>('homelab');
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [fit, setFit] = useState<ViewportFit>('contain');
  const zoom = zoomAt(zoomIndex);
  const isFlow = example === 'flow';
  const viewport = useMemo<Required<DiagramViewport>>(
    () => ({
      fit: isFlow && fit === 'contain' ? 'width' : fit,
      zoom: fit === 'natural' ? zoom : 1,
    }),
    [fit, zoom, isFlow],
  );
  const isContain = fit === 'contain' && !isFlow;
  let diagramSizeClassName = 'w-max min-w-full';
  if (isContain) {
    diagramSizeClassName = 'h-full min-h-0 w-full';
  } else if (isFlow) {
    diagramSizeClassName = 'w-full';
  }
  let frameClassName = 'max-h-[calc(100vh-9rem)] overflow-auto';
  if (isFlow) {
    frameClassName = 'overflow-visible';
  } else if (isContain) {
    frameClassName = 'h-[calc(100vh-9rem)] min-h-[520px] overflow-hidden';
  }
  const zoomLabel =
    fit === 'contain'
      ? 'Fit'
      : fit === 'width'
        ? 'Fit width'
        : `${Math.round(zoom * 100)}%`;

  const zoomOut = () => {
    setFit('natural');
    setZoomIndex((index) => Math.max(0, index - 1));
  };

  const zoomIn = () => {
    setFit('natural');
    setZoomIndex((index) => Math.min(ZOOM_LEVELS.length - 1, index + 1));
  };

  const resetZoom = () => {
    setFit('natural');
    setZoomIndex(DEFAULT_ZOOM_INDEX);
  };

  return (
    <main className="bg-background min-h-full">
      <div className="mx-auto flex w-full max-w-[1720px] flex-col gap-4 px-4 py-4 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-foreground text-2xl font-medium text-balance">
              Diagram examples
            </h1>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm text-pretty">
              {EXAMPLES[example].blurb}
            </p>
          </div>
          <span className="border-border bg-card text-muted-foreground rounded-md border px-2.5 py-1 text-xs font-medium">
            @zukhruf/diagram svg
          </span>
        </header>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="mr-auto flex flex-wrap gap-2">
            {EXAMPLE_KEYS.map((key) => (
              <Button
                key={key}
                type="button"
                variant={key === example ? 'default' : 'outline'}
                size="sm"
                aria-pressed={key === example}
                onClick={() => setExample(key)}
              >
                {EXAMPLES[key].label}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Zoom out"
            disabled={fit === 'natural' && zoomIndex === 0}
            onClick={zoomOut}
          >
            <ZoomOut className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-20 tabular-nums"
            onClick={resetZoom}
          >
            {zoomLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Zoom in"
            disabled={fit === 'natural' && zoomIndex === ZOOM_LEVELS.length - 1}
            onClick={zoomIn}
          >
            <ZoomIn className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={fit === 'width'}
            onClick={() => setFit('width')}
          >
            <StretchHorizontal className="size-4" />
            Fit width
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={fit === 'contain'}
            onClick={() => setFit('contain')}
          >
            <Maximize2 className="size-4" />
            Fit
          </Button>
        </div>

        <section
          className={cn(
            'border-border bg-card rounded-md border p-2',
            frameClassName,
          )}
        >
          <div className={diagramSizeClassName}>
            {EXAMPLES[example].render({
              className: diagramSizeClassName,
              viewport,
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
