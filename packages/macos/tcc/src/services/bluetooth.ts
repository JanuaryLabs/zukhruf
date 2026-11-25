import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

// CBManagerAuthorization (CoreBluetooth/CBManager.h:62-67).
const values = [
  'notDetermined',
  'restricted',
  'denied',
  'allowedAlways',
] as const;
type BluetoothStatus = (typeof values)[number];

export class Bluetooth extends PromptedService<BluetoothStatus> {
  readonly name = 'kTCCServiceBluetoothAlways';
  protected readonly paneKey = 'BLUETOOTH';
  protected readonly anchor = 'Privacy_Bluetooth';

  protected readonly requestScript = JxaRequest.decided(
    ['CoreBluetooth'],
    "// macOS asks for Bluetooth when a central manager is created.\nconst manager = C('CBCentralManager').alloc.initWithDelegateQueue(null, null);",
    "Number(C('CBManager').authorization) === 0",
  ).source;

  status(): BluetoothStatus {
    // The class property CBManager.authorization (CoreBluetooth/CBManager.h:86)
    return this.named(
      values,
      new ObjectiveCClass(
        '/System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth',
        'CBManager',
      ).integer('authorization'),
    );
  }
}
