// The worker thread of a NotificationsThread: it runs the notifications on
// the file and serves them to the host over the port to its parent.
import { parentPort } from 'node:worker_threads';

import {
  Client,
  ConnectionSupervisor,
  ParentPortConnection,
  type RpcMessage,
  Server,
} from '@zukhruf/rpc';

import { Notifications } from '../notifications.ts';
import { HostClock } from './host-clock.ts';
import {
  type ClockKind,
  type EngineOptions,
  type HostMethods,
  type ThreadMethods,
  errors,
  hostAnswers,
  tag,
  threadParams,
} from './protocol.ts';

/** The notifications of the thread: none until the host opens them. */
type Engine =
  { kind: 'unopened' } | { kind: 'open'; notifications: Notifications };

/** The methods the host calls, on the notifications of this thread. */
class NotifyThread implements ThreadMethods {
  readonly #host: Client<HostMethods>;
  readonly #clock: HostClock;
  readonly #link: ConnectionSupervisor<RpcMessage>;
  #engine: Engine = { kind: 'unopened' };

  constructor(
    host: Client<HostMethods>,
    link: ConnectionSupervisor<RpcMessage>,
  ) {
    this.#host = host;
    this.#link = link;
    this.#clock = new HostClock(host);
  }

  open(options: EngineOptions, kind: ClockKind) {
    const host = this.#host;
    const notifications = new Notifications({
      ...options,
      clock: kind === 'remote' ? this.#clock : globalThis,
    });
    notifications.on('notification', (notification) =>
      host.notify('notification', [notification]),
    );
    // Every error goes to the host, which emits it as the main thread does,
    // also when nobody listens there.
    notifications.on('error', (error) =>
      host.notify('error', [errors.encode(error)]),
    );
    this.#engine = { kind: 'open', notifications };
  }

  listen(channel: string) {
    return this.#notifications().listen(channel);
  }

  unlisten(channel: string) {
    return this.#notifications().unlisten(channel);
  }

  notify(channel: string, payload: string) {
    this.#notifications().notify(channel, payload);
  }

  async dispose() {
    await this.#notifications()[Symbol.asyncDispose]();
  }

  time(now: number) {
    this.#clock.update(now);
  }

  fire(timer: number) {
    this.#clock.fire(timer);
  }

  async end() {
    await this.#link.close();
  }

  #notifications(): Notifications {
    if (this.#engine.kind === 'unopened') {
      throw new Error('The notifications thread has no open notifications.');
    }
    return this.#engine.notifications;
  }
}

if (!parentPort) {
  throw new Error('The notifications thread runs only as a worker thread.');
}
const connection = new ParentPortConnection<RpcMessage>(parentPort, { tag });
const link = new ConnectionSupervisor<RpcMessage>({
  connect: async () => connection,
});
const host = new Client<HostMethods>(link, { errors, answers: hostAnswers });

new Server(new NotifyThread(host, link), {
  methods: threadParams,
  errors,
}).serve(link);
