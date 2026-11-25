import { type Authorized, authorized } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Microphone extends PromptedService<Authorized> {
  readonly name = 'kTCCServiceMicrophone';
  readonly pane = 'Microphone';
  protected readonly anchor = 'Privacy_Microphone';

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
