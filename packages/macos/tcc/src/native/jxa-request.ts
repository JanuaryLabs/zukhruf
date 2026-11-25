// A JXA script that osascript runs to ask macOS for a service. macOS shows the
// prompt only to a program with the private entitlement
// com.apple.private.tcc.allow-prompting, which osascript holds (ADR 0007).
export class JxaRequest {
  readonly source: string;

  private constructor(source: string) {
    this.source = source;
  }

  // A request of a framework. macOS asks when the request runs, and the run
  // loop turns in 50 ms slices until the status is decided. The completion
  // handler is not waited for: JXA runs it on another thread, where it cannot
  // stop a run loop that JavaScript started, and it does not run at all for
  // some requests (probes of 2026-11-26 on macOS 27.2, ADR 0007).
  static decided(
    frameworks: readonly string[],
    request: string,
    undecided: string,
  ): JxaRequest {
    return new JxaRequest(`${imports(frameworks)}
const C = (name) => $.NSClassFromString(name);
${request}
while (${undecided})
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));`);
  }

  // A C function that shows the dialog of macOS, or waits for the answer
  // itself, and returns.
  static direct(
    frameworks: readonly string[],
    binding: string,
    call: string,
  ): JxaRequest {
    return new JxaRequest(`${imports(frameworks)}
ObjC.bindFunction(${binding});
${call};`);
  }
}

function imports(frameworks: readonly string[]): string {
  return ['Foundation', ...frameworks]
    .map((framework) => `ObjC.import(${JSON.stringify(framework)});`)
    .join('\n');
}
