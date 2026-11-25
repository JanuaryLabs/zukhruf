import { type FullAccess, fullAccess } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Calendars extends PromptedService<FullAccess> {
  readonly name = 'kTCCServiceCalendar';
  readonly pane = 'Calendars';
  protected readonly anchor = 'Privacy_Calendars';

  status(): FullAccess {
    // EKEntityTypeEvent (EventKit/EKTypes.h:189)
    return this.named(
      fullAccess,
      new ObjectiveCClass(
        '/System/Library/Frameworks/EventKit.framework/EventKit',
        'EKEventStore',
      ).integer('authorizationStatusForEntityType:', 0),
    );
  }
}
