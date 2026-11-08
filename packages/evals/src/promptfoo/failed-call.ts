// What a provider returns for a model call that failed for its one test,
// also after its retries (ADR 0005): the answer null. promptfoo 0.125.1
// grades no result whose provider gave an error or no output
// (dist/src/evaluator-BxCmvGtv.js:7940-7952), so that case would add nothing
// to the wholes and the recall would go up. promptfoo grades the answer null,
// and each family reads it as no answer. A failure of the run, such as a 401,
// is thrown instead, so the result stays an error result that promptfoo
// retry runs again.
export class FailedCall {
  static readonly answer = 'null';
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  // promptfoo's ProviderResponse of the failed call: the answer null, and the
  // metadata of the provider with the reason under `failed`.
  response(
    metadata: Readonly<Record<string, unknown>> = {},
  ): FailedCallResponse {
    return {
      output: FailedCall.answer,
      metadata: { ...metadata, failed: this.reason },
    };
  }
}

export type FailedCallResponse = {
  readonly output: typeof FailedCall.answer;
  readonly metadata: Readonly<Record<string, unknown>> & {
    readonly failed: string;
  };
};
