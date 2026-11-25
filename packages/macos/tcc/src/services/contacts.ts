import { type Authorized, authorized } from '../authorization-statuses.ts';
import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

export class Contacts extends PromptedService<Authorized> {
  readonly name = 'kTCCServiceAddressBook';
  readonly pane = 'Contacts';
  protected readonly anchor = 'Privacy_Contacts';

  protected readonly requestScript = JxaRequest.decided(
    ['Contacts'],
    "const store = C('CNContactStore').alloc.init;\nstore.requestAccessForEntityTypeCompletionHandler(0, () => {});",
    "Number(C('CNContactStore').authorizationStatusForEntityType(0)) === 0",
  ).source;

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
