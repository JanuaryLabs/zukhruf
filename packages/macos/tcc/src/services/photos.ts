import { Service } from '../service.ts';

export class Photos extends Service {
  readonly name = 'kTCCServicePhotos';
  readonly pane = 'Photos';
  protected readonly anchor = 'Privacy_Photos';
}
