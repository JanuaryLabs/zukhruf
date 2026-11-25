import type { AbsolutePath } from './absolute-path.ts';
import type { CalendarInterval } from './calendar-interval.ts';
import type { KeepAliveConditions } from './keep-alive-conditions.ts';
import type { LaunchEvents } from './launch-events.ts';
import type { MachService } from './mach-service.ts';
import type { ResourceLimits } from './resource-limits.ts';
import type { Socket } from './socket.ts';

/** The keys of launchd.plist(5) that agents and daemons share: `Program`, or a non-empty `ProgramArguments`, or both. */
export type Job = {
  /** Unique in the domain. The job file is <Label>.plist. */
  Label: string;
  inetdCompatibility?: { Wait?: boolean };
  /** Keys of the "hw" sysctl(3) domain, such as model. */
  LimitLoadToHardware?: Readonly<Record<string, readonly string[]>>;
  LimitLoadFromHardware?: Readonly<Record<string, readonly string[]>>;
  EnableGlobbing?: boolean;
  EnableTransactions?: boolean;
  EnablePressuredExit?: boolean;
  KeepAlive?: boolean | KeepAliveConditions;
  RunAtLoad?: boolean;
  RootDirectory?: AbsolutePath;
  WorkingDirectory?: AbsolutePath;
  EnvironmentVariables?: Readonly<Record<string, string>>;
  /** A decimal integer, or a string that strtoul(3) reads: '022' is octal. */
  Umask?: number | string;
  /** Seconds from SIGTERM to SIGKILL. 0 is infinity: do not use it. */
  ExitTimeOut?: number;
  /** Seconds between two starts. 10 by default. */
  ThrottleInterval?: number;
  WatchPaths?: readonly AbsolutePath[];
  QueueDirectories?: readonly AbsolutePath[];
  StartOnMount?: boolean;
  /** Seconds. A start that falls in a sleep is missed. */
  StartInterval?: number;
  StartCalendarInterval?: CalendarInterval | readonly CalendarInterval[];
  StandardInPath?: AbsolutePath;
  StandardOutPath?: AbsolutePath;
  StandardErrorPath?: AbsolutePath;
  Debug?: boolean;
  WaitForDebugger?: boolean;
  SoftResourceLimits?: ResourceLimits;
  HardResourceLimits?: ResourceLimits;
  Nice?: number;
  ProcessType?: 'Background' | 'Standard' | 'Adaptive' | 'Interactive';
  AbandonProcessGroup?: boolean;
  LowPriorityIO?: boolean;
  LowPriorityBackgroundIO?: boolean;
  MaterializeDatalessFiles?: boolean;
  LaunchOnlyOnce?: boolean;
  /** Each key is the name of a Mach service. The program must check in for it. */
  MachServices?: Readonly<Record<string, true | MachService>>;
  /** Each key is a name of your own for a socket or a group of sockets. */
  Sockets?: Readonly<Record<string, Socket | readonly Socket[]>>;
  LaunchEvents?: LaunchEvents;
  SessionCreate?: boolean;
  LegacyTimers?: boolean;
  AssociatedBundleIdentifiers?: string | readonly string[];
} & (
  | { Program: AbsolutePath; ProgramArguments?: readonly string[] }
  | { Program?: never; ProgramArguments: readonly [string, ...string[]] }
);
