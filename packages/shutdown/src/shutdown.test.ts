import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConnectionFailedError, Docker } from '@zukhruf/docker';

// Only a container makes a process PID 1. The kernel does not apply the
// default action of a signal to PID 1, so there the process cannot die by
// its termination signal (ADR 0001).
const nodeImage = 'node:26-alpine';
const noEngine = await (async () => {
  try {
    const docker = await Docker.connect({
      clock: globalThis,
      signal: AbortSignal.timeout(5_000),
    });
    await docker[Symbol.asyncDispose]();
    return false;
  } catch (error) {
    if (error instanceof ConnectionFailedError) {
      return 'no Docker engine answers';
    }
    throw error;
  }
})();

// The package acts on the whole process: its termination signals, its crash
// events and the way it ends. Thus each test runs a real program in its own
// Node.js process, and reads what the program wrote and how it ended. The
// shell turns core dumps off, because the default action of SIGQUIT writes
// one, and exec keeps the process id, so a signal goes to Node.js.
function run(signal: AbortSignal, program: string) {
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'ulimit -c 0 && exec "$0" "$@"',
      process.execPath,
      '--input-type=module',
      '--eval',
      program,
    ],
    {
      cwd: new URL('..', import.meta.url),
      stdio: ['pipe', 'pipe', 'pipe'],
      // A test that times out does not reach its disposal, so its cancel
      // ends the program. SIGTERM would only start a shutdown.
      signal,
      killSignal: 'SIGKILL',
    },
  );
  const exited = once(child, 'exit');
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(chunk);
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    send(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    /** Writes a line to the standard input of the program. */
    write(line: string) {
      child.stdin.write(`${line}\n`);
    },
    /** Reads the output of the program until it writes this line, and gives the lines so far. */
    async wrote(expected: string) {
      for (
        let next = await lines.next();
        !next.done;
        next = await lines.next()
      ) {
        stdout.push(next.value);
        if (next.value === expected) {
          return [...stdout];
        }
      }
      assert.fail(
        `The program ended before it wrote "${expected}". It wrote: ${JSON.stringify(stdout)}. Standard error: ${stderr.join('')}`,
      );
    },
    /** Waits for the end of the program. */
    async ended() {
      for (
        let next = await lines.next();
        !next.done;
        next = await lines.next()
      ) {
        stdout.push(next.value);
      }
      const [code, signal] = await exited;
      return { code, signal, stdout, stderr: stderr.join('') };
    },
    async [Symbol.asyncDispose]() {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

describe('Shutdown', () => {
  test(
    'a second termination signal ends a shutdown whose cleanup does not end, at once and by that signal',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup started');
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          },
        };
        const work = setInterval(() => {}, 1_000);
        console.log('ready');
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );
      await program.wrote('ready');
      program.send('SIGINT');
      await program.wrote('cleanup started');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, ['ready', 'cleanup started']);
    },
  );

  test(
    'a listener of another package for the termination signal does not keep the process from dying by it',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        process.on('SIGINT', () => console.log('the other listener ran'));
        const work = setInterval(() => {}, 1_000);
        console.log('ready');
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );
      await program.wrote('ready');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, ['ready', 'the other listener ran']);
    },
  );

  test(
    'a crash during the cleanup of a crash ends the process at once, with exit code 1',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup started');
            setTimeout(() => {
              throw new Error('the cleanup crashed');
            });
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          },
        };
        const work = setInterval(() => {}, 1_000);
        setTimeout(() => {
          throw new Error('the work crashed');
        });
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );

      // Act
      const { code, signal, stdout, stderr } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: 1, signal: null });
      assert.deepEqual(stdout, ['cleanup started']);
      assert.match(stderr, /Error: the work crashed/);
      assert.match(stderr, /Error: the cleanup crashed/);
    },
  );

  test(
    'a termination signal during the cleanup of a crash ends the process at once, by that signal',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup started');
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          },
        };
        const work = setInterval(() => {}, 1_000);
        setTimeout(() => {
          throw new Error('the work crashed');
        });
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );
      await program.wrote('cleanup started');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, ['cleanup started']);
    },
  );

  test(
    'a crash during the cleanup of a termination signal ends the process at once, by that signal, also while a call waits in the thread pool',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      // The key derivation keeps a thread of the thread pool of Node.js busy
      // for minutes, as a read of a pipe that no program writes does. An exit
      // that waits for the thread pool, as process.exit() does, then does not
      // end.
      await using program = run(
        t.signal,
        `
        import { pbkdf2 } from 'node:crypto';
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup started');
            pbkdf2('password', 'salt', 1_000_000_000, 64, 'sha512', () => {});
            setTimeout(() => {
              throw new Error('the cleanup crashed');
            });
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          },
        };
        const work = setInterval(() => {}, 1_000);
        console.log('ready');
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );
      await program.wrote('ready');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout, stderr } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, ['ready', 'cleanup started']);
      assert.match(stderr, /Error: the cleanup crashed/);
    },
  );

  test(
    'work that throws the abort reason of a termination signal, and that no code catches, still ends by the signal',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup ran');
          },
        };
        const work = setInterval(() => {}, 1_000);
        console.log('ready');
        await aborted(shutdown.signal, work);
        clearInterval(work);
        shutdown.signal.throwIfAborted();
      `,
      );
      await program.wrote('ready');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout, stderr } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, ['ready', 'cleanup ran']);
      assert.match(stderr, /\[AbortError\]: The process received SIGINT/);
    },
  );

  test(
    'an uncaught exception aborts the signal with the error, the cleanup runs, and the process exits with code 1',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup ran');
          },
        };
        const work = setInterval(() => {}, 1_000);
        const crash = new Error('the work crashed');
        setTimeout(() => {
          throw crash;
        });
        await aborted(shutdown.signal, work);
        clearInterval(work);
        console.log(\`the reason is the error: \${shutdown.signal.reason === crash}\`);
      `,
      );

      // Act
      const { code, signal, stdout, stderr } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: 1, signal: null });
      assert.deepEqual(stdout, [
        'the reason is the error: true',
        'cleanup ran',
      ]);
      assert.match(stderr, /Error: the work crashed/);
    },
  );

  test(
    'an unhandled rejection of a value that is not an error aborts the signal with that value, the cleanup runs, and the process exits with code 1',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup ran');
          },
        };
        const work = setInterval(() => {}, 1_000);
        void Promise.reject('the work failed');
        await aborted(shutdown.signal, work);
        clearInterval(work);
        console.log(\`the reason: \${shutdown.signal.reason}\`);
      `,
      );

      // Act
      const { code, signal, stdout, stderr } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: 1, signal: null });
      assert.deepEqual(stdout, ['the reason: the work failed', 'cleanup ran']);
      assert.match(stderr, /the work failed/);
    },
  );

  test(
    'a crash keeps an exit code that the program set',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        const work = setInterval(() => {}, 1_000);
        process.exitCode = 3;
        setTimeout(() => {
          throw new Error('the work crashed');
        });
        await aborted(shutdown.signal, work);
        clearInterval(work);
      `,
      );

      // Act
      const { code, signal } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: 3, signal: null });
    },
  );

  for (const terminationSignal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(
      `${terminationSignal} aborts the signal with an AbortError that names it, the cleanup runs, and then the process dies by ${terminationSignal}`,
      { timeout: 10_000 },
      async (t) => {
        // Arrange
        await using program = run(
          t.signal,
          `
          import { aborted } from 'node:util';
          import { Shutdown } from '@zukhruf/shutdown';

          using shutdown = new Shutdown();
          await using resource = {
            async [Symbol.asyncDispose]() {
              await new Promise((resolve) => setImmediate(resolve));
              console.log('cleanup ran');
            },
          };
          const work = setInterval(() => {}, 1_000);
          console.log('ready');
          await aborted(shutdown.signal, work);
          clearInterval(work);
          const { reason } = shutdown.signal;
          console.log(\`\${reason instanceof DOMException} \${reason.name}: \${reason.message}\`);
        `,
        );
        await program.wrote('ready');

        // Act
        program.send(terminationSignal);
        const { code, signal, stdout } = await program.ended();

        // Assert
        assert.deepEqual(
          { code, signal },
          { code: null, signal: terminationSignal },
        );
        assert.deepEqual(stdout, [
          'ready',
          `true AbortError: The process received ${terminationSignal}`,
          'cleanup ran',
        ]);
      },
    );
  }

  test(
    'a program with no stop request ends when its work ends, with its own exit code, also when the scope never ends',
    { timeout: 10_000 },
    async (t) => {
      for (const declaration of [
        'using shutdown = new Shutdown();',
        'const shutdown = new Shutdown();',
      ]) {
        for (const exitCode of [0, 3]) {
          // Arrange
          await using program = run(
            t.signal,
            `
            import { Shutdown } from '@zukhruf/shutdown';

            ${declaration}
            process.exitCode = ${exitCode};
          `,
          );

          // Act
          const { code, signal } = await program.ended();

          // Assert
          assert.deepEqual(
            { declaration, code, signal },
            { declaration, code: exitCode, signal: null },
          );
        }
      }
    },
  );

  test(
    'the end of the scope with no stop request aborts the signal, stops listening, and leaves the exit of the process alone',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      const program = `
        import { Shutdown } from '@zukhruf/shutdown';

        const signal = (() => {
          using shutdown = new Shutdown();
          return shutdown.signal;
        })();
        console.log(\`\${signal.reason.name}: \${signal.reason.message}\`);
        console.log('scope ended');
      `;
      await using ends = run(t.signal, program);
      await using waits = run(
        t.signal,
        `${program}\nsetInterval(() => {}, 1_000);`,
      );
      await using crashes = run(
        t.signal,
        `${program}\nsetTimeout(() => {\n  throw new Error('a crash after the scope');\n});`,
      );

      // Act
      const ended = await ends.ended();
      const linesBeforeSignal = await waits.wrote('scope ended');
      waits.send('SIGINT');
      const waited = await waits.ended();
      const crashed = await crashes.ended();

      // Assert
      assert.deepEqual(
        { code: ended.code, signal: ended.signal, stdout: ended.stdout },
        {
          code: 0,
          signal: null,
          stdout: ['AbortError: The shutdown scope ended', 'scope ended'],
        },
      );
      assert.deepEqual(linesBeforeSignal, [
        'AbortError: The shutdown scope ended',
        'scope ended',
      ]);
      assert.deepEqual(
        { code: waited.code, signal: waited.signal },
        { code: null, signal: 'SIGINT' },
      );
      assert.deepEqual(
        { code: crashed.code, signal: crashed.signal },
        { code: 1, signal: null },
      );
      assert.match(crashed.stderr, /Error: a crash after the scope/);
    },
  );

  test(
    'a stop request that came before the end of the scope stays: the reason is kept, and the process still dies by the signal',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        const signal = await (async () => {
          using shutdown = new Shutdown();
          const work = setInterval(() => {}, 1_000);
          console.log('ready');
          await aborted(shutdown.signal, work);
          clearInterval(work);
          return shutdown.signal;
        })();
        console.log(\`after the scope: \${signal.reason.message}\`);
      `,
      );
      await program.wrote('ready');

      // Act
      program.send('SIGINT');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGINT' });
      assert.deepEqual(stdout, [
        'ready',
        'after the scope: The process received SIGINT',
      ]);
    },
  );

  const asPidOne = [
    { stopRequest: 'SIGINT', exitCode: 130, cleanup: 'ends' },
    { stopRequest: 'SIGTERM', exitCode: 143, cleanup: 'ends' },
    { stopRequest: 'SIGHUP', exitCode: 129, cleanup: 'ends' },
    { stopRequest: 'SIGTERM', exitCode: 143, cleanup: 'crashes' },
  ] as const;
  for (const { stopRequest, exitCode, cleanup } of asPidOne) {
    test(
      `as PID 1 in a container, ${stopRequest} ends the process with exit code ${exitCode} when the cleanup ${cleanup}`,
      { skip: noEngine, timeout: 180_000 },
      async () => {
        // Arrange
        await using docker = await Docker.connect({ clock: globalThis });
        if ((await docker.images.inspect(nodeImage)) === undefined) {
          await docker.images.pull(nodeImage);
        }
        const cleanupCode =
          cleanup === 'ends'
            ? `console.log('cleanup ran');`
            : `console.log('cleanup started');
               setTimeout(() => {
                 throw new Error('the cleanup crashed');
               });
               setInterval(() => {}, 1_000);
               await new Promise(() => {});`;
        await using container = await docker.containers.create({
          Image: nodeImage,
          Cmd: [
            'node',
            '--input-type=module',
            '--eval',
            `
              import { aborted } from 'node:util';
              import { Shutdown } from '@zukhruf/shutdown';

              using shutdown = new Shutdown();
              await using resource = {
                async [Symbol.asyncDispose]() {
                  ${cleanupCode}
                },
              };
              const work = setInterval(() => {}, 1_000);
              console.log(\`pid \${process.pid}\`);
              console.log('ready');
              await aborted(shutdown.signal, work);
              clearInterval(work);
            `,
          ],
          WorkingDir: '/package',
          HostConfig: {
            Binds: [
              `${fileURLToPath(new URL('..', import.meta.url))}:/package:ro`,
            ],
          },
        });
        // A program that does not end must not keep its container: the
        // cancel rejects the reads, and the disposal removes the container.
        const output = await container.attach({
          signal: AbortSignal.timeout(60_000),
        });
        await container.start();
        const chunks = output[Symbol.asyncIterator]();
        const decoder = new TextDecoder();
        const stdout: string[] = [];
        const read = async (until?: string) => {
          for (
            let next = await chunks.next();
            !next.done;
            next = await chunks.next()
          ) {
            if (next.value.stream === 'stdout') {
              stdout.push(decoder.decode(next.value.data));
            }
            if (until !== undefined && stdout.join('').includes(until)) {
              return;
            }
          }
        };
        await read('ready\n');

        // Act
        await container.kill(stopRequest);
        await read();

        // Assert
        assert.equal(await output.exitCode, exitCode);
        assert.equal(
          stdout.join(''),
          cleanup === 'ends'
            ? 'pid 1\nready\ncleanup ran\n'
            : 'pid 1\nready\ncleanup started\n',
        );
      },
    );
  }

  test(
    'SIGQUIT keeps its default action: the process ends at once, with no abort and no cleanup',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { aborted } from 'node:util';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup ran');
          },
        };
        const work = setInterval(() => {}, 1_000);
        console.log('ready');
        await aborted(shutdown.signal, work);
        console.log('aborted');
      `,
      );
      await program.wrote('ready');

      // Act
      program.send('SIGQUIT');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGQUIT' });
      assert.deepEqual(stdout, ['ready']);
    },
  );

  test(
    'a termination signal during the start, before the work takes the signal, still stops the work and ends the process by that signal',
    { timeout: 10_000 },
    async (t) => {
      // Arrange
      await using program = run(
        t.signal,
        `
        import { once } from 'node:events';
        import { createInterface } from 'node:readline';
        import { Shutdown } from '@zukhruf/shutdown';

        using shutdown = new Shutdown();
        await using resource = {
          async [Symbol.asyncDispose]() {
            console.log('cleanup ran');
          },
        };
        process.once('SIGTERM', () => console.log('the signal came'));
        console.log('ready');
        // A start that does not read the signal. It ends when the test writes
        // a line, after the signal came.
        const input = createInterface({ input: process.stdin });
        await once(input, 'line');
        input.close();
        process.stdin.destroy();
        console.log(\`the work gets an aborted signal: \${shutdown.signal.aborted}\`);
      `,
      );
      await program.wrote('ready');
      program.send('SIGTERM');
      await program.wrote('the signal came');

      // Act
      program.write('go');
      const { code, signal, stdout } = await program.ended();

      // Assert
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGTERM' });
      assert.deepEqual(stdout, [
        'ready',
        'the signal came',
        'the work gets an aborted signal: true',
        'cleanup ran',
      ]);
    },
  );
});
