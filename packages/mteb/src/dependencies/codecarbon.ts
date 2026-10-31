import { readFileSync } from 'node:fs';

import { mean } from './numpy.ts';
import {
  asciiDigits,
  pythonFloat,
  pythonStrRepr,
  pythonSum,
} from './python.ts';

// codecarbon 2.8.4: what EmissionsTracker reaches with the arguments of MTEB
// (mteb/evaluate.py:224-230). Each section names its codecarbon module.
// Energies are numbers in kWh and powers numbers in kW, as the kWh and kW
// fields of Energy and Power in core/units.py.

// core/units.py. Python writes UJOULES_TO_JOULES as 10 ** (-6), which is the
// float 1e-6.
const SECONDS_TO_HOURS = 1 / 3600;
const LBS_MWH_TO_KG_KWH = 0.00045359237;
const G_KWH_TO_KG_KWH = 0.001;
const UJOULES_TO_JOULES = 1e-6;
const JOULES_TO_KWH = 2.77778e-7;
const WATTS_TO_KILO_WATTS = 0.001;

export function powerFromWatts(watts: number): number {
  return watts * WATTS_TO_KILO_WATTS;
}

// Energy.from_power_and_time.
export function energyFromPowerAndTime(kW: number, seconds: number): number {
  return kW * (seconds * SECONDS_TO_HOURS);
}

export function energyFromUjoules(microJoules: number): number {
  return microJoules * UJOULES_TO_JOULES * JOULES_TO_KWH;
}

// input.py: the data files of codecarbon, copied without change.
function dataFile(path: string): string {
  return readFileSync(new URL(`./codecarbon/data/${path}`, import.meta.url), {
    encoding: 'utf8',
  });
}

// The keys that the emissions read hold numbers. country_name, iso_code, unit
// and the *_source keys hold strings, and no code reads them.
type CountryMix = {
  readonly carbon_intensity: number;
  readonly total_TWh: number;
  readonly [key: string]: number;
};

type CarbonIntensityPerSource = {
  readonly world_average: number;
  readonly [source: string]: number;
};

type RegionMix = {
  readonly coal: number;
  readonly petroleum: number;
  readonly naturalGas: number;
  readonly total: number;
};

const data = {
  globalEnergyMix: lazy((): Readonly<Record<string, CountryMix>> =>
    JSON.parse(dataFile('private_infra/global_energy_mix.json')),
  ),
  carbonIntensityPerSource: lazy((): CarbonIntensityPerSource =>
    JSON.parse(dataFile('private_infra/carbon_intensity_per_source.json')),
  ),
  usaEmissions: lazy(
    (): Readonly<Record<string, { readonly emissions: number | string }>> =>
      JSON.parse(dataFile('private_infra/2016/usa_emissions.json')),
  ),
  canadaEnergyMix: lazy((): Readonly<Record<string, RegionMix>> =>
    JSON.parse(dataFile('private_infra/2016/canada_energy_mix.json')),
  ),
  impact: lazy(readImpactTable),
  cpuPower: lazy(readCpuPowerTable),
};

function lazy<T>(read: () => T): () => T {
  let value: { readonly read: T } | null = null;
  return () => (value ??= { read: read() }).read;
}

// pd.read_csv of the two CSV files: the rows below the header. Their fields
// hold no quotes and no comma.
function csvRows(text: string): string[][] {
  const lines = text.split('\n');
  return lines
    .slice(1, lines.at(-1) === '' ? -1 : undefined)
    .map((line) => line.split(','));
}

type ImpactRow = {
  readonly provider: string;
  readonly region: string;
  readonly impact: number;
};

// cloud/impact.csv: the provider, region and impact (gCO2eq/kWh) columns.
function readImpactTable(): readonly ImpactRow[] {
  return csvRows(dataFile('cloud/impact.csv')).map(
    ([provider, , , region, , , , , , impact]) => {
      if (
        provider === undefined ||
        region === undefined ||
        impact === undefined
      )
        throw new RangeError('cloud/impact.csv has a short row');
      return { provider, region, impact: Number(impact) };
    },
  );
}

export function impactTable(): readonly ImpactRow[] {
  return data.impact();
}

type CpuPowerRow = { readonly name: string; readonly tdp: string };

// hardware/cpu_power.csv. pandas reads TDP as strings, because four rows
// hold values such as 27.29.5; TDP._get_cpu_constant_power calls float on
// the string of the row that matches.
function readCpuPowerTable(): readonly CpuPowerRow[] {
  return csvRows(dataFile('hardware/cpu_power.csv')).map(([name, tdp]) => {
    if (name === undefined || tdp === undefined)
      throw new RangeError('hardware/cpu_power.csv has a short row');
    return { name, tdp };
  });
}

export function cpuPowerTable(): readonly CpuPowerRow[] {
  return data.cpuPower();
}

// external/geography.py GeoMetadata, as EmissionsTracker makes it from geojs
// or its backup: the region is a string there, never None.
export type GeoMetadata = {
  readonly countryIsoCode: string;
  readonly region: string;
};

export function geoMetadata(
  countryIsoCode: string,
  region: string,
): GeoMetadata {
  return {
    countryIsoCode: countryIsoCode.toUpperCase(),
    region: region.toLowerCase(),
  };
}

// core/emissions.py Emissions.get_private_infra_emissions, without a CO2
// Signal token.
export function privateInfraEmissions(kWh: number, geo: GeoMetadata): number {
  if (geo.countryIsoCode === 'USA' || geo.countryIsoCode === 'CAN') {
    const regional = regionEmissionsPerKWh(geo);
    if (regional !== null) return regional * kWh;
  }
  return countryEmissionsPerKWh(geo.countryIsoCode) * kWh;
}

function worldAverage(): number {
  return data.carbonIntensityPerSource().world_average * G_KWH_TO_KG_KWH;
}

// get_region_emissions, or null where Python raises and falls back on the
// country: a region the data does not have, or the _unit entry of
// usa_emissions.json, whose emissions are the string lbs/MWh.
function regionEmissionsPerKWh(geo: GeoMetadata): number | null {
  if (geo.countryIsoCode === 'USA') {
    const usa = data.usaEmissions();
    const region = Object.hasOwn(usa, geo.region) ? usa[geo.region] : undefined;
    return region === undefined || typeof region.emissions === 'string'
      ? null
      : region.emissions * LBS_MWH_TO_KG_KWH;
  }
  const canada = data.canadaEnergyMix();
  const mix = Object.hasOwn(canada, geo.region)
    ? canada[geo.region]
    : undefined;
  return mix === undefined ? null : regionMixPerKWh(mix);
}

// _region_energy_mix_to_emissions_rate, with Python's sum.
function regionMixPerKWh(mix: RegionMix): number {
  return pythonSum([
    (mix.coal / mix.total) * 0.995725971,
    (mix.petroleum / mix.total) * 0.8166885263,
    (mix.naturalGas / mix.total) * 0.7438415916,
  ]);
}

// get_country_emissions and _global_energy_mix_to_emissions_rate.
function countryEmissionsPerKWh(countryIsoCode: string): number {
  const mixes = data.globalEnergyMix();
  const mix = Object.hasOwn(mixes, countryIsoCode)
    ? mixes[countryIsoCode]
    : undefined;
  if (mix === undefined) return worldAverage();
  if (mix.carbon_intensity) return mix.carbon_intensity * G_KWH_TO_KG_KWH;
  const perSource = data.carbonIntensityPerSource();
  const energySum = mix.total_TWh;
  let carbonIntensity = 0;
  for (const [energyType, energyPerYear] of Object.entries(mix)) {
    if (!energyType.includes('_TWh')) continue;
    const intensity = perSource[energyType.slice(0, -'_TWh'.length)];
    if (intensity) carbonIntensity += (energyPerYear / energySum) * intensity;
  }
  return carbonIntensity * G_KWH_TO_KG_KWH;
}

// external/geography.py CloudMetadata. AWS and Azure publish no carbon
// intensity, so from_utils makes them private infrastructure: GCP is the
// only cloud.
export type CloudMetadata =
  | { readonly provider: null }
  | { readonly provider: 'gcp'; readonly region: string };

// What core/cloud.py get_env_cloud_details answers.
export type CloudDetails = {
  readonly provider: 'AWS' | 'Azure' | 'GCP';
  readonly metadata: unknown;
};

// CloudMetadata.from_utils on an answer of get_env_cloud_details. A metadata
// of an unexpected shape throws the error of Python, out of the tracker.
export function cloudMetadataFrom(details: CloudDetails | null): CloudMetadata {
  if (details === null || isEmptyDict(details.metadata))
    return { provider: null };
  const { metadata } = details;
  if (details.provider === 'AWS') pythonGet(metadata, 'region');
  if (details.provider === 'Azure')
    pythonGet(pythonSubscript(metadata, 'compute'), 'location');
  if (details.provider !== 'GCP') return { provider: null };
  return {
    provider: 'gcp',
    region: extractGcpRegion(pythonGet(metadata, 'zone')),
  };
}

// projects/705208488469/zones/us-central1-a gives us-central1. The pattern
// takes one digit, so europe-west10-a gives europe-west1.
function extractGcpRegion(zone: unknown): string {
  if (typeof zone !== 'string')
    throw new TypeError(
      `expected string or bytes-like object, got '${pythonTypeName(zone)}'`,
    );
  const match = /[a-z]+-[a-z]+[0-9]/.exec(zone);
  if (match === null)
    throw new TypeError("'NoneType' object has no attribute 'group'");
  return match[0];
}

function isDict(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyDict(value: unknown): boolean {
  return isDict(value) && Object.keys(value).length === 0;
}

// The name of the Python type of a JSON value. JSON numbers come as one
// type here; Python's json reads 1 as int and 1.0 as float.
function pythonTypeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'int' : 'float';
  return 'dict';
}

// dict.get of a JSON value.
function pythonGet(value: unknown, key: string): unknown {
  if (!isDict(value))
    throw new TypeError(
      `'${pythonTypeName(value)}' object has no attribute 'get'`,
    );
  return Object.hasOwn(value, key) ? value[key] : null;
}

// value[key] of a JSON value.
function pythonSubscript(value: unknown, key: string): unknown {
  if (isDict(value)) {
    if (!Object.hasOwn(value, key)) throw new RangeError(pythonStrRepr(key));
    return value[key];
  }
  if (Array.isArray(value))
    throw new TypeError('list indices must be integers or slices, not str');
  if (typeof value === 'string')
    throw new TypeError("string indices must be integers, not 'str'");
  throw new TypeError(`'${pythonTypeName(value)}' object is not subscriptable`);
}

// The emissions that BaseEmissionsTracker._prepare_emissions_data gives on
// GCP: get_cloud_emissions with no GeoMetadata, then
// get_cloud_country_name, which raises for a region the table lacks.
export function cloudEmissions(
  kWh: number,
  cloud: Extract<CloudMetadata, { provider: 'gcp' }>,
): number {
  const row = data
    .impact()
    .find(
      (row) => row.provider === cloud.provider && row.region === cloud.region,
    );
  if (row === undefined)
    throw new RangeError(
      `Unable to find country name for cloud_provider=${cloud.provider}, cloud_region=${cloud.region}`,
    );
  return row.impact * G_KWH_TO_KG_KWH * kWh;
}

// core/cpu.py TDP._get_cpu_power_from_registry. rapidfuzz's scorers at a
// cutoff of 100 are equality: fuzz.ratio of the lower-case strings, then
// fuzz.token_set_ratio, which gives 100 when the token set of one string
// holds the other. A token match counts only when it is the only one.
export function cpuPowerFromRegistry(modelRaw: string): number | null {
  const table = data.cpuPower();
  const lower = modelRaw.toLowerCase();
  const direct = table.find((row) => row.name.toLowerCase() === lower);
  if (direct !== undefined) return cpuConstantPower(direct);
  let model = modelRaw.replaceAll('(R)', '');
  const startCpu = model.indexOf(' CPU @ ');
  if (startCpu > 0) model = model.slice(0, startCpu);
  const tokens = tokenSet(model);
  if (tokens.size === 0) return null;
  const matches = cpuTokens().filter(
    (row) =>
      row.tokens.size > 0 &&
      (isSubset(tokens, row.tokens) || isSubset(row.tokens, tokens)),
  );
  const [match, ...others] = matches;
  return match !== undefined && others.length === 0
    ? cpuConstantPower(match.row)
    : null;
}

const cpuTokens = lazy(() =>
  data.cpuPower().map((row) => ({ row, tokens: tokenSet(row.name) })),
);

function tokenSet(text: string): Set<string> {
  return new Set(defaultProcess(text).split(' ').filter(Boolean));
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
  return [...small].every((token) => large.has(token));
}

// rapidfuzz.utils.default_process: each character that is not a letter or a
// digit becomes a space, each character takes its simple lower case, and the
// spaces at both ends go.
const CAPITAL_I_WITH_DOT = String.fromCodePoint(0x130);

function defaultProcess(text: string): string {
  let processed = '';
  for (const char of text) {
    if (!/[\p{L}\p{N}]/u.test(char)) processed += ' ';
    else if (char === CAPITAL_I_WITH_DOT) processed += 'i';
    else processed += char.toLowerCase();
  }
  return processed.replace(/^ +| +$/g, '');
}

// _get_cpu_constant_power: float of the TDP string.
function cpuConstantPower(row: CpuPowerRow): number {
  const power = pythonFloat(row.tdp);
  if (power === undefined)
    throw new RangeError(
      `could not convert string to float: ${pythonStrRepr(row.tdp)}`,
    );
  return power;
}

// TDP._main: the TDP in watts of the model that cpuinfo detects, or null
// when the table does not know the model.
export function tdpOf(cpuModelDetected: string): number | null {
  return cpuModelDetected === ''
    ? null
    : cpuPowerFromRegistry(cpuModelDetected);
}

// external/hardware.py: 85 W when the table does not know the CPU, and the
// share of the TDP that a CPU uses on average.
const POWER_CONSTANT = 85;
const CONSUMPTION_PERCENTAGE_CONSTANT = 0.5;

// CPU in "constant" mode, as ResourceTracker.set_CPU_tracking makes it from
// a TDP.
export class ConstantCpu {
  readonly #tdp: number;

  constructor(tdp: number | null) {
    this.#tdp = tdp ?? POWER_CONSTANT;
  }

  totalPower(): number {
    return powerFromWatts(this.#tdp * CONSUMPTION_PERCENTAGE_CONSTANT);
  }
}

// core/rapl.py RAPLFile: a counter of microjoules and the range at which it
// wraps. The power of a reading is not ported: only the energy reaches the
// emissions.
export class RAPLFile {
  readonly name: string;
  readonly #path: string;
  readonly #maxEnergyReading: number;
  #lastEnergy: number;
  energyDelta = 0;

  constructor(name: string, path: string, maxPath: string) {
    this.name = name;
    this.#path = path;
    this.#lastEnergy = this.#getValue();
    this.#maxEnergyReading = energyFromUjoules(readFloat(maxPath));
  }

  #getValue(): number {
    return energyFromUjoules(readFloat(this.#path));
  }

  start(): void {
    this.#lastEnergy = this.#getValue();
  }

  // The energy since the last reading. A reading below the last one means
  // that the counter wrapped.
  delta(): void {
    const newLastEnergy = this.#getValue();
    const energy =
      this.#lastEnergy > newLastEnergy
        ? newLastEnergy + this.#maxEnergyReading
        : newLastEnergy;
    this.energyDelta = energy - this.#lastEnergy;
    this.#lastEnergy = newLastEnergy;
  }
}

// float(open(path).read()).
function readFloat(path: string): number {
  const text = readFileSync(path, 'utf8');
  const value = pythonFloat(text);
  if (value === undefined)
    throw new RangeError(
      `could not convert string to float: ${pythonStrRepr(text)}`,
    );
  return value;
}

// core/powermetrics.py ApplePowermetrics.get_details, after the log is
// written: the mean CPU and GPU power in watts. np.mean of no values is NaN.
// The energy deltas are not ported: AppleSiliconChip reads only the power.
export function powermetricsPower(logfile: string): {
  readonly cpu: number;
  readonly gpu: number;
} {
  const watts = (part: string) => {
    const prefix = `${part} Power: `;
    const lines = logfile.match(new RegExp(`${prefix}\\p{Nd}+ mW`, 'gu')) ?? [];
    return mean(
      lines.map(
        (line) =>
          Number(asciiDigits(line.slice(prefix.length, -' mW'.length))) / 1000,
      ),
    );
  };
  return { cpu: watts('CPU'), gpu: watts('GPU') };
}
