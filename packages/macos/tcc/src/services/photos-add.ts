import { type Limited, limited } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class PhotosAdd extends PromptedService<Limited> {
  readonly name = 'kTCCServicePhotosAdd';
  protected readonly paneKey = 'PHOTOS';
  protected readonly anchor = 'Privacy_Photos';

  protected readonly requestScript = JxaRequest.decided(
    ['Photos'],
    "C('PHPhotoLibrary').requestAuthorizationForAccessLevelHandler(1, () => {});",
    "Number(C('PHPhotoLibrary').authorizationStatusForAccessLevel(1)) === 0",
  ).source;

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
