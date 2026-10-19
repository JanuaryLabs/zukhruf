import {
  type MotionValue,
  cancelFrame,
  frame as motionFrame,
} from 'motion/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { Gpu } from 'vgpu';

import type { RoutedEdge } from '../../layouts/graph/graph-layout.ts';
import type { Box } from '../../model/diagram-ir.ts';
import { type DiagramMode, useDiagramTheme } from '../../react/chrome/theme.ts';
import { flowShader } from './flow-shader.ts';

type FlowEdge = RoutedEdge & {
  index: number;
  segment: { start: number; end: number };
};

type FlowEffectsProps = {
  edges: FlowEdge[];
  viewBox: Box;
  progress: MotionValue<number>;
  mode: DiagramMode;
  playhead?: MotionValue<number> | undefined;
};

// Activation changes SVG node styling, but must not recreate the GPU device.
export const GraphFlowEffects = memo(
  GraphFlowEffectsCanvas,
  (a, b) =>
    a.progress === b.progress &&
    a.playhead === b.playhead &&
    a.mode === b.mode &&
    a.viewBox.x === b.viewBox.x &&
    a.viewBox.y === b.viewBox.y &&
    a.viewBox.w === b.viewBox.w &&
    a.viewBox.h === b.viewBox.h &&
    a.edges.length === b.edges.length &&
    a.edges.every((edge, i) => {
      const other = b.edges[i];
      return (
        other !== undefined &&
        edge.d === other.d &&
        edge.index === other.index &&
        edge.segment.start === other.segment.start &&
        edge.segment.end === other.segment.end &&
        edge.edge.direction === other.edge.direction &&
        edge.edge.headless === other.edge.headless &&
        edge.edge.dim === other.edge.dim
      );
    }),
);

function segmentData(edges: FlowEdge[]) {
  const values: number[] = [];
  edges.forEach(({ edge, d, segment, index }) => {
    if (edge.headless || edge.direction === 'none') return;
    // Sample the SVG's actual rounded path once when uploading the GPU mesh.
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    const pathLength = path.getTotalLength();
    const steps = Math.max(1, Math.ceil(pathLength / 4));
    const [first, ...rest] = Array.from({ length: steps + 1 }, (_, i) =>
      path.getPointAtLength((i / steps) * pathLength),
    );
    if (!first) return;
    const pieces: { from: DOMPoint; to: DOMPoint; length: number }[] = [];
    let from = first;
    for (const to of rest) {
      pieces.push({
        from,
        to,
        length: Math.hypot(to.x - from.x, to.y - from.y),
      });
      from = to;
    }
    const total = pieces.reduce((sum, { length }) => sum + length, 0);
    let distance = 0;
    pieces.forEach(({ from, to, length }) => {
      if (length === 0) return;
      for (
        let reverse = 0;
        reverse < (edge.direction === 'both' ? 2 : 1);
        reverse++
      ) {
        values.push(
          from.x,
          from.y,
          to.x,
          to.y,
          distance,
          length,
          total,
          reverse,
          segment.start,
          segment.start + (segment.end - segment.start) * 0.85,
          index,
          edge.dim ? 0.45 : 1,
        );
      }
      distance += length;
    });
  });
  return new Float32Array(values);
}

function GraphFlowEffectsCanvas({
  edges,
  viewBox,
  progress,
  mode,
  playhead,
}: FlowEffectsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { accent } = useDiagramTheme();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const data = segmentData(edges);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let cancelled = false;
    let visible = false;
    let gpu: Gpu | undefined;
    let render: (() => void) | undefined;
    let resize: (() => void) | undefined;
    let elapsed = 0;
    let previousTime = 0;

    const readPlayhead = () => (playhead ? Math.max(0, playhead.get()) : -1);
    const stop = () => {
      cancelFrame(tick);
      previousTime = 0;
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      stop();
      render = undefined;
      resize = undefined;
      gpu?.dispose();
      canvas.dataset.diagramEffectsStatus = 'unavailable';
      setFailure(error instanceof Error ? error.message : String(error));
    };
    const paint = () => {
      if (!render || !visible || document.hidden || reducedMotion.matches)
        return;
      try {
        render();
      } catch (error) {
        fail(error);
      }
    };
    function tick({ timestamp }: { timestamp: number }) {
      if (previousTime)
        elapsed += Math.min(timestamp - previousTime, 64) / 1000;
      previousTime = timestamp;
      paint();
    }
    const resolveStatus = (active: boolean) => {
      if (reducedMotion.matches) return 'reduced-motion';
      if (!active) return 'paused';
      if (playhead) return 'controlled';
      return mode;
    };
    const synchronize = () => {
      stop();
      const active = visible && !document.hidden && !reducedMotion.matches;
      if (!render) return;
      canvas.dataset.diagramEffectsStatus = resolveStatus(active);
      if (active && mode === 'reveal' && !playhead)
        motionFrame.update(tick, true);
      else if (active) paint();
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      visible = entry.isIntersecting;
      synchronize();
    });
    observer.observe(canvas);
    const sizeObserver = new ResizeObserver(() => {
      try {
        resize?.();
        paint();
      } catch (error) {
        fail(error);
      }
    });
    const svg = canvas.closest('svg');
    if (svg) sizeObserver.observe(svg);
    document.addEventListener('visibilitychange', synchronize);
    reducedMotion.addEventListener('change', synchronize);
    const unsubscribe = progress.on('change', paint);
    const unsubscribePlayhead = playhead?.on('change', paint);

    const start = async () => {
      if (!data.length) {
        canvas.dataset.diagramEffectsStatus = 'empty';
        return;
      }
      // Import only for opted-in diagrams; the browser entry never loads Dawn.
      const [{ init, surface, storage, draw, frame }, { prepareShader }] =
        await Promise.all([import('vgpu'), import('@vgpu/wgsl/prepare')]);
      if (cancelled) return;
      gpu = await init({ powerPreference: 'low-power', label: 'diagram-flow' });
      if (cancelled) {
        gpu.dispose();
        return;
      }
      const context = gpu;
      context.onError(fail);
      void context.lost.then((info) => {
        if (!cancelled) fail(new Error(info.message));
      });
      const target = surface(context, canvas, {
        autoResize: false,
        size: [1, 1],
        clearColor: [0, 0, 0, 0],
        alphaMode: 'premultiplied',
      });
      resize = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio, 2);
        const limit = context.gpu.limits.maxTextureDimension2D;
        target.resize([
          Math.max(1, Math.min(limit, Math.round(rect.width * dpr))),
          Math.max(1, Math.min(limit, Math.round(rect.height * dpr))),
        ]);
      };
      resize();
      const segments = storage(context, data.byteLength, 'read');
      segments.write(data);
      // Let the browser resolve CSS variables and all supported CSS color forms.
      const colorCanvas = document.createElement('canvas');
      colorCanvas.width = colorCanvas.height = 1;
      const colorContext = colorCanvas.getContext('2d');
      if (!colorContext)
        throw new Error('Unable to resolve the diagram accent.');
      let previousColor = '';
      const readTint = () => {
        const color = getComputedStyle(canvas).color;
        if (color === previousColor) return;
        previousColor = color;
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = color;
        colorContext.fillRect(0, 0, 1, 1);
        return Array.from(
          colorContext.getImageData(0, 0, 1, 1).data,
          (value) => value / 255,
        );
      };
      const flow = draw(context, {
        shader: prepareShader(flowShader, 'flow.wgsl'),
        vertices: 6,
        instances: data.length / 12,
        blend: 'premultiplied',
        set: {
          segments,
          bounds: [viewBox.x, viewBox.y, viewBox.w, viewBox.h],
          tint: readTint(),
          time: 0,
          progress: progress.get(),
          playhead: readPlayhead(),
        },
      });
      await flow.compile({
        colors: [target.format],
        sampleCount: target.sampleCount,
      });
      if (cancelled || context.disposed) return;
      setFailure(undefined);
      render = () => {
        const tint = readTint();
        if (tint) flow.set({ tint });
        flow.set({
          progress: progress.get(),
          playhead: readPlayhead(),
          time: mode === 'scrub' ? progress.get() * 6 : elapsed,
        });
        frame(context, (frame) => frame.pass(target, flow));
      };
      synchronize();
    };
    void start().catch(fail);
    return () => {
      cancelled = true;
      stop();
      unsubscribe();
      unsubscribePlayhead?.();
      observer.disconnect();
      sizeObserver.disconnect();
      document.removeEventListener('visibilitychange', synchronize);
      reducedMotion.removeEventListener('change', synchronize);
      gpu?.dispose();
    };
  }, [edges, viewBox, progress, mode, accent, playhead]);

  return (
    <foreignObject
      x={viewBox.x}
      y={viewBox.y}
      width={viewBox.w}
      height={viewBox.h}
      className="pointer-events-none"
      data-diagram-effects="flow"
    >
      <div className="relative size-full">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block size-full motion-reduce:hidden"
          data-diagram-effects-status="initializing"
          data-diagram-effects-error={failure}
          style={{ color: accent, visibility: failure ? 'hidden' : undefined }}
        />
        {failure && (
          <p
            role="status"
            className="absolute bottom-0 left-0 text-xs text-pretty text-[var(--dgm-dim)]"
          >
            Flow animation is unavailable in this browser.
          </p>
        )}
      </div>
    </foreignObject>
  );
}
