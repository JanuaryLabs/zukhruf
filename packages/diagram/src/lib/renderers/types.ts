import type { MotionValue } from 'motion/react';

import type {
  DiagramGraphIR,
  DiagramPaper,
  DiagramViewport,
} from '../model/diagram-ir.ts';

export type DiagramEffects =
  | 'flow'
  | {
      /**
       * Controlled flow in edge declaration order: 0→1 traverses the first edge,
       * 1→2 the second, etc. Integer values clear pulses. The caller controls
       * timing, pauses, node activation and conditional stops. No internal loop.
       */
      flow: MotionValue<number>;
    };

export type GraphRendererProps = {
  ir: DiagramGraphIR;
  title: string[];
  progress: MotionValue<number>;
  viewport?: DiagramViewport | undefined;
  paper?: DiagramPaper | undefined;
};
