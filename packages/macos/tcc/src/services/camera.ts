import { type Authorized, authorized } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Camera extends PromptedService<Authorized> {
  readonly name = 'kTCCServiceCamera';
  readonly pane = 'Camera';
  protected readonly anchor = 'Privacy_Camera';

  status(): Authorized {
    return this.named(
      authorized,
      new ObjectiveCClass(
        '/System/Library/Frameworks/AVFoundation.framework/AVFoundation',
        'AVCaptureDevice',
      ).integerFor('authorizationStatusForMediaType:', 'AVMediaTypeVideo'),
    );
  }
}
