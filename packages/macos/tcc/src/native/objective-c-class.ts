import { nodeFfi } from './node-ffi.ts';

const runtime = '/usr/lib/libobjc.A.dylib';

// A class of an Objective-C framework of macOS. node:ffi binds one signature
// for each symbol of a library handle, so each message opens the runtime for
// its own signature of objc_msgSend, and closes it after.
export class ObjectiveCClass {
  readonly #framework: string;
  readonly #name: string;

  constructor(framework: string, name: string) {
    this.#framework = framework;
    this.#name = name;
  }

  // +[Class selector] or +[Class selector:integer], which returns an NSInteger.
  integer(selector: string, argument?: number): number {
    const { DynamicLibrary } = nodeFfi();
    using framework = new DynamicLibrary(this.#framework);
    using objc = new DynamicLibrary(runtime);
    const [receiver, message] = this.#target(objc, selector, framework.path);
    if (argument === undefined)
      return Number(
        objc.getFunction('objc_msgSend', {
          arguments: ['pointer', 'pointer'],
          return: 'int64',
        })(receiver, message),
      );
    return Number(
      objc.getFunction('objc_msgSend', {
        arguments: ['pointer', 'pointer', 'int64'],
        return: 'int64',
      })(receiver, message, BigInt(argument)),
    );
  }

  // +[Class selector:constant], with an NSString constant of the framework,
  // which returns an NSInteger.
  integerFor(selector: string, constant: string): number {
    const ffi = nodeFfi();
    using framework = new ffi.DynamicLibrary(this.#framework);
    using objc = new ffi.DynamicLibrary(runtime);
    const [receiver, message] = this.#target(objc, selector, framework.path);
    const object = ffi.getUint64(framework.getSymbol(constant), 0);
    return Number(
      objc.getFunction('objc_msgSend', {
        arguments: ['pointer', 'pointer', 'pointer'],
        return: 'int64',
      })(receiver, message, object),
    );
  }

  #target(
    objc: InstanceType<ReturnType<typeof nodeFfi>['DynamicLibrary']>,
    selector: string,
    framework: string,
  ): [bigint, bigint] {
    const receiver = objc.getFunction('objc_getClass', {
      arguments: ['string'],
      return: 'pointer',
    })(this.#name);
    if (receiver === 0n)
      throw new Error(`${framework} has no class ${this.#name}`);
    const message = objc.getFunction('sel_registerName', {
      arguments: ['string'],
      return: 'pointer',
    })(selector);
    return [receiver, message];
  }
}
