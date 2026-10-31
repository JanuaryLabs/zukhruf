import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { bestMatch, createScorer, normalizeText, search } from 'rapidfuzz-js';
import { ratio, tokenSetRatio } from 'rapidfuzz-js/fuzz';

import { mean } from './numpy.ts';
import {
  asciiDigits,
  pythonFloat,
  pythonStrRepr,
  pythonStrip,
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
  if (details.provider === 'AWS') pythonGet(metadata, 'region', null);
  if (details.provider === 'Azure')
    pythonGet(pythonSubscript(metadata, 'compute'), 'location', null);
  if (details.provider !== 'GCP') return { provider: null };
  return {
    provider: 'gcp',
    region: extractGcpRegion(pythonGet(metadata, 'zone', null)),
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

// dict.get(key, missing) of a JSON value.
function pythonGet(value: unknown, key: string, missing: unknown): unknown {
  if (!isDict(value))
    throw new TypeError(
      `'${pythonTypeName(value)}' object has no attribute 'get'`,
    );
  return Object.hasOwn(value, key) ? value[key] : missing;
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

// core/cpu.py TDP._get_cpu_power_from_registry and _get_matching_cpu with
// greedy=False: process.extractOne with fuzz.ratio of the lower-case strings,
// then process.extract (limit 5) with fuzz.token_set_ratio of the strings
// that default_process cleans, both at a cutoff of 100. rapidfuzz-js gives
// the scorers, the cleaning and the search of rapidfuzz.
export function cpuPowerFromRegistry(modelRaw: string): number | null {
  const table = data.cpuPower();
  const names = table.map((row) => row.name);
  // The processor of extractOne, on the query and on each name.
  const direct = bestMatch(
    modelRaw.toLowerCase(),
    names.map((name) => name.toLowerCase()),
    { scorer: RATIO, threshold: 100 },
  );
  if (direct !== undefined) return cpuConstantPower(table, direct.key);
  let model = modelRaw.replaceAll('(R)', '');
  const startCpu = model.indexOf(' CPU @ ');
  if (startCpu > 0) model = model.slice(0, startCpu);
  const [first, second] = search(model, names, {
    scorer: TOKEN_SET_RATIO,
    normalize: normalizeText,
    threshold: 100,
    limit: 5,
  });
  return first !== undefined &&
    (second === undefined || first.score !== second.score)
    ? cpuConstantPower(table, first.key)
    : null;
}

const RATIO = createScorer(ratio);
const TOKEN_SET_RATIO = createScorer(tokenSetRatio);

// _get_cpu_constant_power: float of the TDP string of the first row with
// the matched name.
function cpuConstantPower(table: readonly CpuPowerRow[], key: number): number {
  const name = table[key]?.name;
  const row = table.find((candidate) => candidate.name === name);
  if (row === undefined) throw new RangeError(`no CPU row ${key}`);
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

  start(): void {}

  async measureEnergy(lastDuration: number): Promise<number> {
    return energyFromPowerAndTime(this.totalPower(), lastDuration);
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

// external/hardware.py: what _do_measurements of the tracker reads from each
// hardware. Only the energy reaches the emissions, so the power, the totals
// for each kind of hardware and the PUE (always 1.0) are not ported.
type Hardware = {
  start(): void;
  measureEnergy(lastDuration: number): Promise<number>;
};

// core/util.py detect_cpu_model: brand_raw of py-cpuinfo, which reads the
// same OS sources as Node. os.cpus() is empty when /proc is not available.
function detectCpuModel(): string {
  return cpus()[0]?.model ?? '';
}

// RAM in "machine" mode: 3 W for each 8 GB of the machine.
const B_TO_GB = 1024 * 1024 * 1024;
const POWER_PER_GB = 3 / 8;

class Ram {
  start(): void {}

  async measureEnergy(lastDuration: number): Promise<number> {
    const power = powerFromWatts((totalmem() / B_TO_GB) * POWER_PER_GB);
    return energyFromPowerAndTime(power, lastDuration);
  }
}

// core/cpu.py IntelRAPL: the energy counters of
// /sys/class/powercap/intel-rapl, on Linux only. Since CVE-2020-8694 most
// kernels let only root read them, and the constructor then throws.
class IntelRAPL {
  readonly #files: RAPLFile[] = [];

  constructor() {
    const raplDir = '/sys/class/powercap/intel-rapl';
    if (process.platform !== 'linux')
      throw new Error('Platform not supported by Intel RAPL Interface');
    if (!existsSync(raplDir))
      throw new Error(
        `Intel RAPL files not found at ${raplDir} on ${process.platform}`,
      );
    let packages = 0;
    for (const file of readdirSync(raplDir).filter((name) =>
      name.includes(':'),
    )) {
      let name = pythonStrip(readFileSync(join(raplDir, file, 'name'), 'utf8'));
      if (name.includes('package')) {
        name = `Processor Energy Delta_${packages}(kWh)`;
        packages += 1;
      }
      this.#files.push(
        new RAPLFile(
          name,
          join(raplDir, file, 'energy_uj'),
          join(raplDir, file, 'max_energy_range_uj'),
        ),
      );
    }
  }

  start(): void {
    for (const file of this.#files) file.start();
  }

  // The energy of the packages since the last reading. get_cpu_details
  // gives no energy when a file cannot be read.
  energy(): number {
    try {
      for (const file of this.#files) file.delta();
    } catch {
      return 0;
    }
    let energy = 0;
    for (const file of this.#files)
      if (/^Processor Energy Delta_\d/.test(file.name))
        energy += file.energyDelta;
    return energy;
  }
}

function isRaplAvailable(): boolean {
  try {
    new IntelRAPL();
    return true;
  } catch {
    return false;
  }
}

// CPU in "intel_rapl" mode.
class RaplCpu {
  readonly #rapl = new IntelRAPL();

  start(): void {
    this.#rapl.start();
  }

  async measureEnergy(): Promise<number> {
    return this.#rapl.energy();
  }
}

// core/powermetrics.py ApplePowermetrics. Each reading runs powermetrics
// for 10 samples of 100 ms and reads its log, powermetrics_log.txt in the
// current folder. sudo gets -n, so it never asks for a password. Python
// first looks for sudo and powermetrics in PATH; here the probe runs them,
// and a missing program fails it, which gives the same answer.
class ApplePowermetrics {
  readonly #logFilePath = join('.', 'powermetrics_log.txt');

  constructor() {
    if (process.platform !== 'darwin')
      throw new Error('Platform not supported by Powermetrics');
  }

  // get_details: the mean power, or null when the log cannot be read.
  async power(): Promise<{
    readonly cpu: number;
    readonly gpu: number;
  } | null> {
    await this.#logValues();
    let logfile: string;
    try {
      logfile = new TextDecoder('utf-8', { fatal: true }).decode(
        readFileSync(this.#logFilePath),
      );
    } catch {
      return null;
    }
    return powermetricsPower(logfile);
  }

  // _log_values, with its empty argument. A non-zero exit code is only
  // logged in Python.
  #logValues(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        'sudo',
        [
          '-n',
          'powermetrics',
          '-n',
          '10',
          '',
          '--samplers',
          'cpu_power',
          '--format',
          'csv',
          '-i',
          '100',
          '-o',
          this.#logFilePath,
        ],
        (error) => {
          if (error !== null && error.code === 'ENOENT') reject(error);
          else resolve();
        },
      );
    });
  }
}

// The CPU or the GPU part of an Apple chip, as powermetrics reads it.
class AppleSiliconChip {
  readonly #interface = new ApplePowermetrics();
  readonly #chipPart: 'cpu' | 'gpu';

  constructor(chipPart: 'cpu' | 'gpu') {
    this.#chipPart = chipPart;
  }

  start(): void {}

  async measureEnergy(lastDuration: number): Promise<number> {
    const power = await this.#interface.power();
    const watts = power === null ? 0 : 0 + power[this.#chipPart];
    return energyFromPowerAndTime(powerFromWatts(watts), lastDuration);
  }
}

async function isPowermetricsAvailable(): Promise<boolean> {
  try {
    new ApplePowermetrics();
    return await hasPowermetricsSudo();
  } catch {
    return false;
  }
}

// _has_powermetrics_sudo: false when sudo asks for a password, an error for
// another failure.
async function hasPowermetricsSudo(): Promise<boolean> {
  const { code, stderr } = await new Promise<{
    readonly code: number | null;
    readonly stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      'sudo',
      [
        '-n',
        'powermetrics',
        '--samplers',
        'cpu_power',
        '-n',
        '1',
        '-i',
        '1',
        '-o',
        '/dev/null',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let text = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      text += chunk;
    });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode, stderr: text }));
  });
  if (/[sudo][^\n]*password/.test(stderr)) return false;
  if (code !== 0) throw new Error('Return code != 0');
  return true;
}

// core/resource_tracker.py set_CPU_GPU_ram_tracking: the RAM, then the CPU
// from the first source that works. Intel Power Gadget and NVIDIA GPUs are
// not ported.
async function trackedHardware(): Promise<Hardware[]> {
  if (isRaplAvailable()) return [new Ram(), new RaplCpu()];
  if (await isPowermetricsAvailable())
    return [
      new Ram(),
      new AppleSiliconChip('cpu'),
      new AppleSiliconChip('gpu'),
    ];
  return [new Ram(), new ConstantCpu(tdpOf(detectCpuModel()))];
}

// core/cloud.py get_env_cloud_details: the metadata server of AWS, Azure
// and GCP, 1 s each. requests' timeout bounds each socket operation; this
// one bounds the whole request.
const CLOUD_METADATA = [
  {
    provider: 'AWS',
    url: 'http://169.254.169.254/latest/dynamic/instance-identity/document',
    headers: {},
  },
  {
    provider: 'Azure',
    url: 'http://169.254.169.254/metadata/instance?api-version=2019-08-15',
    headers: { Metadata: 'true' },
  },
  {
    provider: 'GCP',
    url: 'http://169.254.169.254/computeMetadata/v1/instance/?recursive=true&alt=json',
    headers: { 'Metadata-Flavor': 'Google' },
  },
] as const;

async function envCloudDetails(): Promise<CloudDetails | null> {
  for (const { provider, url, headers } of CLOUD_METADATA) {
    let metadata: unknown;
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      if (response.status >= 400 && response.status < 600) continue;
      metadata = JSON.parse(await response.text());
    } catch {
      // requests' RequestException: no connection, a timeout or a body
      // that is not JSON.
      continue;
    }
    return {
      provider,
      metadata: provider === 'GCP' ? withoutAttributes(metadata) : metadata,
    };
  }
  return null;
}

// postprocess_gcp_cloud_metadata drops the custom metadata, which can hold
// secrets. `"attributes" in metadata` raises for a number, a bool or null.
function withoutAttributes(metadata: unknown): unknown {
  if (isDict(metadata)) {
    const { attributes: _attributes, ...rest } = metadata;
    return rest;
  }
  if (typeof metadata === 'string' || Array.isArray(metadata)) return metadata;
  throw new TypeError(
    `argument of type '${pythonTypeName(metadata)}' is not iterable`,
  );
}

// external/geography.py GeoMetadata.from_geo_js: geojs, then ip-api with
// api.first.org for the three-letter code, 0.5 s each, then Quebec, Canada.
async function geoFromGeoJs(): Promise<GeoMetadata> {
  try {
    const response = await getJson('https://get.geojs.io/v1/ip/geo.json');
    return geoOf(response, {
      countryIsoCode: pythonUpper(pythonSubscript(response, 'country_code3')),
      country: 'country',
      region: 'region',
      latitude: 'latitude',
      longitude: 'longitude',
      countryCode: 'country_code',
    });
  } catch {
    // The backup API.
  }
  try {
    const response = await getJson('https://ip-api.com/json/');
    const countryName = pythonSubscript(response, 'country');
    if (typeof countryName !== 'string')
      throw new TypeError('quote_from_bytes() expected bytes');
    const codes = pythonSubscript(
      await getJson(
        `https://api.first.org/data/v1/countries?q=${quotePlus(countryName)}&scope=iso`,
      ),
      'data',
    );
    if (!isDict(codes))
      throw new TypeError(
        `'${pythonTypeName(codes)}' object has no attribute 'keys'`,
      );
    const [code] = Object.keys(codes);
    if (code === undefined) throw new RangeError('StopIteration');
    return geoOf(response, {
      countryIsoCode: code.toUpperCase(),
      country: 'country',
      region: 'regionName',
      latitude: 'lat',
      longitude: 'lon',
      countryCode: 'countryCode',
    });
  } catch {
    return geoMetadata('CAN', 'Quebec');
  }
}

// requests.get(url, timeout=0.5).json(): the body of any status.
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(500) });
  return JSON.parse(await response.text());
}

// The fields of a GeoMetadata that Python reads from an answer. Each read
// raises on a value of another type, and the tracker tries the next API.
function geoOf(
  response: unknown,
  keys: {
    readonly countryIsoCode: string;
    readonly country: string;
    readonly region: string;
    readonly latitude: string;
    readonly longitude: string;
    readonly countryCode: string;
  },
): GeoMetadata {
  pythonSubscript(response, keys.country);
  const region = pythonGet(response, keys.region, '');
  pythonFloatOf(pythonGet(response, keys.latitude, null));
  pythonFloatOf(pythonGet(response, keys.longitude, null));
  const countryCode = pythonGet(response, keys.countryCode, null);
  if (pythonTruthy(countryCode)) pythonUpper(countryCode);
  return geoMetadata(keys.countryIsoCode, pythonLower(region));
}

function pythonUpper(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError(
      `'${pythonTypeName(value)}' object has no attribute 'upper'`,
    );
  return value.toUpperCase();
}

function pythonLower(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError(
      `'${pythonTypeName(value)}' object has no attribute 'lower'`,
    );
  return value.toLowerCase();
}

// The truth value of a JSON value in Python.
function pythonTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

// float(value) of a JSON value, which raises for a string that is not a
// number, for None, a list or a dict.
function pythonFloatOf(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'boolean')
    return Number(value);
  if (typeof value === 'string') {
    const parsed = pythonFloat(value);
    if (parsed === undefined)
      throw new RangeError(
        `could not convert string to float: ${pythonStrRepr(value)}`,
      );
    return parsed;
  }
  throw new TypeError(
    `float() argument must be a string or a real number, not '${pythonTypeName(value)}'`,
  );
}

// urllib.parse.quote_plus: UTF-8 percent codes for all but letters, digits
// and _.-~, and + for a space.
function quotePlus(text: string): string {
  return encodeURIComponent(text)
    .replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replaceAll('%20', '+');
}

// lock.py: one tracker on the machine at a time, through a file in the
// temporary folder of the system. Node's os.tmpdir() is the folder of
// Python's tempfile.gettempdir(), so a Python run and a run of this package
// also keep each other out.
const LOCKFILE = join(tmpdir(), '.codecarbon.lock');

// atexit.register(self.release) of each Lock. Python keeps the release of
// each Lock until the interpreter exits, also after it released.
const releaseAtExit: Lock[] = [];

function releaseAll(): void {
  for (const lock of releaseAtExit.toReversed())
    try {
      lock.release();
    } catch {
      // atexit prints the error and runs the next function.
    }
}

// signal.signal(SIGINT and SIGTERM, ...) of the last Lock, made in the main
// thread: a signal releases that lock and exits with code 1.
function exitOnSignal(): void {
  const latest = releaseAtExit.at(-1);
  if (latest !== undefined) latest.release();
  process.exit(1);
}

// Lock() and Lock.acquire() in one step: the constructor makes the file, and
// throws an error with the code EEXIST when the file exists.
export class Lock {
  readonly lockfilePath = LOCKFILE;

  constructor() {
    closeSync(openSync(LOCKFILE, 'wx'));
    releaseAtExit.push(this);
    if (!process.listeners('exit').includes(releaseAll))
      process.on('exit', releaseAll);
    if (isMainThread && !process.listeners('SIGINT').includes(exitOnSignal)) {
      process.on('SIGINT', exitOnSignal);
      process.on('SIGTERM', exitOnSignal);
    }
  }

  release(): void {
    try {
      unlinkSync(LOCKFILE);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
}

// external/scheduler.py PeriodicScheduler: a call every interval, on a timer
// that does not keep the process alive, as Python's daemon threads.
class PeriodicScheduler {
  readonly #interval: number;
  readonly #function: () => Promise<void>;
  #timer: NodeJS.Timeout | null = null;

  constructor(interval: number, fn: () => Promise<void>) {
    this.#interval = interval;
    this.#function = fn;
  }

  start(): void {
    if (this.#timer === null) this.#arm();
  }

  #arm(): void {
    this.#timer = setTimeout(() => {
      this.#arm();
      // An error ends the call of a Python Timer thread, not the schedule.
      this.#function().catch(() => undefined);
    }, this.#interval * 1000).unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

// The lock, or null when another run holds it.
function lockUnlessHeld(): Lock | null {
  try {
    return new Lock();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return null;
    throw error;
  }
}

// time.perf_counter in seconds.
function perfCounter(): number {
  return performance.now() / 1000;
}

// Where the grid intensity comes from: the country and region of private
// infrastructure, or the GCP region.
type Place =
  | { readonly geo: GeoMetadata }
  | { readonly cloud: Extract<CloudMetadata, { provider: 'gcp' }> };

type Measurement = {
  readonly lock: Lock;
  readonly hardware: readonly Hardware[];
  readonly place: Place;
  readonly scheduler: PeriodicScheduler;
};

type Started = Measurement & {
  readonly startTime: number;
  lastMeasuredTime: number;
  totalEnergy: number;
};

type TrackerState =
  | { readonly kind: 'another-instance'; readonly cause: Error }
  | { readonly kind: 'initialized'; readonly measurement: Measurement }
  | { readonly kind: 'started'; readonly run: Started }
  | { readonly kind: 'stopped'; readonly finalEmissions: number }
  | { readonly kind: 'failed'; readonly cause: unknown };

// emissions_tracker.py EmissionsTracker with the arguments of MTEB:
// save_to_file=False, save_to_api=False, allow_multiple_runs=False. Their
// output handlers and allow_multiple_runs=True are not ported, nor the
// configuration files and CODECARBON_ variables.
export class EmissionsTracker {
  #state: TrackerState;

  private constructor(state: TrackerState) {
    this.#state = state;
  }

  // __init__: the lock, the hardware, the cloud and the place. A constructor
  // cannot wait for the network and for sudo, so this is async. When
  // another run holds the lock, the tracker does nothing and has no final
  // emissions.
  static async create(): Promise<EmissionsTracker> {
    const lock = lockUnlessHeld();
    if (lock === null)
      return new EmissionsTracker({
        kind: 'another-instance',
        cause: new Error(
          `Another instance of codecarbon is probably running as we find \`${LOCKFILE}\`. Turn off the other instance to be able to run this one or use \`allow_multiple_runs\` or delete the file. Exiting.`,
        ),
      });
    const hardware = await trackedHardware();
    const cloud = cloudMetadataFrom(await envCloudDetails());
    const place: Place =
      cloud.provider === null ? { geo: await geoFromGeoJs() } : { cloud };
    const tracker: EmissionsTracker = new EmissionsTracker({
      kind: 'initialized',
      measurement: {
        lock,
        hardware,
        place,
        scheduler: new PeriodicScheduler(15, () => tracker.#measure()),
      },
    });
    return tracker;
  }

  // start: the first readings and the schedule of a measurement every 15
  // seconds. Python suppresses its errors.
  start(): void {
    if (this.#state.kind !== 'initialized') return;
    const now = perfCounter();
    const run: Started = {
      ...this.#state.measurement,
      startTime: now,
      lastMeasuredTime: now,
      totalEnergy: 0,
    };
    this.#state = { kind: 'started', run };
    try {
      for (const hardware of run.hardware) hardware.start();
      run.scheduler.start();
    } catch {
      // @suppress(Exception)
    }
  }

  // stop: the lock goes, a last measurement runs, and the emissions of the
  // energy since start become the final emissions. Python suppresses its
  // errors, and the tracker then has no final emissions. A second stop does
  // nothing; MTEB stops each tracker once.
  async stop(): Promise<void> {
    const state = this.#state;
    if (state.kind === 'initialized') {
      try {
        state.measurement.lock.release();
        this.#state = {
          kind: 'failed',
          cause: new Error('You first need to start the tracker.'),
        };
      } catch (error) {
        this.#state = { kind: 'failed', cause: error };
      }
      return;
    }
    if (state.kind !== 'started') return;
    try {
      state.run.lock.release();
      state.run.scheduler.stop();
      await this.#measure();
      this.#state = {
        kind: 'stopped',
        finalEmissions: emissionsOf(state.run.totalEnergy, state.run.place),
      };
    } catch (error) {
      this.#state = { kind: 'failed', cause: error };
    }
  }

  // final_emissions in kg CO2eq. Python sets it only at the end of stop, so
  // reading it after a stop that did not finish raises AttributeError; the
  // cause says why.
  get finalEmissions(): number {
    if (this.#state.kind === 'stopped') return this.#state.finalEmissions;
    throw new TypeError(
      "'EmissionsTracker' object has no attribute 'final_emissions'",
      'cause' in this.#state ? { cause: this.#state.cause } : {},
    );
  }

  // _measure_power_and_energy: the energy of each hardware since the last
  // measurement.
  async #measure(): Promise<void> {
    if (this.#state.kind !== 'started') return;
    const { run } = this.#state;
    for (const hardware of run.hardware) {
      const lastDuration = perfCounter() - run.lastMeasuredTime;
      run.totalEnergy += await hardware.measureEnergy(lastDuration);
    }
    run.lastMeasuredTime = perfCounter();
  }
}

// _prepare_emissions_data: the emissions of the energy at the place.
function emissionsOf(kWh: number, place: Place): number {
  return 'geo' in place
    ? privateInfraEmissions(kWh, place.geo)
    : cloudEmissions(kWh, place.cloud);
}
