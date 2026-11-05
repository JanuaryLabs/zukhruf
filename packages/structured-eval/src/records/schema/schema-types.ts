import type { InstanceType, Schema } from '@cfworker/json-schema';

import type { Step } from '../record-leaves.ts';
import { isRecord } from '../values.ts';

type Node = Schema | boolean;

// Answers if the JSON Schema allows the type of a value at a path. It follows
// properties, patternProperties, additionalProperties, prefixItems, items
// (also the tuple form of draft 7), local $ref, allOf, anyOf and oneOf. An
// unknown $ref allows any type.
export class SchemaTypes {
  readonly #root: Schema;

  constructor(root: Schema) {
    this.#root = root;
  }

  allows(steps: readonly Step[], value: unknown): boolean {
    let nodes: readonly Node[] = [this.#root];
    for (const step of steps)
      nodes = nodes.flatMap((node) => this.#children(node, step, new Set()));
    const type = SchemaTypes.#jsonType(value);
    return nodes.some((node) => this.#admits(node, type, new Set()));
  }

  #admits(node: Node, type: InstanceType, visited: Set<Schema>): boolean {
    if (typeof node === 'boolean') return node;
    if (visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    if (node.type !== undefined && !SchemaTypes.#typeMatches(node.type, type))
      return false;
    const reference = this.#reference(node);
    if (reference !== undefined && !this.#admits(reference, type, seen))
      return false;
    const admits = (member: Node) => this.#admits(member, type, seen);
    if (node.allOf !== undefined && !node.allOf.every(admits)) return false;
    if (node.anyOf !== undefined && !node.anyOf.some(admits)) return false;
    if (node.oneOf !== undefined && !node.oneOf.some(admits)) return false;
    return true;
  }

  #children(node: Node, step: Step, visited: Set<Schema>): Node[] {
    if (typeof node === 'boolean') return node ? [true] : [];
    if (visited.has(node)) return [];
    const seen = new Set(visited).add(node);
    const reference = this.#reference(node);
    const members = [
      ...(reference === undefined ? [] : [reference]),
      ...(node.allOf ?? []),
      ...(node.anyOf ?? []),
      ...(node.oneOf ?? []),
    ];
    return [
      ...(typeof step === 'string'
        ? this.#property(node, step)
        : this.#item(node, step)),
      ...members.flatMap((member) => this.#children(member, step, seen)),
    ];
  }

  #property(node: Schema, key: string): Node[] {
    const declares =
      SchemaTypes.#typeMatches(node.type, 'object') ||
      node.properties !== undefined ||
      node.patternProperties !== undefined ||
      node.additionalProperties !== undefined;
    if (!declares) return [];
    const property = node.properties?.[key];
    if (property !== undefined) return [property];
    const patterns = Object.entries(node.patternProperties ?? {})
      .filter(([pattern]) => new RegExp(pattern, 'u').test(key))
      .map(([, schema]) => schema);
    if (patterns.length > 0) return patterns;
    return [node.additionalProperties ?? true];
  }

  #item(node: Schema, index: number): Node[] {
    const declares =
      SchemaTypes.#typeMatches(node.type, 'array') ||
      node.items !== undefined ||
      node.prefixItems !== undefined;
    if (!declares) return [];
    if (Array.isArray(node.items))
      return [node.items[index] ?? node.additionalItems ?? true];
    const prefix = node.prefixItems?.[index];
    if (prefix !== undefined) return [prefix];
    return [node.items ?? true];
  }

  #reference(node: Schema): Node | undefined {
    const reference = node.$ref;
    if (reference === undefined || !reference.startsWith('#')) return undefined;
    let target: unknown = this.#root;
    for (const token of reference.slice(1).split('/').slice(1)) {
      if (!isRecord(target)) return true;
      target = target[SchemaTypes.#decode(token)];
    }
    return SchemaTypes.#isNode(target) ? target : true;
  }

  static #jsonType(value: unknown): InstanceType {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'bigint') return 'integer';
    if (typeof value === 'number')
      return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    return 'object';
  }

  static #typeMatches(declared: unknown, actual: InstanceType): boolean {
    const types = Array.isArray(declared) ? declared : [declared];
    return types.some(
      (type) => type === actual || (type === 'number' && actual === 'integer'),
    );
  }

  static #isNode(value: unknown): value is Node {
    return typeof value === 'boolean' || isRecord(value);
  }

  static #decode(token: string): string {
    return decodeURIComponent(token)
      .replaceAll('~1', '/')
      .replaceAll('~0', '~');
  }
}
