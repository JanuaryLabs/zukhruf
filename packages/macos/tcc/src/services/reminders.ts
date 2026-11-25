import { Service } from '../service.ts';

export class Reminders extends Service {
  readonly name = 'kTCCServiceReminders';
  readonly pane = 'Reminders';
  protected readonly anchor = 'Privacy_Reminders';
}
