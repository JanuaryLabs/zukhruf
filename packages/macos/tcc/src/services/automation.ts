import { JxaRequest } from '../native/jxa-request.ts';
import { nodeFfi } from '../native/node-ffi.ts';
import { PromptedService } from '../prompted-service.ts';

type AutomationStatus =
  'permitted' | 'notPermitted' | 'wouldRequireUserConsent' | 'notRunning';

// The results of AEDeterminePermissionToAutomateTarget (AE/AppleEvents.h:346-363).
const results = new Map<number, AutomationStatus>([
  [0, 'permitted'],
  [-1743, 'notPermitted'],
  [-1744, 'wouldRequireUserConsent'],
  [-600, 'notRunning'],
]);

// The four-character codes of the Apple event that the check names: the open
// documents event of the core suite, and the type of a bundle identifier.
const coreSuite = 0x61657674; // 'aevt'
const openDocuments = 0x6f646f63; // 'odoc'
const bundleIdentifier = 0x62756e64; // 'bund'

// The grant to send Apple events to one target app.
export class Automation extends PromptedService<AutomationStatus> {
  readonly name = 'kTCCServiceAppleEvents';
  protected readonly paneKey = 'AUTOMATION';
  protected readonly anchor = 'Privacy_Automation';
  // The bundle identifier of the target app.
  readonly target: string;

  constructor(target: string) {
    super();
    this.target = target;
  }

  // AEDeterminePermissionToAutomateTarget with askUserIfNeeded, which waits
  // for the answer (AE/AppleEvents.h:363).
  protected get requestScript(): string {
    return JxaRequest.direct(
      ['CoreServices'],
      "'AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]",
      `$.AEDeterminePermissionToAutomateTarget($.NSAppleEventDescriptor.descriptorWithBundleIdentifier(${JSON.stringify(this.target)}).aeDesc, ${coreSuite}, ${openDocuments}, true)`,
    ).source;
  }

  status(): AutomationStatus {
    using services = new (nodeFfi().DynamicLibrary)(
      '/System/Library/Frameworks/CoreServices.framework/CoreServices',
    );
    const identifier = Buffer.from(this.target);
    // An AEDesc: its 4-byte type, then its 8-byte data handle, aligned to 16.
    const descriptor = Buffer.alloc(16);
    const created = services.getFunction('AECreateDesc', {
      arguments: ['uint32', 'buffer', 'int64', 'buffer'],
      return: 'int16',
    })(bundleIdentifier, identifier, BigInt(identifier.byteLength), descriptor);
    if (created !== 0)
      throw new Error(`AECreateDesc failed with ${created} for ${this.target}`);
    try {
      const result = services.getFunction(
        'AEDeterminePermissionToAutomateTarget',
        { arguments: ['buffer', 'uint32', 'uint32', 'uint8'], return: 'int32' },
      )(descriptor, coreSuite, openDocuments, 0);
      const status = results.get(result);
      if (status === undefined)
        throw new Error(
          `AEDeterminePermissionToAutomateTarget gave ${result} for ${this.target}`,
        );
      return status;
    } finally {
      services.getFunction('AEDisposeDesc', {
        arguments: ['buffer'],
        return: 'int16',
      })(descriptor);
    }
  }
}
