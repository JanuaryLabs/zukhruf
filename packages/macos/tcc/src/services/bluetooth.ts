import { Service } from '../service.ts';

export class Bluetooth extends Service {
  readonly name = 'kTCCServiceBluetoothAlways';
  readonly pane = 'Bluetooth';
  protected readonly anchor = 'Privacy_Bluetooth';
}
