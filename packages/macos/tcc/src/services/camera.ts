import { Service } from '../service.ts';

export class Camera extends Service {
  readonly name = 'kTCCServiceCamera';
  readonly pane = 'Camera';
  protected readonly anchor = 'Privacy_Camera';
}
