/** The limits of setrlimit(2), in bytes, seconds or counts. */
export interface ResourceLimits {
  Core?: number;
  CPU?: number;
  Data?: number;
  FileSize?: number;
  MemoryLock?: number;
  NumberOfFiles?: number;
  NumberOfProcesses?: number;
  ResidentSetSize?: number;
  Stack?: number;
}
