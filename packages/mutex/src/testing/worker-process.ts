import { spawn, type ChildProcess } from 'node:child_process';

export interface WorkerMessage {
	type: string;
	[field: string]: unknown;
}

export interface WorkerOptions {
	/** Joins the child to a coordinator before it can send anything. */
	host?: { adoptProcess(child: ChildProcess): void };
	nodeOptions?: string[];
}

/**
 * Runs `source` as an ES module in its own Node process, with `name` as
 * argv[1] and an IPC channel back to this process. Disposing kills it.
 */
export function startWorker(
	source: string,
	name: string,
	{ host, nodeOptions = [] }: WorkerOptions = {},
) {
	const child = spawn(
		process.execPath,
		[...nodeOptions, '--input-type=module', '--eval', source, name],
		{ stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
	);
	host?.adoptProcess(child);
	const closed = Promise.withResolvers<void>();
	const worker = {
		child,
		closed: closed.promise,
		messages: [] as WorkerMessage[],
		stderr: '',
		exit: null as {
			code: number | null;
			signal: NodeJS.Signals | null;
		} | null,
		has(type: string) {
			return worker.messages.some((message) => message.type === type);
		},
		find(type: string) {
			return worker.messages.find((message) => message.type === type);
		},
		async [Symbol.asyncDispose]() {
			if (child.exitCode === null && child.signalCode === null)
				child.kill('SIGKILL');
			await closed.promise;
		},
	};
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk) => {
		worker.stderr += `${name}: ${chunk}`;
	});
	child.once('error', (error) => {
		worker.stderr += `${name}: ${error.message}\n`;
	});
	child.once('close', (code, signal) => {
		worker.exit = { code, signal };
		closed.resolve();
	});
	child.on('message', (message) => {
		if (typeof message === 'object' && message !== null && 'type' in message)
			worker.messages.push(message as WorkerMessage);
	});
	return worker;
}
