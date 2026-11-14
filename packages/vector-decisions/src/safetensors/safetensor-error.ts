// A file breaks a rule of the safetensors format, or holds a tensor that is
// not float32. The safetensors library of Hugging Face gives its error the
// same name.
export class SafetensorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SafetensorError';
  }
}
