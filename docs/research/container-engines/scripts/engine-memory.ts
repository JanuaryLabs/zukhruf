// Sums the host memory of one container engine's processes, for experiment 6 (idle-memory).
//
// Usage: node engine-memory.ts --engine docker|apple --out <file.json> [--footprint]
//
// Both engines run their VMs in com.apple.Virtualization.VirtualMachine XPC processes, whose
// parent is launchd, so a VM process is attributed to the engine whose owner process started
// nearest to it: com.docker.virtualization for Docker Desktop, container-runtime-linux (one per
// running container) for Apple. lstart has whole-second resolution; ties between two Apple
// containers do not change the Apple total. A VM no owner claims within 60 s is listed as
// unattributed and counted in neither engine.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

type Engine = 'docker' | 'apple';
type Role = 'helper' | 'ui' | 'vm' | 'shim';

interface Process {
  pid: number;
  ppid: number;
  rssKiB: number;
  started: Date;
  comm: string;
}

interface Owned extends Process {
  engine: Engine;
  role: Role;
  vmOwnerPid?: number;
}

const VM_PROCESS = 'com.apple.Virtualization.VirtualMachine';
const VM_OWNER: Record<Engine, string> = {
  docker: 'com.docker.virtualization',
  apple: 'container-runtime-linux',
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
if (engine !== 'docker' && engine !== 'apple') {
  throw new Error('--engine must be docker or apple');
}
if (!values.out) {
  throw new Error('--out is required');
}

function listProcesses(): Process[] {
  const text = execFileSync(
    'ps',
    ['-axww', '-o', 'pid=,ppid=,rss=,lstart=,comm='],
    {
      encoding: 'utf8',
    },
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      // lstart is five words, e.g. "Sat Nov 15 22:24:01 2026"; comm is the rest and may hold spaces.
      const words = line.trim().split(/\s+/);
      const [pid, ppid, rss] = words;
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssKiB: Number(rss),
        started: new Date(words.slice(3, 8).join(' ')),
        comm: words.slice(8).join(' '),
      };
    });
}

function engineOf(
  process: Process,
): { engine: Engine; role: Role } | undefined {
  const name = basename(process.comm);
  if (
    process.comm.includes('/Applications/Docker.app/') ||
    name.startsWith('com.docker.')
  ) {
    return {
      engine: 'docker',
      role: process.comm.includes('/Docker Desktop.app/') ? 'ui' : 'helper',
    };
  }
  if (name === 'socktainer') {
    return { engine: 'apple', role: 'shim' };
  }
  if (
    /\/Cellar\/container\/|\/opt\/container\//.test(process.comm) ||
    name.startsWith('container-')
  ) {
    return { engine: 'apple', role: 'helper' };
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
    const name = basename(process.comm);
    const owner = (Object.keys(VM_OWNER) as Engine[]).find(
      (key) => VM_OWNER[key] === name,
    );
    return owner ? [{ process, engine: owner }] : [];
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
      engine: owner.engine,
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
  const match = engineOf(process);
  return match ? [{ ...process, ...match }] : [];
});
const mine = [...helpers, ...vms].filter(
  (process) => process.engine === engine,
);
const sum = (list: Owned[]) =>
  list.reduce((total, process) => total + process.rssKiB, 0);

const footprintReport = values.footprint
  ? footprint(mine.map((process) => process.pid))
  : undefined;

const report = {
  engine,
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
