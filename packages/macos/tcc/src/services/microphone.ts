import { type Authorized, authorized } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Microphone extends PromptedService<Authorized> {
  readonly name = 'kTCCServiceMicrophone';
  protected readonly paneKey = 'MICROPHONE';
  protected readonly anchor = 'Privacy_Microphone';

  protected readonly requestScript = JxaRequest.decided(
    ['AVFoundation'],
    "C('AVCaptureDevice').requestAccessForMediaTypeCompletionHandler($.AVMediaTypeAudio, () => {});",
    "Number(C('AVCaptureDevice').authorizationStatusForMediaType($.AVMediaTypeAudio)) === 0",
  ).source;

  status(): Authorized {
    return this.named(
      authorized,
      new ObjectiveCClass(
        '/System/Library/Frameworks/AVFoundation.framework/AVFoundation',
        'AVCaptureDevice',
      ).integerFor('authorizationStatusForMediaType:', 'AVMediaTypeAudio'),
    );
  }
}
