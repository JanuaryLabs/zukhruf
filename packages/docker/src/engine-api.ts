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
