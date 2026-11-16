// Sums the host memory of one container engine's processes, for experiment 6 (idle-memory).
//
// Usage: node engine-memory.ts --engine docker|docker-vmm|colima|apple --out <file.json> [--footprint]
//
// Docker Desktop on VZ, Colima and Apple run their VMs in com.apple.Virtualization.VirtualMachine
// XPC processes, whose parent is launchd, so a VM process is attributed to the engine whose owner
// process started nearest to it: com.docker.virtualization for Docker Desktop, the limactl
// hostagent of ~/.colima/_lima for Colima (Lima writes that hostagent's pid to
// ~/.colima/_lima/colima/vz.pid), and container-runtime-linux (one per running container) for
// Apple. lstart has whole-second resolution; ties between two Apple containers do not change the
// Apple total. A VM no owner claims within 60 s is listed as unattributed and counted in no engine.
// On Docker VMM the VM runs inside com.docker.krun, a Docker.app process, so docker-vmm expects no
// Virtualization VM process. OrbStack's processes are not read yet: --engine orbstack fails.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

/** The host-process families; docker and docker-vmm are both Docker Desktop's. */
type Family = 'docker-desktop' | 'colima' | 'apple';
type Role = 'helper' | 'ui' | 'vm' | 'shim';

interface Process {
  pid: number;
  ppid: number;
  rssKiB: number;
  started: Date;
  comm: string;
  args: string;
}

interface Owned extends Process {
  family: Family;
  role: Role;
  vmOwnerPid?: number;
}

const FAMILY_OF_ENGINE: Record<string, Family> = {
  docker: 'docker-desktop',
  'docker-vmm': 'docker-desktop',
  colima: 'colima',
  apple: 'apple',
};
const VM_PROCESS = 'com.apple.Virtualization.VirtualMachine';
const COLIMA_LIMA_HOME = join(homedir(), '.colima', '_lima');
const isColima = (process: Process) =>
  process.args.includes(`${COLIMA_LIMA_HOME}/`);
const VM_OWNER: Record<Family, (process: Process) => boolean> = {
  'docker-desktop': (process) =>
    basename(process.comm) === 'com.docker.virtualization',
  colima: (process) =>
    basename(process.comm) === 'limactl' &&
    process.args.split(/\s+/).includes('hostagent') &&
    isColima(process),
  apple: (process) => basename(process.comm) === 'container-runtime-linux',
};
const PAIRING_WINDOW_MS = 60_000;

const { values } = parseArgs({
  options: {
    engine: { type: 'string' },
    out: { type: 'string' },
    footprint: { type: 'boolean', default: false },
  },
});
const engine = values.engine;
if (engine === 'orbstack') {
  throw new Error(
    "orbstack: its host processes are not read yet, so nothing can be attributed to it; after install, read them with 'ps -axww -o pid,ppid,rss,lstart,args' and add its rule here and to BENCH_MEMORY_RULE in lib.zsh",
  );
}
const family = engine === undefined ? undefined : FAMILY_OF_ENGINE[engine];
if (!family) {
  throw new Error(
    `--engine must be one of ${Object.keys(FAMILY_OF_ENGINE).join(', ')}`,
  );
}
if (!values.out) {
  throw new Error('--out is required');
}

function ps(columns: string): string[] {
  return execFileSync('ps', ['-axww', '-o', columns], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function listProcesses(): Process[] {
  // args holds the arguments (Colima's limactl processes differ only there); comm is the path.
  const argsByPid = new Map(
    ps('pid=,args=').map((line) => {
      const [pid, ...rest] = line.trim().split(/\s+/);
      return [Number(pid), rest.join(' ')];
    }),
  );
  return ps('pid=,ppid=,rss=,lstart=,comm=').map((line) => {
    // lstart is five words, e.g. "Sat Nov 15 22:24:01 2026"; comm is the rest and may hold spaces.
    const words = line.trim().split(/\s+/);
    const [pid, ppid, rss] = words;
    return {
      pid: Number(pid),
      ppid: Number(ppid),
      rssKiB: Number(rss),
      started: new Date(words.slice(3, 8).join(' ')),
      comm: words.slice(8).join(' '),
      args: argsByPid.get(Number(pid)) ?? '',
    };
  });
}

function familyOf(
  process: Process,
): { family: Family; role: Role } | undefined {
  const name = basename(process.comm);
  if (
    process.comm.includes('/Applications/Docker.app/') ||
    name.startsWith('com.docker.')
  ) {
    if (process.comm.includes('/Docker Desktop.app/')) {
      return { family: 'docker-desktop', role: 'ui' };
    }
    if (name === 'com.docker.krun') {
      return { family: 'docker-desktop', role: 'vm' };
    }
    return { family: 'docker-desktop', role: 'helper' };
  }
  // Lima's ssh control master renames itself "ssh: <LIMA_HOME>/colima/ssh.sock [mux]".
  if (
    name === 'colima' ||
    ((name === 'limactl' || process.comm.startsWith('ssh')) &&
      isColima(process))
  ) {
    return { family: 'colima', role: 'helper' };
  }
  if (name === 'socktainer') {
    return { family: 'apple', role: 'shim' };
  }
  if (
    /\/Cellar\/container\/|\/opt\/container\//.test(process.comm) ||
    name.startsWith('container-')
  ) {
    return { family: 'apple', role: 'helper' };
  }
  return undefined;
}

/** Pairs each VM process with the owner process that started nearest to it, nearest pairs first. */
function attributeVms(processes: Process[]): {
  owned: Owned[];
  unattributed: Process[];
} {
  const vms = processes.filter(
    (process) => basename(process.comm) === VM_PROCESS,
  );
  const owners = processes.flatMap((process) => {
    const owner = (Object.keys(VM_OWNER) as Family[]).find((key) =>
      VM_OWNER[key](process),
    );
    return owner ? [{ process, family: owner }] : [];
  });
  const pairs = vms
    .flatMap((vm) =>
      owners.map((owner) => ({
        vm,
        owner,
        gap: Math.abs(vm.started.getTime() - owner.process.started.getTime()),
      })),
    )
    .filter((pair) => pair.gap <= PAIRING_WINDOW_MS)
    .toSorted((a, b) => a.gap - b.gap);
  const claimedVms = new Set<number>();
  const claimedOwners = new Set<number>();
  const owned: Owned[] = [];
  for (const { vm, owner } of pairs) {
    if (claimedVms.has(vm.pid) || claimedOwners.has(owner.process.pid))
      continue;
    claimedVms.add(vm.pid);
    claimedOwners.add(owner.process.pid);
    owned.push({
      ...vm,
      family: owner.family,
      role: 'vm',
      vmOwnerPid: owner.process.pid,
    });
  }
  return { owned, unattributed: vms.filter((vm) => !claimedVms.has(vm.pid)) };
}

function footprint(pids: number[]): unknown {
  const folder = mkdtempSync(join(tmpdir(), 'engine-memory-'));
  const file = join(folder, 'footprint.json');
  try {
    execFileSync(
      'footprint',
      ['--noCategories', '-f', 'bytes', '-j', file, ...pids.map(String)],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 180_000,
      },
    );
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const processes = listProcesses();
const { owned: vms, unattributed } = attributeVms(processes);
const helpers: Owned[] = processes.flatMap((process) => {
  const match = familyOf(process);
  return match ? [{ ...process, ...match }] : [];
});
const mine = [...helpers, ...vms].filter(
  (process) => process.family === family,
);
const sum = (list: Owned[]) =>
  list.reduce((total, process) => total + process.rssKiB, 0);

const footprintReport = values.footprint
  ? footprint(mine.map((process) => process.pid))
  : undefined;

const report = {
  engine,
  family,
  taken_utc: new Date().toISOString(),
  rss_kib_total: sum(mine),
  rss_kib_without_ui: sum(mine.filter((process) => process.role !== 'ui')),
  rss_kib_by_role: Object.fromEntries(
    (['vm', 'helper', 'shim', 'ui'] as Role[]).map((role) => [
      role,
      sum(mine.filter((process) => process.role === role)),
    ]),
  ),
  vm_count: mine.filter((process) => process.role === 'vm').length,
  processes: mine.map((process) => ({
    pid: process.pid,
    ppid: process.ppid,
    rss_kib: process.rssKiB,
    started: process.started.toISOString(),
    role: process.role,
    comm: process.comm,
    vm_owner_pid: process.vmOwnerPid,
  })),
  unattributed_vms: unattributed.map((process) => ({
    pid: process.pid,
    rss_kib: process.rssKiB,
    started: process.started.toISOString(),
  })),
  footprint_bytes_total:
    (footprintReport as { 'total footprint'?: number } | undefined)?.[
      'total footprint'
    ] ?? null,
  footprint: footprintReport,
};

writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${engine}: ${report.processes.length} processes, ${report.vm_count} VM(s), ` +
    `${(report.rss_kib_total / 1024).toFixed(0)} MiB RSS (${(report.rss_kib_without_ui / 1024).toFixed(0)} MiB without UI)`,
);
