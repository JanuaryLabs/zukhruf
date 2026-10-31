# /// script
# requires-python = "==3.12.9"
# dependencies = ["codecarbon==2.8.4", "pandas==3.1.0", "numpy==2.5.4", "rapidfuzz==3.14.6", "requests==2.34.2"]
# ///
# Makes expected.json of codecarbon.golden.test.ts with codecarbon 2.8.4, the
# version that MTEB 2.26.28's pin codecarbon<3 installs:
# uv run packages/mteb/src/dependencies/fixtures/codecarbon/generate.py
#
# It writes the sha256 of codecarbon's six data files, the tables that pandas
# reads from the two CSV files, the units, the emissions of each country, each
# region of the USA and Canada and each GCP region, the CPU region of a GCP
# zone and the cloud of each metadata answer, the TDP of each name of the CPU
# table and of CPU model strings, the readings of RAPL files and the power that
# powermetrics logs give. No call goes to the network, to sudo or to the lock.
# Never edit expected.json by hand: run this script again.
import hashlib
import importlib.metadata
import json
import math
import platform
import sys
import tempfile
from pathlib import Path
from unittest import mock

VERSIONS = {
    "codecarbon": "2.8.4",
    "pandas": "3.1.0",
    "numpy": "2.5.4",
    "rapidfuzz": "3.14.6",
    "requests": "2.34.2",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import codecarbon  # noqa: E402
from codecarbon.core import cpu  # noqa: E402
from codecarbon.core.emissions import Emissions  # noqa: E402
from codecarbon.core.powermetrics import ApplePowermetrics  # noqa: E402
from codecarbon.core.rapl import RAPLFile  # noqa: E402
from codecarbon.core.units import Energy, Power, Time  # noqa: E402
from codecarbon.external import geography  # noqa: E402
from codecarbon.external.geography import CloudMetadata, GeoMetadata  # noqa: E402
from codecarbon.external.hardware import CPU, RAM  # noqa: E402
from codecarbon.input import DataSource  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = Path(codecarbon.__file__).parent / "data"
FILES = [
    "private_infra/global_energy_mix.json",
    "private_infra/carbon_intensity_per_source.json",
    "private_infra/2016/usa_emissions.json",
    "private_infra/2016/canada_energy_mix.json",
    "cloud/impact.csv",
    "hardware/cpu_power.csv",
]


# JSON has no NaN or infinity: they go as strings.
def number(value):
    value = float(value)
    return value if math.isfinite(value) else repr(value)


def outcome(call):
    try:
        value = call()
    except Exception as error:  # noqa: BLE001
        return {"error": type(error).__name__, "message": str(error)}
    return {"value": None if value is None else number(value)}


source = DataSource()
emissions = Emissions(source, None)

# The tables that pandas reads. TDP is a column of strings, because four rows
# hold values such as 27.29.5.
cpu_table = source.get_cpu_power_data()
assert str(cpu_table["TDP"].dtype) == "str", cpu_table["TDP"].dtype
assert not cpu_table.isna().any().any()
impact = source.get_cloud_emissions_data()
assert str(impact["impact"].dtype) == "int64", impact["impact"].dtype

# Units.
UNIT_CASES = [(0, 0), (42.5, 1.0), (18, 3600), (60.5, 12.345678), (85 * 0.5, 0.1), (1e-3, 1e6)]
units = {
    "energy_from_watts_and_seconds": [
        [w, s, Energy.from_power_and_time(power=Power.from_watts(w), time=Time.from_seconds(s)).kWh]
        for w, s in UNIT_CASES
    ],
    "from_ujoules": [[uj, Energy.from_ujoules(uj).kWh] for uj in [0, 1, 123456789, 262143328850, 1e15]],
}

# Emissions of private infrastructure. The region of GeoMetadata from geojs
# is never None, so each case has one.
KWH = 0.123456789
geo_cases = [[iso, ""] for iso in json.loads((DATA / FILES[0]).read_text())]
geo_cases += [["USA", region] for region in json.loads((DATA / FILES[2]).read_text())]
geo_cases += [["CAN", region] for region in json.loads((DATA / FILES[3]).read_text())]
geo_cases += [
    ["usa", "New York"],
    ["Can", "Quebec"],
    ["USA", "atlantis"],
    ["CAN", "atlantis"],
    ["XXX", "somewhere"],
    ["fra", "Île-de-France"],
]
private_infra = [
    [iso, region, emissions.get_private_infra_emissions(Energy(KWH), GeoMetadata(country_iso_code=iso, region=region))]
    for iso, region in geo_cases
]


# Emissions on GCP, as _prepare_emissions_data of EmissionsTracker takes
# them: geo is None on a cloud, and the country name must exist.
def cloud_emissions(region):
    cloud = CloudMetadata(provider="gcp", region=region)
    value = emissions.get_cloud_emissions(Energy(KWH), cloud, None)
    emissions.get_cloud_country_name(cloud)
    return value


cloud = [[region, outcome(lambda region=region: cloud_emissions(region))] for region in list(impact["region"]) + ["me-central1", "mars-north1"]]

# The cloud of each answer of the metadata servers.
METADATA = [
    None,
    {"provider": "AWS", "metadata": {}},
    {"provider": "AWS", "metadata": {"region": "eu-west-3"}},
    {"provider": "Azure", "metadata": {"compute": {"location": "westeurope"}}},
    {"provider": "GCP", "metadata": {"zone": "projects/705208488469/zones/us-central1-a"}},
    {"provider": "GCP", "metadata": {"zone": "projects/1/zones/europe-west10-b"}},
    {"provider": "GCP", "metadata": {"zone": "projects/1/zones/northamerica-northeast2-c"}},
    {"provider": "GCP", "metadata": {"zone": "nothing here"}},
    {"provider": "GCP", "metadata": {}},
    {"provider": "AWS", "metadata": ["region"]},
    {"provider": "Azure", "metadata": {"compute": []}},
    {"provider": "Azure", "metadata": {}},
]


def cloud_of(details):
    with mock.patch.object(geography, "get_env_cloud_details", return_value=details):
        found = CloudMetadata.from_utils()
    return {"provider": found.provider, "region": found.region}


def cloud_outcome(details):
    try:
        return {"value": cloud_of(details)}
    except Exception as error:  # noqa: BLE001
        return {"error": type(error).__name__, "message": str(error)}


clouds = [[details, cloud_outcome(details)] for details in METADATA]

# The TDP of each name of the table, and of CPU model strings.
tdp = object.__new__(cpu.TDP)
registry = [outcome(lambda name=name: tdp._get_cpu_power_from_registry(name)) for name in cpu_table["Name"]]
MODELS = [
    "Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz",
    "Intel(R) Core(TM) i7-6700HQ CPU @ 2.60GHz",
    "Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz",
    "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz",
    "Intel(R) Celeron(R) 1000A",
    "Intel(R) Core(TM) i9-14900K",
    "Intel(R) Core(TM) Ultra 7 155H",
    "Intel Core i7-8700K CPU @ 3.70GHz",
    "INTEL CORE I7-8700K",
    "intel_core_i7-8700k",
    "İntel Core i7-8700K",
    "Intel Core i3-11100HE",
    "Intel Xeon Silver 4208",
    "Intel Atom E625CT",
    "AMD Ryzen 9 5950X 16-Core Processor",
    "AMD Ryzen 7 PRO 4750U with Radeon Graphics",
    "AMD EPYC 7R13 Processor",
    "AMD Ryzen 5 3580U Microsoft Surface® Edition",
    "Apple M1",
    "Apple M1 Pro",
    "Apple M1 Max",
    "Apple M2",
    "Apple M3 Max",
    "Apple M4 Pro",
    "Neoverse-N1",
    "ARMv8 Processor rev 1 (v8l)",
    "1075T",
    "1075t",
    "Gen A10-8700P APU(R)",
    "Intel",
    "Core i7",
    "(R)",
    " CPU @ 3GHz",
    "x",
    "",
]


def cpu_watts(model):
    with mock.patch.object(cpu, "detect_cpu_model", return_value=model):
        found = cpu.TDP()
    return CPU.from_utils(".", "constant", found.model, found.tdp).total_power().W


models = [
    [model, outcome(lambda model=model: tdp._get_cpu_power_from_registry(model)) if model else None, outcome(lambda model=model: cpu_watts(model))]
    for model in MODELS
]

# RAPL files: the max range, the reading at start and the readings of two
# deltas. The power of a RAPL file is not ported: only the energy reaches the
# emissions.
RAPL_CASES = [
    ["262143328850\n", ["1000000\n", "3500000\n", "3600000\n"]],
    ["262143328850\n", ["262143000000\n", "500000\n", "900000\n"]],
    [" 65532610987 ", ["42", "42", "65532610987"]],
    ["262143328850\n", ["7\n", "9\n", "8\n"]],
]
rapl = []
with tempfile.TemporaryDirectory() as folder:
    for max_text, readings in RAPL_CASES:
        energy, max_energy = Path(folder, "energy_uj"), Path(folder, "max_energy_range_uj")
        max_energy.write_text(max_text)
        energy.write_text(readings[0])
        file = RAPLFile(name="package-0", path=str(energy), max_path=str(max_energy))
        file.start()
        deltas = []
        for reading in readings[1:]:
            energy.write_text(reading)
            file.delta(Time(1.0))
            deltas.append(file.energy_delta.kWh)
        rapl.append([max_text, readings, deltas])

# Logs of powermetrics.
LOGS = [
    "CPU Power: 1234 mW\nGPU Power: 56 mW\nCPU Power: 4321 mW\nGPU Power: 0 mW\n",
    "*** Sampled system activity ***\nCPU Power: 999 mW\nGPU Power: 1 mW\nANE Power: 7 mW\nCPU Power: 1001 mW\nCombined Power (CPU + GPU + ANE): 2000 mW\n",
    "CPU Power: ٣٤ mW\nGPU Power: 12 mW\n",
    "CPU Power: 12.5 mW\nCPU Power: 3 W\n",
    "",
]
powermetrics = []
with tempfile.TemporaryDirectory() as folder:
    for log in LOGS:
        Path(folder, "powermetrics_log.txt").write_text(log)
        reader = object.__new__(ApplePowermetrics)
        reader._log_file_path = str(Path(folder, "powermetrics_log.txt"))
        reader._interval = 100
        reader._log_values = lambda: None
        details = reader.get_details()
        powermetrics.append([log, number(details["CPU Power"]), number(details["GPU Power"])])

generator = (
    f"codecarbon {VERSIONS['codecarbon']}, pandas {VERSIONS['pandas']}, numpy {VERSIONS['numpy']}, "
    f"rapidfuzz {VERSIONS['rapidfuzz']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "sha256": {file: hashlib.sha256((DATA / file).read_bytes()).hexdigest() for file in FILES},
            "cpu_table": [[name, value] for name, value in zip(cpu_table["Name"], cpu_table["TDP"], strict=True)],
            "impact_table": [
                [provider, region, int(value)]
                for provider, region, value in zip(impact["provider"], impact["region"], impact["impact"], strict=True)
            ],
            "units": units,
            "kwh": KWH,
            "private_infra": private_infra,
            "cloud": cloud,
            "clouds": clouds,
            "registry": registry,
            "models": models,
            "rapl": rapl,
            "powermetrics": powermetrics,
        },
        ensure_ascii=False,
        indent=1,
        allow_nan=False,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(private_infra)} places, {len(registry)} CPU names, {len(models)} models", file=sys.stderr)
