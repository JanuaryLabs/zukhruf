// The bodies and answers of the Engine API, with the names of its reference
// (https://docs.docker.com/reference/api/engine/). Types only.

/** The answer of GET /info. Each field is optional, as in the reference. */
export interface SystemInfo {
  ID?: string;
  Name?: string;
  ServerVersion?: string;
  OperatingSystem?: string;
  OSType?: string;
  Architecture?: string;
  KernelVersion?: string;
  NCPU?: number;
  MemTotal?: number;
  Containers?: number;
  ContainersRunning?: number;
  ContainersPaused?: number;
  ContainersStopped?: number;
  Images?: number;
  Driver?: string;
  DockerRootDir?: string;
  Labels?: string[];
}

/** One published binding of a port, as the reference names it. */
export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

/** The configuration of a container that does not depend on the host. */
export interface ContainerConfig {
  Hostname?: string;
  Domainname?: string;
  User?: string;
  AttachStdin?: boolean;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  ExposedPorts?: Record<string, Record<string, never>>;
  Tty?: boolean;
  OpenStdin?: boolean;
  StdinOnce?: boolean;
  Env?: string[];
  Cmd?: string[];
  Healthcheck?: {
    Test?: string[];
    Interval?: number;
    Timeout?: number;
    Retries?: number;
    StartPeriod?: number;
    StartInterval?: number;
  };
  Image?: string;
  Volumes?: Record<string, Record<string, never>>;
  WorkingDir?: string;
  Entrypoint?: string[];
  NetworkDisabled?: boolean;
  Labels?: Record<string, string>;
  StopSignal?: string;
  StopTimeout?: number;
}

/** A mount of a container, as HostConfig.Mounts takes it. */
export interface Mount {
  Target?: string;
  Source?: string;
  Type?: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster' | 'image';
  ReadOnly?: boolean;
  Consistency?: string;
  BindOptions?: { Propagation?: string; CreateMountpoint?: boolean };
  VolumeOptions?: {
    NoCopy?: boolean;
    Labels?: Record<string, string>;
    Subpath?: string;
  };
  TmpfsOptions?: { SizeBytes?: number; Mode?: number };
}

/** The configuration of a container that depends on the host. */
export interface HostConfig {
  Binds?: string[];
  Mounts?: Mount[];
  NetworkMode?: string;
  PortBindings?: Record<string, PortBinding[]>;
  PublishAllPorts?: boolean;
  RestartPolicy?: {
    Name?: '' | 'no' | 'always' | 'unless-stopped' | 'on-failure';
    MaximumRetryCount?: number;
  };
  AutoRemove?: boolean;
  Memory?: number;
  NanoCpus?: number;
  CpuShares?: number;
  Privileged?: boolean;
  ReadonlyRootfs?: boolean;
  CapAdd?: string[];
  CapDrop?: string[];
  ExtraHosts?: string[];
  Init?: boolean;
  ShmSize?: number;
  Tmpfs?: Record<string, string>;
  SecurityOpt?: string[];
  UsernsMode?: string;
  PidsLimit?: number;
}

/** The settings of a container on one network. */
export interface EndpointSettings {
  Aliases?: string[];
  Links?: string[];
  NetworkID?: string;
  EndpointID?: string;
  Gateway?: string;
  IPAddress?: string;
  MacAddress?: string;
  DriverOpts?: Record<string, string>;
}

/** The networks that a create connects the container to. */
export interface NetworkingConfig {
  EndpointsConfig?: Record<string, EndpointSettings>;
}

/** The body of POST /containers/create, as container.CreateRequest of Moby names it. */
export type ContainerCreateRequest = ContainerConfig & {
  HostConfig?: HostConfig;
  NetworkingConfig?: NetworkingConfig;
};

/** The answer of POST /containers/create. */
export interface ContainerCreateResponse {
  Id: string;
  Warnings: string[];
}

export interface ContainerState {
  Status?:
    | 'created'
    | 'running'
    | 'paused'
    | 'restarting'
    | 'removing'
    | 'exited'
    | 'dead';
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
  OOMKilled?: boolean;
  Dead?: boolean;
  Pid?: number;
  ExitCode?: number;
  Error?: string;
  StartedAt?: string;
  FinishedAt?: string;
  Health?: { Status?: 'none' | 'starting' | 'healthy' | 'unhealthy' };
}

/** A mount of a container, as an inspect gives it. */
export interface MountPoint {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  Driver?: string;
  Mode?: string;
  RW?: boolean;
  Propagation?: string;
}

/** The answer of GET /containers/{id}/json. */
export interface ContainerInspectResponse {
  Id: string;
  Created?: string;
  Path?: string;
  Args?: string[];
  State?: ContainerState;
  Image?: string;
  Name?: string;
  RestartCount?: number;
  Platform?: string;
  HostConfig?: HostConfig;
  Mounts?: MountPoint[];
  Config?: ContainerConfig;
  NetworkSettings?: {
    /** null for an exposed port that is not published. */
    Ports?: Record<string, PortBinding[] | null>;
    Networks?: Record<string, EndpointSettings>;
  };
}

/** One container of GET /containers/json. */
export interface ContainerSummary {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  Command?: string;
  Created?: number;
  Ports?: {
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: 'tcp' | 'udp' | 'sctp';
  }[];
  Labels?: Record<string, string>;
  State?: ContainerState['Status'];
  Status?: string;
  Mounts?: MountPoint[];
}

/** The answer of POST /containers/{id}/wait. */
export interface ContainerWaitResponse {
  StatusCode: number;
  Error?: { Message?: string } | null;
}

/** The answer of GET /images/{name}/json. */
export interface ImageInspect {
  Id: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Created?: string;
  Architecture?: string;
  Variant?: string;
  Os?: string;
  Size?: number;
  Config?: ContainerConfig;
}

/** Explicit credentials of a registry, as the X-Registry-Auth header takes them. */
export type AuthConfig =
  | {
      username: string;
      password: string;
      serveraddress?: string;
      email?: string;
    }
  | { identitytoken: string; serveraddress?: string };

/**
 * The body of POST /containers/{id}/exec, without the fields that the package
 * sets: AttachStdin, AttachStdout, AttachStderr and Detach.
 */
export interface ExecConfig {
  Cmd: string[];
  Tty?: boolean;
  /** [height, width] of the TTY. */
  ConsoleSize?: [number, number] | null;
  DetachKeys?: string;
  Env?: string[];
  Privileged?: boolean;
  User?: string;
  WorkingDir?: string;
}

/** The answer of GET /exec/{id}/json. */
export interface ExecInspectResponse {
  ID: string;
  ContainerID?: string;
  Running: boolean;
  /** null while the command runs. */
  ExitCode: number | null;
  Pid?: number;
  OpenStdin?: boolean;
  OpenStdout?: boolean;
  OpenStderr?: boolean;
  CanRemove?: boolean;
  DetachKeys?: string;
  ProcessConfig?: {
    privileged?: boolean;
    user?: string;
    tty?: boolean;
    entrypoint?: string;
    arguments?: string[];
  };
}

/** One message of GET /events. */
export interface EventMessage {
  Type?:
    | 'builder'
    | 'config'
    | 'container'
    | 'daemon'
    | 'image'
    | 'network'
    | 'node'
    | 'plugin'
    | 'secret'
    | 'service'
    | 'volume';
  /** Such as 'create', 'start', 'die' or 'health_status: healthy'. */
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  scope?: 'local' | 'swarm';
  /** Seconds since the Unix epoch. */
  time?: number;
  /** Nanoseconds since the Unix epoch. */
  timeNano?: number;
}

/** The JSON of the header X-Docker-Container-Path-Stat, as container.PathStat of Moby names it. */
export interface ContainerPathStat {
  name: string;
  size: number;
  /** The FileMode of Go: the permission bits, and high bits for the kind of the entry. */
  mode: number;
  mtime: string;
  /** The target of a symlink; '' for each other entry. */
  linkTarget: string;
}

/** A volume, as GET /volumes/{name} gives it. */
export interface Volume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt?: string;
  Status?: Record<string, unknown>;
  Labels: Record<string, string> | null;
  Scope: 'local' | 'global';
  Options: Record<string, string> | null;
  UsageData?: { Size: number; RefCount: number } | null;
}

/** The body of POST /volumes/create. The engine gives the volume a name when it has none. */
export interface VolumeCreateRequest {
  Name?: string;
  Driver?: string;
  DriverOpts?: Record<string, string>;
  Labels?: Record<string, string>;
}

/** The answer of GET /volumes. */
export interface VolumeListResponse {
  Volumes: Volume[] | null;
  Warnings: string[] | null;
}

/** The address management of a network. */
export interface IPAM {
  Driver?: string;
  Config?: {
    Subnet?: string;
    IPRange?: string;
    Gateway?: string;
    AuxiliaryAddresses?: Record<string, string>;
  }[];
  Options?: Record<string, string>;
}

/** The body of POST /networks/create. */
export interface NetworkCreateRequest {
  Name: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Attachable?: boolean;
  Ingress?: boolean;
  ConfigOnly?: boolean;
  ConfigFrom?: { Network?: string };
  IPAM?: IPAM;
  EnableIPv4?: boolean;
  EnableIPv6?: boolean;
  Options?: Record<string, string>;
  Labels?: Record<string, string>;
}

/** A network, as GET /networks gives each one. */
export interface NetworkSummary {
  Name: string;
  Id: string;
  Created?: string;
  Scope?: string;
  Driver?: string;
  EnableIPv4?: boolean;
  EnableIPv6?: boolean;
  IPAM?: IPAM;
  Internal?: boolean;
  Attachable?: boolean;
  Ingress?: boolean;
  ConfigFrom?: { Network?: string };
  ConfigOnly?: boolean;
  Options?: Record<string, string>;
  Labels?: Record<string, string>;
}

/** A network, as GET /networks/{id} gives it: the summary and the containers that are connected. */
export interface NetworkInspect extends NetworkSummary {
  /** The connected containers, by their IDs. Only a running container has an endpoint. */
  Containers?: Record<
    string,
    {
      Name?: string;
      EndpointID?: string;
      MacAddress?: string;
      IPv4Address?: string;
      IPv6Address?: string;
    }
  >;
}

/** The body of POST /networks/{id}/connect. */
export interface NetworkConnectRequest {
  Container: string;
  EndpointConfig?: EndpointSettings;
}

/** One image of GET /images/json. */
export interface ImageSummary {
  Id: string;
  ParentId: string;
  RepoTags: string[];
  RepoDigests: string[];
  Created: number;
  Size: number;
  SharedSize: number;
  Labels: Record<string, string> | null;
  Containers: number;
}
