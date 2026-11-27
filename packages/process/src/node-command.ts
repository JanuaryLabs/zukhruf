import type { ChildProcess } from 'node:child_process';

import { Latch } from '@zukhruf/async';

import {
  type CommandOptions,
  type RunOptions,
  type Starting,
  targetOf,
} from './command.ts';
import type { Completed } from './end.ts';
import { type Target, runUnderKeeper, startUnderKeeper } from './launch.ts';
import {
  Channel,
  type MessageMatch,
  type NodeProcess,
  StartedNodeProcess,
} from './node-process.ts';

export interface NodeCommandOptions extends CommandOptions {
  /** Node.js flags before the source. */
  readonly nodeOptions?: readonly string[];
}

export interface NodeStartOptions extends Starting {
  /** Gets the child before it can send, for example to join it to a coordinator. */
  readonly admit?: (child: ChildProcess) => void;
  readonly ready?:
    { readonly line: string | RegExp } | { readonly message: MessageMatch };
}

/** JavaScript source to run as a module in its own Node.js, with an IPC channel (ADR 0007). */
export class NodeCommand {
  readonly #target: Target;

  /** The name is argv[1] of the source; with no name, it is the file of Node.js, as for a command. */
  constructor(
    source: string,
    { nodeOptions = [], ...options }: NodeCommandOptions,
  ) {
    const name = options.name ?? process.execPath;
    this.#target = targetOf(
      process.execPath,
      [...nodeOptions, '--input-type=module', '--eval', source, name],
      { ...options, name },
    );
  }

  /** Runs the source to its end, with an IPC channel, and gives its end and its output. */
  run({ input, signal }: RunOptions = {}): Promise<Completed> {
    return runUnderKeeper(this.#target, { input, signal, ipc: true });
  }

  /** Starts the source, and resolves when it is ready (ADR 0006). */
  async start(options: NodeStartOptions = {}): Promise<NodeProcess> {
    const { ready } = options;
    const channel = new Latch<Channel>();
    const piped = await startUnderKeeper(this.#target, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: options.stderr ?? 'pipe',
      signal: options.signal,
      ready:
        ready === undefined
          ? undefined
          : 'line' in ready
            ? (started) => started.ready(ready.line)
            : async (started) => {
                const opened = await channel.wait();
                await opened.next(
                  ready.message,
                  started,
                  undefined,
                  'it was ready',
                );
              },
      channel: (child) => {
        channel.open(new Channel(child));
        options.admit?.(child);
      },
    });
    return new StartedNodeProcess(piped, await channel.wait());
  }
}
