import type { PropertyListValue } from './property-list-value.ts';

/** The two event streams of xpc_events(3). The keys of a stream are event names of your own. */
export interface LaunchEvents {
  'com.apple.iokit.matching'?: Readonly<Record<string, MatchingDictionary>>;
  'com.apple.notifyd.matching'?: Readonly<
    Record<string, { Notification: string }>
  >;
}

/** An IOKit matching dictionary. Its other keys are the matching keys of IOKitKeys.h and the properties that the device must have, such as idVendor. */
// The index signature is its own member of the intersection: in one object
// type, a consumer without exactOptionalPropertyTypes reads the optional
// IOProviderClass as string | undefined and rejects it against the index
// (TS2411 in the published .d.ts).
export type MatchingDictionary = {
  /** Required by xpc_events(3). launchd removes it before IOKit matches. */
  IOMatchLaunchStream: true;
  IOProviderClass?: string;
} & { readonly [key: string]: PropertyListValue };
