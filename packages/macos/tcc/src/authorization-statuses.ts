// Apple's status values, in the order of their raw values in the SDK headers
// of macOS 27 (MacOSX27.2.sdk).

// AVAuthorizationStatus (AVFoundation/AVCaptureDevice.h:2159-2163), and
// CNAuthorizationStatus (Contacts/CNContactStore.h:35-47) without the
// iOS-only Limited.
export const authorized = [
  'notDetermined',
  'restricted',
  'denied',
  'authorized',
] as const;
export type Authorized = (typeof authorized)[number];

// EKAuthorizationStatus (EventKit/EKTypes.h:27-34).
export const fullAccess = [
  'notDetermined',
  'restricted',
  'denied',
  'fullAccess',
  'writeOnly',
] as const;
export type FullAccess = (typeof fullAccess)[number];

// PHAuthorizationStatus (Photos/PHPhotoLibrary.h:21-28).
export const limited = [
  'notDetermined',
  'restricted',
  'denied',
  'authorized',
  'limited',
] as const;
export type Limited = (typeof limited)[number];
