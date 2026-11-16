/** An Nx project under packages/, the unit whose docs a run updates. */
export class Project {
  readonly name: string;
  readonly npmName: string;
  /** The project root, relative to the workspace, with forward slashes. */
  readonly root: string;

  constructor(name: string, npmName: string, root: string) {
    this.name = name;
    this.npmName = npmName;
    this.root = root;
  }

  /** The texts that name the project: its npm name and its root folder. */
  get needles(): readonly string[] {
    return [this.npmName, `${this.root}/`];
  }

  names(text: string): boolean {
    return this.needles.some((needle) => text.includes(needle));
  }
}
