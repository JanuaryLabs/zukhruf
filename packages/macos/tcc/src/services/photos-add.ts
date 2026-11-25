import { type Limited, limited } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class PhotosAdd extends PromptedService<Limited> {
  readonly name = 'kTCCServicePhotosAdd';
  readonly pane = 'Photos';
  protected readonly anchor = 'Privacy_Photos';

  status(): Limited {
    // PHAccessLevelAddOnly (Photos/PHPhotoLibrary.h:31-33)
    return this.named(
      limited,
      new ObjectiveCClass(
        '/System/Library/Frameworks/Photos.framework/Photos',
        'PHPhotoLibrary',
      ).integer('authorizationStatusForAccessLevel:', 1),
    );
  }
}
