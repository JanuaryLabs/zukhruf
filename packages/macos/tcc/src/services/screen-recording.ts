import { Service } from '../service.ts';

export class ScreenRecording extends Service {
  readonly name = 'kTCCServiceScreenCapture';
  readonly pane = 'Screen Recording';
  protected readonly anchor = 'Privacy_ScreenCapture';
}
