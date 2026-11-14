// A file of a model directory is not the file that its manifest.json lists.
// Venn raises "Invalid Venn model artifact: <name>" (venn/runtime.py:31).
export class InvalidModelArtifactError extends Error {
  readonly artifact: string;

  constructor(artifact: string, reason: string) {
    super(`The model artifact ${artifact} ${reason}.`);
    this.name = 'InvalidModelArtifactError';
    this.artifact = artifact;
  }
}
