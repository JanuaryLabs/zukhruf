# Each service is a class, and its status has Apple's values

> **Design for review.**

The services differ in what they can tell. Contacts has a status with the values of `CNAuthorizationStatus`: `NotDetermined`, `Restricted`, `Denied`, `Authorized` (and `Limited`, which is iOS only) (`Contacts.framework/Headers/CNContactStore.h:35-47`, MacOSX27.2.sdk). Calendars and Reminders have the values of `EKAuthorizationStatus`: `NotDetermined`, `Restricted`, `Denied`, `FullAccess`, `WriteOnly` (`EventKit.framework/Headers/EKTypes.h:27-35`). Full Disk Access has no status ([ADR 0003](./0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md)).

.NET MAUI models each permission as a class (`Permissions.ContactsRead`, `Permissions.CalendarRead`, `Permissions.Reminders`) over a `BasePermission` (dotnet/maui `src/Essentials/src/Permissions/Permissions.shared.cs:129-364`). It maps every platform to one `PermissionStatus` (`Unknown, Denied, Disabled, Granted, Restricted, Limited`). That map loses values: on Mac Catalyst, `WriteOnly` of EventKit becomes `Unknown` (`Permissions.ios.watchos.cs:15-38`).

## Decision

Each service is a class over an abstract `Service`, which holds the name, the pane, the URL, `remedy()` and `openSettings()`. Only a service that has a status has `status()`, and it returns Apple's own values, in camel case: `'notDetermined' | 'restricted' | 'denied' | 'authorized'` for Contacts, and `'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly'` for Calendars and Reminders. `FullDiskAccess` has `preflight()` in place of `status()`.

## Considered Options

- **One status type for every service**, as MAUI. It cannot hold `writeOnly`, and it gives Full Disk Access a status that macOS does not have.
- **A table of services indexed by name.** The repository models a set of things that share an algorithm as classes, not as a table.
- **A class for each service, with the values of its framework.** This option was selected. A call of `status()` on Full Disk Access does not compile, and each value is one that macOS can give.

## Consequences

- `Limited` is left out: the SDK marks it iOS only.
- A new service with a status is a new class, with the values of its framework.
