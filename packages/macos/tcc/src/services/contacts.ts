import { Service } from '../service.ts';

export class Contacts extends Service {
  readonly name = 'kTCCServiceAddressBook';
  readonly pane = 'Contacts';
  protected readonly anchor = 'Privacy_Contacts';
}
