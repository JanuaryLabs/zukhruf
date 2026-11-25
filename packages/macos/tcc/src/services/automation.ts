import { Service } from '../service.ts';

// The grant to send Apple events to one target app (AppleEvents.h:346).
export class Automation extends Service {
  readonly name = 'kTCCServiceAppleEvents';
  readonly pane = 'Automation';
  protected readonly anchor = 'Privacy_Automation';
  // The bundle identifier of the target app.
  readonly target: string;

  constructor(target: string) {
    super();
    this.target = target;
  }
}
