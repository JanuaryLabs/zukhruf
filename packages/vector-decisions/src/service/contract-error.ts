export type ContractErrorCode =
  | 'question_limit'
  | 'option_limit'
  | 'option_labels'
  | 'threshold'
  | 'rubric'
  | 'invalid_text'
  | 'invalid_vector'
  | 'zero_vector'
  | 'unsupported_input'
  | 'question_type'
  | 'state_texts'
  | 'state_limit'
  | 'state_shape'
  | 'index_input'
  | 'stream_limit'
  | 'stream_required'
  | 'question_handle'
  | 'prewarm_override'
  | 'prewarm_type'
  | 'calibration_size'
  | 'calibration_labels';

// A request that breaks a rule of Venn's contract (venn/errors.py): `code`
// names the rule for a program, the message is for people, and `status` is
// the HTTP status that Venn's routes give.
export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly status: number;

  constructor(code: ContractErrorCode, message: string, status = 422) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.status = status;
  }
}
