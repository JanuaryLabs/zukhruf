import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { nodeTypeRoots } from '../testing/node-type-roots.ts';
import { typedRuleTester } from '../testing/rule-tester.ts';
import rule from './no-unhandled-readline-error.ts';

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    lib: ['esnext'],
    allowImportingTsExtensions: true,
    types: ['node'],
    typeRoots: nodeTypeRoots,
  },
  include: ['*.ts', '*.mts'],
});

// Helpers of the project, read by their bodies: leaveErrorsToClose is the
// shape of @zukhruf/mutex's own helper.
const helpers = [
  `import type { EventEmitter } from 'node:events';`,
  `import type { Interface } from 'node:readline';`,
  `export function leaveErrorsToClose(emitter: EventEmitter): void { emitter.on('error', () => {}); }`,
  `export function quiet(emitter: EventEmitter): void { leaveErrorsToClose(emitter); }`,
  `export function track(lines: Interface, seen: string[]): void { lines.on('line', (line) => seen.push(line)); }`,
].join('\n');

// A library's helper: only its declaration is in the program, so the rule
// cannot read whether it listens.
const library = {
  'node_modules/library/package.json': JSON.stringify({
    name: 'library',
    types: 'index.d.ts',
  }),
  'node_modules/library/index.d.ts': `import type { EventEmitter } from 'node:events'; export declare function quietly(emitter: EventEmitter): void;`,
};

const server = (body: string) =>
  [
    `import { createServer } from 'node:net';`,
    `import { createInterface } from 'node:readline';`,
    `createServer((peer) => {`,
    `  peer.on('error', () => {});`,
    body,
    `});`,
  ].join('\n');

const reported = [{ messageId: 'unhandled' }];

async function workspace() {
  return fixtureWorkspace({
    'tsconfig.json': tsconfig,
    'helpers.ts': helpers,
    // On disk, so the tsconfig holds the cases: the project service gives at
    // most eight files of a process its default project, and the tester's
    // allowDefaultProject glob (`*.ts`) must not match a file of the tsconfig.
    'case.mts': 'export {};\n',
    ...library,
  });
}

test('an interface over a socket with no error listener of its own is reported, as in the two CI breaks', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [],
    invalid: [
      {
        // 5e83b4e^: single-flight's test coordinators.
        filename,
        code: server(
          `createInterface({ input: peer }).once('line', () => peer.destroy());`,
        ),
        errors: reported,
      },
      {
        // 368c4f9c: mutex's session test.
        filename,
        code: server(
          `const lines = createInterface({ input: peer }); lines.on('line', () => {});`,
        ),
        errors: reported,
      },
    ],
  });
});

test('an input that the code can write to counts: a socket or another Duplex, in every form of the call', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [],
    invalid: [
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; createInterface({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { connect } from 'node:tls'; import { createInterface } from 'node:readline'; createInterface({ input: connect(443) }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import type { Duplex } from 'node:stream'; import { createInterface } from 'node:readline'; export function read(input: Duplex | null) { createInterface({ input: input! }).on('line', () => {}); }`,
        errors: reported,
      },
      {
        filename,
        code: `import { PassThrough } from 'node:stream'; import { createInterface } from 'node:readline'; createInterface({ input: new PassThrough() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; createInterface(new Socket()).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import * as readline from 'node:readline'; readline.createInterface({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface as readLines } from 'node:readline'; readLines({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'readline'; createInterface({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'readline/promises'; createInterface({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline/promises'; createInterface({ input: new Socket() }).on('line', () => {});`,
        errors: reported,
      },
    ],
  });
});

test('a stream that the code only reads gets no reset, so the stdout of a child, a Readable and process.stdin are not reported', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: `import { spawn } from 'node:child_process'; import { createInterface } from 'node:readline'; const child = spawn('ls'); createInterface({ input: child.stdout }).on('line', () => {}); createInterface(child.stderr).on('line', () => {});`,
      },
      {
        filename,
        code: `import type { Readable } from 'node:stream'; import { createInterface } from 'node:readline'; export function read(input: Readable | null) { createInterface({ input: input! }).on('line', () => {}); }`,
      },
      {
        filename,
        code: `import { createInterface } from 'node:readline'; createInterface({ input: process.stdin, output: process.stdout }).on('line', () => {});`,
      },
    ],
    invalid: [],
  });
});

test('a listener that is not an error listener of this interface for its whole life is reported', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [],
    invalid: [
      {
        // node:events removes the listener of once() when the line comes.
        filename,
        code: server(
          `import('node:events').then(async ({ once }) => { await once(createInterface({ input: peer }), 'line'); });`,
        ),
        errors: reported,
      },
      {
        filename,
        code: server(
          `const lines = createInterface({ input: peer }); lines.on('close', () => {}).on('line', () => {});`,
        ),
        errors: reported,
      },
      {
        // The error listener is on the other interface.
        filename,
        code: server(
          `const lines = createInterface({ input: peer }); const other = createInterface({ input: peer }); other.on('error', () => {}); void lines;`,
        ),
        errors: reported,
      },
      {
        // Another variable of the same name, in another scope.
        filename,
        code: server(
          `const lines = createInterface({ input: peer }); void lines; ((lines: NodeJS.EventEmitter) => lines.on('error', () => {}))(peer);`,
        ),
        errors: reported,
      },
    ],
  });
});

test('a function that does not listen for errors itself does not handle them', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [],
    invalid: [
      {
        filename,
        code: server(
          `const seen: string[] = []; import('./helpers.ts').then(({ track }) => track(createInterface({ input: peer }), seen));`,
        ),
        errors: reported,
      },
      {
        // A library's function has no body to read.
        filename,
        code: `import { quietly } from 'library'; import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; quietly(createInterface({ input: new Socket() }));`,
        errors: reported,
      },
    ],
  });
});

test('an interface that leaves the function or is dropped without a listener is reported', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [],
    invalid: [
      {
        filename,
        code: `import type { Socket } from 'node:net'; import { createInterface } from 'node:readline'; export function lines(input: Socket) { return createInterface({ input }); }`,
        errors: reported,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; createInterface({ input: new Socket() });`,
        errors: reported,
      },
    ],
  });
});

test('an error listener on the interface, chained or on its name, is accepted', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: server(
          `createInterface({ input: peer }).on('error', () => {}).once('line', () => peer.destroy());`,
        ),
      },
      {
        filename,
        code: server(
          `createInterface({ input: peer }).once('line', () => peer.destroy()).once('error', () => {});`,
        ),
      },
      {
        filename,
        code: server(
          `const lines = createInterface({ input: peer }); lines.on('line', () => {}); lines.addListener('error', () => {});`,
        ),
      },
      {
        filename,
        code: server(
          `using lines = createInterface({ input: peer }); lines.prependListener(\`error\`, () => {});`,
        ),
      },
    ],
    invalid: [],
  });
});

test('a function of the project whose body listens for errors on its parameter is accepted', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: server(
          `import('./helpers.ts').then(({ leaveErrorsToClose }) => { const lines = createInterface({ input: peer }); leaveErrorsToClose(lines); });`,
        ),
      },
      {
        // A helper that calls a helper.
        filename,
        code: server(
          `import('./helpers.ts').then(({ quiet }) => quiet(createInterface({ input: peer })));`,
        ),
      },
      {
        filename,
        code: server(
          `function ignore(lines: NodeJS.EventEmitter) { lines.on('error', () => {}); } ignore(createInterface({ input: peer }));`,
        ),
      },
      {
        // linesOf makes the interface itself and listens before it returns it.
        filename,
        code: `import type { Socket } from 'node:net'; import { type Interface, createInterface } from 'node:readline'; import { leaveErrorsToClose } from './helpers.ts'; export function linesOf(input: Socket): Interface { const lines = createInterface({ input }); leaveErrorsToClose(lines); return lines; }`,
      },
    ],
    invalid: [],
  });
});

test('reading the interface with its async iterator is accepted, as node:events turns the error into a rejection', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; for await (const line of createInterface({ input: new Socket() })) console.log(line);`,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; const lines = createInterface({ input: new Socket() }); for await (const line of lines) console.log(line);`,
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; export const lines = createInterface({ input: new Socket() })[Symbol.asyncIterator]();`,
      },
    ],
    invalid: [],
  });
});

test('a class field that holds the interface is followed into every method', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');
  const reader = (method: string) =>
    `import type { Socket } from 'node:net'; import { type Interface, createInterface } from 'node:readline'; export class Reader { readonly #lines: Interface; constructor(socket: Socket) { this.#lines = createInterface({ input: socket }); } ${method} }`;

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: reader(`listen() { this.#lines.on('error', () => {}); }`),
      },
      {
        filename,
        code: `import { Socket } from 'node:net'; import { createInterface } from 'node:readline'; export class Reader { readonly lines = createInterface({ input: new Socket() }); listen() { this.lines.on('error', () => {}); } }`,
      },
    ],
    invalid: [
      {
        filename,
        code: reader(`listen() { this.#lines.on('line', () => {}); }`),
        errors: reported,
      },
    ],
  });
});

test('a createInterface that is not readline, and an input with no type, are not reported', async () => {
  await using fixture = await workspace();
  const filename = fixture.path('case.mts');

  typedRuleTester(fixture.root).run('no-unhandled-readline-error', rule, {
    valid: [
      {
        filename,
        code: `import { Socket } from 'node:net'; function createInterface(options: { input: Socket }) { return options; } createInterface({ input: new Socket() });`,
      },
      {
        filename,
        code: `import { createInterface } from 'node:readline'; export function read(input: any) { createInterface({ input }).on('line', () => {}); }`,
      },
    ],
    invalid: [],
  });
});
