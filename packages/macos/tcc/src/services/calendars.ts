import { Service } from '../service.ts';

export class Calendars extends Service {
  readonly name = 'kTCCServiceCalendar';
  readonly pane = 'Calendars';
  protected readonly anchor = 'Privacy_Calendars';
}
