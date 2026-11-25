import { type FullAccess, fullAccess } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Reminders extends PromptedService<FullAccess> {
  readonly name = 'kTCCServiceReminders';
  protected readonly paneKey = 'REMINDERS';
  protected readonly anchor = 'Privacy_Reminders';

  protected readonly requestScript = JxaRequest.decided(
    ['EventKit'],
    "const store = C('EKEventStore').alloc.init;\nstore.requestFullAccessToRemindersWithCompletion(() => {});",
    "[0, 4].includes(Number(C('EKEventStore').authorizationStatusForEntityType(1)))",
  ).source;

  status(): FullAccess {
    // EKEntityTypeReminder (EventKit/EKTypes.h:189)
    return this.named(
      fullAccess,
      new ObjectiveCClass(
        '/System/Library/Frameworks/EventKit.framework/EventKit',
        'EKEventStore',
      ).integer('authorizationStatusForEntityType:', 1),
    );
  }
}
