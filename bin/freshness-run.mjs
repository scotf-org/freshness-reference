#!/usr/bin/env node
// Run the freshness pipeline over a directory of EPCIS documents.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
import { readFileSync, readdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { run } from '../src/pipeline.mjs';
import { exampleModel } from '../src/estimator.mjs';
import { ROLES } from '../src/signal.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const inDir = flag('--in', 'examples/synthetic');
const role = flag('--role', 'distributor');
const asOf = flag('--as-of');
const optionsPath = flag('--options', joinPath(inDir, 'model-options.json'));

if (args.includes('--help') || !ROLES.includes(role)) {
  console.error(`usage: freshness-run [--in <dir>] [--role <${ROLES.join('|')}>] [--as-of <iso>] [--options <file>]

Reads every EPCIS document in --in, joins sensor readings to quality at pack on the pallet
identifier, estimates remaining shelf life with the open example model, and prints the signal
the chosen role is allowed to see.

The model needs a shelf-life budget and the temperature it is measured at. Neither has a default:
they are domain facts about a commodity, so they are read from --options and travel with the data.

Validate your events first with scotf-validate from the scotf-schemas repository. This tool reads
events and does not re-check them against the profiles.`);
  process.exit(args.includes('--help') ? 0 : 2);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

let options;
try {
  const { baselineDays, referenceC } = readJson(optionsPath);
  options = { baselineDays, referenceC };
} catch (e) {
  console.error(`could not read model options from ${optionsPath}: ${e.message}`);
  process.exit(2);
}

const docs = readdirSync(inDir)
  .filter((f) => f.endsWith('.json') && !f.includes('model-options'))
  .sort()
  .map((f) => ({ file: f, doc: readJson(joinPath(inDir, f)) }));

const sensorDocs = docs.map((d) => d.doc);
const qualityDocs = docs.map((d) => d.doc);

// asOf defaults to the last reading in the data, not to the clock, so the run is reproducible.
const lastReading = sensorDocs
  .flatMap((d) => d.epcisBody?.eventList ?? [])
  .flatMap((e) => (e.sensorElementList ?? []).flatMap((el) => el.sensorReport ?? [])
    .map((r) => r.time ?? e.eventTime))
  .filter(Boolean)
  .sort()
  .at(-1);

const result = run({
  sensorDocs,
  qualityDocs,
  estimator: exampleModel,
  options,
  asOf: asOf ?? lastReading,
  role
});

console.log(JSON.stringify(result, null, 2));
if (result.palletsWithoutQualityRecord.length) {
  console.error(`\nnote: ${result.palletsWithoutQualityRecord.length} pallet(s) had readings but no quality-at-pack record`);
}
