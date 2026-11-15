import type { PropertyListValue } from './property-list-value.ts';

/** The two event streams of xpc_events(3). The keys of a stream are event names of your own. */
export interface LaunchEvents {
  'com.apple.iokit.matching'?: Readonly<Record<string, MatchingDictionary>>;
  'com.apple.notifyd.matching'?: Readonly<
    Record<string, { Notification: string }>
  >;
}

/** An IOKit matching dictionary. Its other keys are the matching keys of IOKitKeys.h and the properties that the device must have, such as idVendor. */
export type MatchingDictionary = {
  /** Required by xpc_events(3). launchd removes it before IOKit matches. */
  IOMatchLaunchStream: true;
  IOProviderClass?: string;
  [key: string]: PropertyListValue;
};
