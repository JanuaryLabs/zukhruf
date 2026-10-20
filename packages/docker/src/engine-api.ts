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
