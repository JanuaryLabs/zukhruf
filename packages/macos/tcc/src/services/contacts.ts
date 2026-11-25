import { type Authorized, authorized } from '../authorization-statuses.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Contacts extends PromptedService<Authorized> {
  readonly name = 'kTCCServiceAddressBook';
  readonly pane = 'Contacts';
  protected readonly anchor = 'Privacy_Contacts';

  status(): Authorized {
    // CNEntityTypeContacts (Contacts/CNContactStore.h:74)
    return this.named(
      authorized,
      new ObjectiveCClass(
        '/System/Library/Frameworks/Contacts.framework/Contacts',
        'CNContactStore',
      ).integer('authorizationStatusForEntityType:', 0),
    );
  }
}
