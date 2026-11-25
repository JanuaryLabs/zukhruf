import { nodeFfi } from '../native/node-ffi.ts';
import { PromptedService } from '../prompted-service.ts';

// IOHIDAccessType (IOKit/hidsystem/IOHIDLib.h:171-178): Granted is 0.
const values = ['granted', 'denied', 'unknown'] as const;
type InputMonitoringStatus = (typeof values)[number];

export class InputMonitoring extends PromptedService<InputMonitoringStatus> {
  readonly name = 'kTCCServiceListenEvent';
  readonly pane = 'Input Monitoring';
  protected readonly anchor = 'Privacy_ListenEvent';

  status(): InputMonitoringStatus {
    using iokit = new (nodeFfi().DynamicLibrary)(
      '/System/Library/Frameworks/IOKit.framework/IOKit',
    );
    // kIOHIDRequestTypeListenEvent (IOKit/hidsystem/IOHIDLib.h:192)
    return this.named(
      values,
      iokit.getFunction('IOHIDCheckAccess', {
        arguments: ['uint32'],
        return: 'uint32',
      })(1),
    );
  }
}
