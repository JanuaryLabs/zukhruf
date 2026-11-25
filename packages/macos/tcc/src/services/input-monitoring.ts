import { Service } from '../service.ts';

export class InputMonitoring extends Service {
  readonly name = 'kTCCServiceListenEvent';
  readonly pane = 'Input Monitoring';
  protected readonly anchor = 'Privacy_ListenEvent';
}
