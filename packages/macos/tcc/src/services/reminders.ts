import { type FullAccess, fullAccess } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Reminders extends PromptedService<FullAccess> {
  readonly name = 'kTCCServiceReminders';
  readonly pane = 'Reminders';
  protected readonly anchor = 'Privacy_Reminders';

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
