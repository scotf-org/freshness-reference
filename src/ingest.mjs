// Reading SCOTF Profile 1 sensor events and Profile 2 quality observations into pallet records.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
//
// This module reads events; it does not validate them. Conformance is scotf-schemas' job, and
// duplicating its rules here would give the project two definitions of a valid event that could
// drift apart. The quick start tells a reader to run scotf-validate first, and readEvents fails
// loudly on anything it cannot interpret rather than guessing.

const CEL = 'CEL';
const FAH = 'FAH';
const POSITION = 'https://ref.scotf.org/epcis-ext/Position';

/** Fahrenheit readings are converted on the way in, so the pipeline holds one unit throughout. */
export const toCelsius = (value, uom) => {
  if (uom === CEL) return value;
  if (uom === FAH) return (value - 32) * 5 / 9;
  throw new Error(`unsupported temperature unit ${uom}: expected ${CEL} or ${FAH}`);
};

const eventsOf = (doc) => doc?.epcisBody?.eventList ?? [];

/** The single temperature a report carries, whichever of the three shapes it uses. */
const temperatureOf = (report) => {
  if (typeof report.value === 'number') return report.value;
  if (typeof report.meanValue === 'number') return report.meanValue;
  if (typeof report.minValue === 'number' && typeof report.maxValue === 'number') {
    return (report.minValue + report.maxValue) / 2;
  }
  return undefined;
};

/**
 * Pull the temperature history out of Profile 1 sensor events, keyed by pallet.
 * A Position report is ignored here: this pipeline estimates shelf life, and a track is both
 * irrelevant to that and the strongest location signal in the data.
 */
export const readSensorEvents = (docs) => {
  const byPallet = new Map();
  for (const doc of [docs].flat()) {
    for (const event of eventsOf(doc)) {
      if (event.bizStep !== 'sensor_reporting') continue;
      const palletIds = event.epcList ?? [];
      if (palletIds.length === 0) continue;

      for (const element of event.sensorElementList ?? []) {
        for (const report of element.sensorReport ?? []) {
          if (report.type !== 'Temperature') continue;
          const raw = temperatureOf(report);
          if (raw === undefined) continue;
          const at = report.time ?? element.sensorMetadata?.endTime ?? event.eventTime;
          const celsius = toCelsius(raw, report.uom);
          for (const palletId of palletIds) {
            if (!byPallet.has(palletId)) byPallet.set(palletId, { palletId, temperatures: [] });
            byPallet.get(palletId).temperatures.push({ at, celsius });
          }
        }
      }
    }
  }
  // Time order matters: the estimator integrates across the gaps between readings.
  for (const record of byPallet.values()) {
    record.temperatures.sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  return byPallet;
};

/**
 * Pull the quality-at-pack record out of Profile 2 inspection events, keyed by pallet.
 * Only the supplier's inspection is quality at pack; a receiver's arrival check describes what
 * arrived, which is the thing an estimate is later compared against rather than an input to it.
 */
export const readQualityEvents = (docs) => {
  const byPallet = new Map();
  for (const doc of [docs].flat()) {
    for (const event of eventsOf(doc)) {
      if (event.bizStep !== 'inspecting') continue;
      const inspection = event['scotf:inspection'];
      if (!inspection || inspection.inspectedBy !== 'supplier') continue;
      for (const palletId of event.epcList ?? []) {
        byPallet.set(palletId, {
          acceptable: inspection.acceptable,
          ripenessStage: inspection.ripenessStage,
          inspectedAt: event.eventTime,
          temperatureC: inspection.temperature
            ? toCelsius(inspection.temperature.value, inspection.temperature.uom)
            : undefined
        });
      }
    }
  }
  return byPallet;
};

/**
 * Join the two sides on the pallet identifier, which is the whole point of the profiles: two
 * companies' records meet on one pallet. A pallet with readings but no quality record is reported
 * rather than dropped, because a silent drop looks the same as a pallet that never shipped.
 */
export const join = (sensorByPallet, qualityByPallet) => {
  const joined = [];
  const unmatched = [];
  for (const record of sensorByPallet.values()) {
    const qualityAtPack = qualityByPallet.get(record.palletId);
    if (!qualityAtPack) {
      unmatched.push(record.palletId);
      continue;
    }
    joined.push({ ...record, qualityAtPack });
  }
  return { joined, unmatched };
};
