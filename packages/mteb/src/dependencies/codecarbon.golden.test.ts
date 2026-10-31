import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  type CloudDetails,
  ConstantCpu,
  RAPLFile,
  cloudEmissions,
  cloudMetadataFrom,
  cpuPowerFromRegistry,
  cpuPowerTable,
  energyFromPowerAndTime,
  energyFromUjoules,
  geoMetadata,
  impactTable,
  powerFromWatts,
  powermetricsPower,
  privateInfraEmissions,
  tdpOf,
} from './codecarbon.ts';

// fixtures/codecarbon/expected.json holds what codecarbon 2.8.4 gave for
// fixed inputs: the sha256 of its data files, the tables that pandas reads,
// units, emissions, clouds, TDPs, RAPL readings and powermetrics logs.
// generate.py makes it.
type Value = number | string | null;
type Outcome =
  | { readonly value: Value }
  | { readonly error: string; readonly message: string };

const expected: {
  readonly sha256: Readonly<Record<string, string>>;
  readonly cpu_table: readonly (readonly [string, string])[];
  readonly impact_table: readonly (readonly [string, string, number])[];
  readonly units: {
    readonly energy_from_watts_and_seconds: readonly (readonly [
      number,
      number,
      number,
    ])[];
    readonly from_ujoules: readonly (readonly [number, number])[];
  };
  readonly kwh: number;
  readonly private_infra: readonly (readonly [string, string, number])[];
  readonly cloud: readonly (readonly [string, Outcome])[];
  readonly clouds: readonly (readonly [
    CloudDetails | null,
    (
      | {
          readonly value: {
            readonly provider: string | null;
            readonly region: string | null;
          };
        }
      | { readonly error: string; readonly message: string }
    ),
  ])[];
  readonly registry: readonly Outcome[];
  readonly models: readonly (readonly [string, Outcome | null, Outcome])[];
  readonly rapl: readonly (readonly [
    string,
    readonly string[],
    readonly number[],
  ])[];
  readonly powermetrics: readonly (readonly [string, Value, Value])[];
} = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/codecarbon/expected.json'),
    'utf8',
  ),
);

// The JavaScript error of each Python exception.
const ERRORS: Readonly<Record<string, ErrorConstructor>> = {
  ValueError: RangeError,
  KeyError: RangeError,
  AttributeError: TypeError,
  TypeError,
};

function number(value: Value): number {
  return typeof value === 'string' ? Number(value) : (value ?? NaN);
}

function outcome(call: () => number | null): Outcome {
  try {
    return { value: call() };
  } catch (error) {
    assert.ok(error instanceof Error);
    const type = Object.entries(ERRORS).find(
      ([, constructor]) => error.constructor === constructor,
    );
    return { error: type?.[0] ?? error.name, message: error.message };
  }
}

function assertOutcome(actual: Outcome, wanted: Outcome) {
  if ('error' in wanted) {
    assert.ok('error' in actual, `no error: ${JSON.stringify(actual)}`);
    assert.equal(actual.message, wanted.message);
    assert.equal(
      ERRORS[actual.error] ?? actual.error,
      ERRORS[wanted.error] ?? wanted.error,
    );
  } else {
    assert.ok('value' in actual, `an error: ${JSON.stringify(actual)}`);
    assert.equal(
      actual.value,
      wanted.value === null ? null : number(wanted.value),
    );
  }
}

test('each data file has the sha256 of SHA256SUMS, which are those of codecarbon 2.8.4, and each file is listed', () => {
  const folder = join(import.meta.dirname, 'codecarbon/data');
  const listed = readFileSync(join(folder, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [sha256, file] = line.split('  ');
      return [file, sha256];
    });

  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
    .map((entry) =>
      relative(folder, join(entry.parentPath, entry.name)).replaceAll(sep, '/'),
    )
    .sort()
    .map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(folder, file)))
        .digest('hex'),
    ]);

  assert.deepEqual(files, listed);
  assert.deepEqual(Object.fromEntries(listed), expected.sha256);
});

test('the CSV tables are the tables that pandas reads', () => {
  assert.deepEqual(
    cpuPowerTable().map((row) => [row.name, row.tdp]),
    expected.cpu_table,
  );
  assert.deepEqual(
    impactTable().map((row) => [row.provider, row.region, row.impact]),
    expected.impact_table,
  );
});

test('the units are those of codecarbon', () => {
  for (const [watts, seconds, kWh] of expected.units
    .energy_from_watts_and_seconds)
    assert.equal(
      energyFromPowerAndTime(powerFromWatts(watts), seconds),
      kWh,
      `${watts} W for ${seconds} s`,
    );
  for (const [microJoules, kWh] of expected.units.from_ujoules)
    assert.equal(energyFromUjoules(microJoules), kWh, `${microJoules} uJ`);
});

test('the emissions of each country and each region of the USA and Canada are those of codecarbon', () => {
  assert.ok(expected.private_infra.length > 213);
  for (const [iso, region, emissions] of expected.private_infra)
    assert.equal(
      privateInfraEmissions(expected.kwh, geoMetadata(iso, region)),
      emissions,
      `${iso} ${region}`,
    );
});

test('the emissions of each GCP region are those of codecarbon, and a region the table lacks throws', () => {
  for (const [region, wanted] of expected.cloud)
    assertOutcome(
      outcome(() => cloudEmissions(expected.kwh, { provider: 'gcp', region })),
      wanted,
    );
});

test('the cloud of each answer of the metadata servers is the cloud of codecarbon', () => {
  for (const [details, wanted] of expected.clouds) {
    if ('error' in wanted) {
      assert.throws(() => cloudMetadataFrom(details), {
        name: ERRORS[wanted.error]?.name,
        message: wanted.message,
      });
      continue;
    }
    const cloud = cloudMetadataFrom(details);
    assert.deepEqual(
      {
        provider: cloud.provider,
        region: cloud.provider === null ? null : cloud.region,
      },
      wanted.value,
      JSON.stringify(details),
    );
  }
});

test('the TDP of each name of the CPU table is the TDP of codecarbon, and a malformed TDP throws', () => {
  const names = cpuPowerTable().map((row) => row.name);
  assert.equal(names.length, expected.registry.length);
  names.forEach((name, index) => {
    const wanted = expected.registry[index];
    assert.ok(wanted !== undefined);
    assertOutcome(
      outcome(() => cpuPowerFromRegistry(name)),
      wanted,
    );
  });
});

test('the TDP and the CPU power of model strings are those of codecarbon', () => {
  for (const [model, registry, watts] of expected.models) {
    if (registry !== null)
      assertOutcome(
        outcome(() => cpuPowerFromRegistry(model)),
        registry,
      );
    assertOutcome(
      outcome(() => new ConstantCpu(tdpOf(model)).totalPower() * 1000),
      watts,
    );
  }
});

test('a RAPL file gives the energy of codecarbon for each reading, also when its counter wraps', async () => {
  await using folder = await new TemporaryFiles().directory('codecarbon-rapl-');
  const energy = join(folder.path, 'energy_uj');
  const maxEnergy = join(folder.path, 'max_energy_range_uj');
  for (const [maxText, [startText, ...readings], kWh] of expected.rapl) {
    writeFileSync(maxEnergy, maxText);
    writeFileSync(energy, startText ?? '');
    const file = new RAPLFile('package-0', energy, maxEnergy);
    file.start();

    const deltas = readings.map((reading) => {
      writeFileSync(energy, reading);
      file.delta();
      return file.energyDelta;
    });

    assert.deepEqual(deltas, kWh, `${startText} then ${readings.join(', ')}`);
  }
});

test('a powermetrics log gives the mean CPU and GPU power of codecarbon', () => {
  for (const [log, cpu, gpu] of expected.powermetrics)
    assert.deepEqual(
      powermetricsPower(log),
      { cpu: number(cpu), gpu: number(gpu) },
      log,
    );
});
