import { type FullAccess, fullAccess } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Calendars extends PromptedService<FullAccess> {
  readonly name = 'kTCCServiceCalendar';
  protected readonly paneKey = 'CALENDARS';
  protected readonly anchor = 'Privacy_Calendars';

  protected readonly requestScript = JxaRequest.decided(
    ['EventKit'],
    "const store = C('EKEventStore').alloc.init;\nstore.requestFullAccessToEventsWithCompletion(() => {});",
    "[0, 4].includes(Number(C('EKEventStore').authorizationStatusForEntityType(0)))",
  ).source;

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
