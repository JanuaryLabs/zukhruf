import { JxaRequest } from '../native/jxa-request.ts';
import { nodeFfi } from '../native/node-ffi.ts';
import { PromptedService } from '../prompted-service.ts';

// CGPreflightScreenCaptureAccess() returns a bool (CoreGraphics/CGWindow.h:300);
// the two names are the package's own.
type ScreenRecordingStatus = 'granted' | 'notGranted';

export class ScreenRecording extends PromptedService<ScreenRecordingStatus> {
  readonly name = 'kTCCServiceScreenCapture';
  protected readonly paneKey = 'SCREEN_CAPTURE';
  protected readonly anchor = 'Privacy_ScreenCapture';

  protected readonly requestScript = JxaRequest.direct(
    ['CoreGraphics'],
    "'CGRequestScreenCaptureAccess', ['bool', []]",
    '$.CGRequestScreenCaptureAccess()',
  ).source;

  status(): ScreenRecordingStatus {
    using graphics = new (nodeFfi().DynamicLibrary)(
      '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',
    );
    const granted = graphics.getFunction('CGPreflightScreenCaptureAccess', {
      arguments: [],
      return: 'uint8',
    })();
    return granted === 0 ? 'notGranted' : 'granted';
  }
}
