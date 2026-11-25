import { Service } from './service.ts';

// A service whose status a framework of macOS gives.
export abstract class PromptedService<Status extends string> extends Service {
  abstract status(): Status;

  // Apple's raw value as its name, in the order of the SDK header.
  protected named(names: readonly Status[], raw: number): Status {
    const name = names[raw];
    if (name === undefined)
      throw new RangeError(`${this.name} gave the unknown status ${raw}`);
    return name;
  }
}
