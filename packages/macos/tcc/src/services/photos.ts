import { type Limited, limited } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Photos extends PromptedService<Limited> {
  readonly name = 'kTCCServicePhotos';
  readonly pane = 'Photos';
  protected readonly anchor = 'Privacy_Photos';

  status(): Limited {
    // PHAccessLevelReadWrite (Photos/PHPhotoLibrary.h:31-33)
    return this.named(
      limited,
      new ObjectiveCClass(
        '/System/Library/Frameworks/Photos.framework/Photos',
        'PHPhotoLibrary',
      ).integer('authorizationStatusForAccessLevel:', 2),
    );
  }
}
