import type { AbsolutePath } from './absolute-path.ts';

interface UnixDomainSocketKeys {
  SockPathOwner?: number;
  SockPathGroup?: number;
  /** Decimal: property lists have no octal. */
  SockPathMode?: number;
}

interface NetworkSocketKeys {
  SockNodeName?: string;
  /** A port number, or a service name such as 'ssh'. */
  SockServiceName?: string | number;
  SockFamily?: 'IPv4' | 'IPv6' | 'IPv4v6';
  SockProtocol?: 'TCP' | 'UDP';
  Bonjour?: boolean | string | readonly string[];
  MulticastGroup?: string;
}

type Absent<Keys> = { [Key in keyof Keys]?: never };

/** One socket: a Unix domain socket at a path, a secure Unix domain socket, or a network socket. A form never takes the keys of another form. */
export type Socket = {
  SockType?: 'stream' | 'dgram' | 'seqpacket';
  /** true (the default) listens; false connects. */
  SockPassive?: boolean;
} & (
  | ({
      SockPathName: AbsolutePath;
      SecureSocketWithKey?: never;
    } & UnixDomainSocketKeys &
      Absent<NetworkSocketKeys>)
  | ({
      SockPathName?: never;
      /** The name of the environment variable that gets the path. */
      SecureSocketWithKey: string;
    } & UnixDomainSocketKeys &
      Absent<NetworkSocketKeys>)
  | ({ SockPathName?: never; SecureSocketWithKey?: never } & NetworkSocketKeys &
      Absent<UnixDomainSocketKeys>)
);
