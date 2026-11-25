import { type Limited, limited } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Photos extends PromptedService<Limited> {
  readonly name = 'kTCCServicePhotos';
  protected readonly paneKey = 'PHOTOS';
  protected readonly anchor = 'Privacy_Photos';

  protected readonly requestScript = JxaRequest.decided(
    ['Photos'],
    "C('PHPhotoLibrary').requestAuthorizationForAccessLevelHandler(2, () => {});",
    "Number(C('PHPhotoLibrary').authorizationStatusForAccessLevel(2)) === 0",
  ).source;

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
