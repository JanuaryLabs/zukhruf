import { matchesGlob } from 'node:path';

import type { ProjectGraph } from '@nx/devkit';

import { isRecord } from '../unknown-values.ts';

type Task = readonly [project: string, target: string];

function hasTarget(graph: ProjectGraph, project: string, target: string) {
  return graph.nodes[project]?.data.targets?.[target] !== undefined;
}

/**
 * `target` of each project that `project` depends on. A dependency without
 * the target is passed through to its own dependencies, as Nx's task graph
 * does with a dummy task.
 */
function dependencyTasks(
  graph: ProjectGraph,
  project: string,
  target: string,
  visited = new Set<string>(),
): Task[] {
  if (visited.has(project)) return [];
  visited.add(project);
  return (graph.dependencies[project] ?? []).flatMap(
    ({ target: dependency }) => {
      if (!graph.nodes[dependency]) return [];
      return hasTarget(graph, dependency, target)
        ? [[dependency, target] as const]
        : dependencyTasks(graph, dependency, target, visited);
    },
  );
}

function matchingProjects(graph: ProjectGraph, pattern: string): string[] {
  return Object.values(graph.nodes)
    .filter((node) =>
      pattern.startsWith('tag:')
        ? node.data.tags?.includes(pattern.slice('tag:'.length))
        : node.name === pattern || matchesGlob(node.name, pattern),
    )
    .map((node) => node.name);
}

// One `dependsOn` entry as Nx expands it: `target`, `^target`,
// `project:target`, or `{ target, dependencies?, projects? }`.
function expand(graph: ProjectGraph, project: string, entry: unknown): Task[] {
  if (typeof entry === 'string') {
    if (entry.startsWith('^')) {
      return dependencyTasks(graph, project, entry.slice(1));
    }
    const colon = entry.indexOf(':');
    const named = entry.slice(0, colon);
    return colon > 0 && graph.nodes[named]
      ? [[named, entry.slice(colon + 1)]]
      : [[project, entry]];
  }
  if (!isRecord(entry) || typeof entry['target'] !== 'string') return [];
  const target = entry['target'];
  if (entry['dependencies'] === true) {
    return dependencyTasks(graph, project, target);
  }
  const projects = entry['projects'];
  if (projects === undefined) return [[project, target]];
  return [projects].flat().flatMap((pattern: unknown): Task[] => {
    if (pattern === 'self') return [[project, target]];
    if (pattern === 'dependencies') {
      return dependencyTasks(graph, project, target);
    }
    return typeof pattern === 'string'
      ? matchingProjects(graph, pattern).map((name) => [name, target] as const)
      : [];
  });
}

/**
 * The ids (`project:target`) of every task that Nx runs before `target` of
 * `project`, through the `dependsOn` of each task as the project graph holds
 * it: target defaults and inferred targets included.
 */
export function taskClosure(
  graph: ProjectGraph,
  project: string,
  target: string,
): ReadonlySet<string> {
  const closure = new Set<string>();
  const queue: Task[] = [[project, target]];
  for (let task = queue.pop(); task; task = queue.pop()) {
    const [name, targetName] = task;
    const id = `${name}:${targetName}`;
    if (closure.has(id)) continue;
    closure.add(id);
    const dependsOn = graph.nodes[name]?.data.targets?.[targetName]?.dependsOn;
    for (const entry of dependsOn ?? []) {
      queue.push(...expand(graph, name, entry));
    }
  }
  return closure;
}
