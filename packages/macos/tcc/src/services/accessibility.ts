import { Service } from '../service.ts';

export class Accessibility extends Service {
  readonly name = 'kTCCServiceAccessibility';
  readonly pane = 'Device Control and Data Access';
  protected readonly anchor = 'Privacy_Accessibility';
}
