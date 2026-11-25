import { Service } from '../service.ts';

export class PhotosAdd extends Service {
  readonly name = 'kTCCServicePhotosAdd';
  readonly pane = 'Photos';
  protected readonly anchor = 'Privacy_Photos';
}
