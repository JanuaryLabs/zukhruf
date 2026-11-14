// The weights lack a tensor of the head, or a tensor does not fit the
// others. PyTorch's strict load_state_dict refuses the same weights.
export class InvalidHeadWeightsError extends Error {
  readonly tensor: string;

  constructor(tensor: string, reason: string) {
    super(`The tensor ${tensor} ${reason}.`);
    this.name = 'InvalidHeadWeightsError';
    this.tensor = tensor;
  }
}
