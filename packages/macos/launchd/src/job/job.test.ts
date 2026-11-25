import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AbsolutePath,
  type AgentJob,
  type DaemonJob,
  isAbsolutePath,
} from '../index.ts';

test('a job that launchd refuses, misreads or ignores fails the type check', () => {
  // A function that is never called: the type checker reads it, and an @ts-expect-error with no error fails the typecheck.
  const illegal = () => {
    // @ts-expect-error a job names its program: Program or ProgramArguments (launchd.plist(5), lines 128-129, 139).
    const noProgram: AgentJob = { Label: 'com.example.none' };
    // @ts-expect-error with no Program, item 0 of ProgramArguments is the program.
    const noArguments: AgentJob = {
      Label: 'com.example.none',
      ProgramArguments: [],
    };
    // Sockets built apart from a job literal get no excess-property check: only the type of each form refuses the keys of another.
    const pathAndNode = {
      SockPathName: '/tmp/a.sock',
      SockNodeName: 'localhost',
    } as const;
    const pathAndSecure = {
      SockPathName: '/tmp/a.sock',
      SecureSocketWithKey: 'A_SOCK',
    } as const;
    const secureAndService = {
      SecureSocketWithKey: 'A_SOCK',
      SockServiceName: 80,
    } as const;
    const serviceAndMode = {
      SockServiceName: 8080,
      SockPathMode: 384,
    } as const;
    const agents: AgentJob[] = [
      // @ts-expect-error "The Program key must be an absolute path" (lines 142-143).
      { Label: 'com.example.relative', Program: 'bin/sync' },
      {
        Label: 'com.example.log',
        Program: '/bin/date',
        // @ts-expect-error launchd expands no `~`: each path is absolute.
        StandardErrorPath: '~/Library/Logs/date.log',
      },
      {
        Label: 'com.example.watch',
        Program: '/bin/date',
        // @ts-expect-error launchd expands no `~`: each path is absolute.
        WatchPaths: ['inbox'],
      },
      {
        Label: 'com.example.path-state',
        Program: '/bin/date',
        // @ts-expect-error launchd expands no `~`: each path is absolute.
        KeepAlive: { PathState: { 'run/on': true } },
      },
      {
        Label: 'com.example.calendar',
        Program: '/bin/date',
        StartCalendarInterval: [
          // @ts-expect-error The minute is 0-59 (lines 380-381).
          { Minute: 60 },
          // @ts-expect-error The hour is 0-23 (lines 383-384).
          { Hour: 24 },
          // @ts-expect-error The day of the month is 1-31 (lines 386-387).
          { Day: 0 },
          // @ts-expect-error The weekday is 0-7 (lines 389-390).
          { Weekday: 8 },
          // @ts-expect-error The month is 1-12 (lines 394-395).
          { Month: 13 },
        ],
      },
      {
        Label: 'com.example.sockets',
        Program: '/bin/date',
        Sockets: {
          // @ts-expect-error SockPathName implies the Unix family (lines 617-619): no node name.
          path: pathAndNode,
          // @ts-expect-error SecureSocketWithKey is a variant of SockPathName (lines 621-625), not both.
          secure: pathAndSecure,
          // @ts-expect-error A secure socket is a Unix domain socket: no service name.
          secureNetwork: secureAndService,
          // @ts-expect-error The mode of a network socket has no meaning.
          network: serviceAndMode,
        },
      },
      {
        Label: 'com.example.iokit',
        Program: '/bin/date',
        LaunchEvents: {
          'com.apple.iokit.matching': {
            // @ts-expect-error IOMatchLaunchStream is required (xpc_events(3), lines 89-92).
            missing: { IOProviderClass: 'IOUSBDevice' },
            // @ts-expect-error IOMatchLaunchStream is a Boolean set to true.
            off: { IOMatchLaunchStream: false, IOProviderClass: 'IOUSBDevice' },
            // @ts-expect-error A property list has no null.
            empty: { IOMatchLaunchStream: true, idVendor: null },
          },
        },
      },
      {
        Label: 'com.example.activity',
        Program: '/bin/date',
        LaunchEvents: {
          // @ts-expect-error "currently the only two supported event streams" are iokit and notifyd (xpc_events(3), lines 29-34).
          'com.apple.xpc.activity': { nightly: { Interval: 86_400 } },
        },
      },
      // @ts-expect-error UserName applies only in the system domain (lines 74-77).
      { Label: 'com.example.user', Program: '/bin/date', UserName: 'nobody' },
      // @ts-expect-error GroupName applies only in the system domain (lines 79-83).
      { Label: 'com.example.group', Program: '/bin/date', GroupName: 'staff' },
      // @ts-expect-error InitGroups is ignored without UserName (lines 333-337).
      { Label: 'com.example.groups', Program: '/bin/date', InitGroups: true },
      // @ts-expect-error "Please remove this key from your launchd.plist" (lines 177-180).
      { Label: 'com.example.demand', Program: '/bin/date', OnDemand: false },
      // @ts-expect-error The override of enable replaces Disabled (lines 67-72).
      { Label: 'com.example.disabled', Program: '/bin/date', Disabled: true },
      // @ts-expect-error TimeOut "is no longer implemented" (lines 313-317).
      { Label: 'com.example.idle', Program: '/bin/date', TimeOut: 30 },
      {
        Label: 'com.example.bundle',
        Program: '/bin/date',
        // @ts-expect-error BundleProgram is only for SMAppService (lines 131-134).
        BundleProgram: 'Contents/MacOS/a',
      },
      {
        Label: 'com.example.network',
        Program: '/bin/date',
        // @ts-expect-error NetworkState "is no longer implemented" (lines 215-217).
        KeepAlive: { NetworkState: true },
      },
    ];
    const daemons: DaemonJob[] = [
      {
        Label: 'com.example.session',
        Program: '/bin/date',
        // @ts-expect-error LimitLoadToSessionType "only applies to jobs which are agents" (lines 104-107).
        LimitLoadToSessionType: 'Background',
      },
    ];
    return [noProgram, noArguments, ...agents, ...daemons];
  };

  assert.equal(typeof illegal, 'function');
});

test('the jobs of the README, of launchd.plist(5) and of xpc_events(3) type check', () => {
  const agents: AgentJob[] = [
    {
      Label: 'com.example.sync',
      ProgramArguments: ['/opt/homebrew/bin/node', '/Users/me/sync/main.js'],
      KeepAlive: true,
      StandardErrorPath: '/Users/me/Library/Logs/sync.log',
    },
    {
      Label: 'com.example.nightly',
      ProgramArguments: ['/opt/homebrew/bin/node', '/Users/me/nightly/main.js'],
      EnvironmentVariables: {
        HOME: '/Users/me',
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      },
      StartCalendarInterval: [
        { Hour: 3, Minute: 0 },
        { Weekday: 0, Hour: 12, Minute: 30 },
      ],
      StandardOutPath: '/Users/me/Library/Logs/nightly.log',
      StandardErrorPath: '/Users/me/Library/Logs/nightly.log',
      ProcessType: 'Background',
      LimitLoadToSessionType: ['Aqua', 'Background'],
    },
    {
      Label: 'com.example.watcher',
      Program: '/usr/local/bin/watcher',
      KeepAlive: {
        SuccessfulExit: false,
        PathState: { '/Users/me/.watcher-on': true },
      },
      ThrottleInterval: 30,
      SoftResourceLimits: { NumberOfFiles: 4096 },
      HardResourceLimits: { NumberOfFiles: 8192 },
    },
    {
      Label: 'com.example.server',
      Program: '/usr/local/bin/server',
      Sockets: {
        Listeners: { SockNodeName: '127.0.0.1', SockServiceName: 8080 },
        Local: [
          { SockPathName: '/tmp/server.sock', SockPathMode: 384 },
          { SecureSocketWithKey: 'SERVER_SOCK', SockType: 'dgram' },
        ],
      },
    },
    {
      Label: 'com.example.on-device',
      Program: '/usr/local/libexec/on-device',
      LaunchEvents: {
        'com.apple.iokit.matching': {
          'Device was attached': {
            IOMatchLaunchStream: true,
            IOProviderClass: 'IOUSBDevice',
            idVendor: 725,
            idProduct: 2794,
          },
        },
        'com.apple.notifyd.matching': {
          'interesting-notification was posted': {
            Notification: 'com.apple.interesting-notification',
          },
        },
      },
    },
  ];
  const daemons: DaemonJob[] = [
    {
      Label: 'com.example.backup',
      Program: '/usr/local/libexec/backup',
      UserName: '_backup',
      GroupName: '_backup',
      InitGroups: false,
      StartCalendarInterval: { Hour: 3, Minute: 0 },
    },
    {
      Label: 'com.example.exampled',
      Program: '/path/tp/exampled',
      ProgramArguments: ['exampled', 'argv1', 'argv2'],
      MachServices: { 'com.example.exampled': true },
    },
  ];

  assert.deepEqual(
    [...agents, ...daemons].map((job) => job.Label),
    [
      'com.example.sync',
      'com.example.nightly',
      'com.example.watcher',
      'com.example.server',
      'com.example.on-device',
      'com.example.backup',
      'com.example.exampled',
    ],
  );
});

test('a resolved path string is an AbsolutePath only after isAbsolutePath narrows it', () => {
  // A function that is never called: the type checker reads it, and an @ts-expect-error with no error fails the typecheck.
  const narrow = (resolved: string): readonly AbsolutePath[] => {
    // @ts-expect-error a string from path.resolve() is not known to begin with `/`.
    const unchecked: AbsolutePath = resolved;
    if (!isAbsolutePath(resolved)) throw new Error(`${resolved} is relative`);
    return [unchecked, resolved];
  };

  assert.equal(typeof narrow, 'function');
});

test('isAbsolutePath accepts a path that begins with / and refuses each path launchd would not expand', () => {
  const paths = ['/a/b', 'a/b', './a', '', '~/a'];

  assert.deepEqual(paths.filter(isAbsolutePath), ['/a/b']);
});
