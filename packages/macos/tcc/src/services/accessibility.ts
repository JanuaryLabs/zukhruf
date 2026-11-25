import { JxaRequest } from '../native/jxa-request.ts';
import { nodeFfi } from '../native/node-ffi.ts';
import { PromptedService } from '../prompted-service.ts';

// AXIsProcessTrusted() returns a Boolean; the two names are the package's own,
// after Apple's word "trusted" (HIServices/AXUIElement.h:74).
type AccessibilityStatus = 'trusted' | 'notTrusted';

export class Accessibility extends PromptedService<AccessibilityStatus> {
  readonly name = 'kTCCServiceAccessibility';
  readonly pane = 'Device Control and Data Access';
  protected readonly anchor = 'Privacy_Accessibility';

  protected readonly requestScript = JxaRequest.direct(
    ['ApplicationServices'],
    "'AXIsProcessTrustedWithOptions', ['bool', ['id']]",
    // kAXTrustedCheckOptionPrompt (HIServices/AXUIElement.h:64)
    '$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }))',
  ).source;

  status(): AccessibilityStatus {
    using services = new (nodeFfi().DynamicLibrary)(
      '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices',
    );
    const trusted = services.getFunction('AXIsProcessTrusted', {
      arguments: [],
      return: 'uint8',
    })();
    return trusted === 0 ? 'notTrusted' : 'trusted';
  }
}
