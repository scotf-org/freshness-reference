// The pipeline: events in, role-filtered signals out.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
import { readSensorEvents, readQualityEvents, join } from './ingest.mjs';
import { checkEstimator } from './estimator.mjs';
import { toSignal, filterForRole } from './signal.mjs';

/**
 * Run the whole pipeline.
 *
 * @param {Object} args
 * @param {Array} args.sensorDocs    Profile 1 EPCIS documents
 * @param {Array} args.qualityDocs   Profile 2 EPCIS documents
 * @param {Object} args.estimator    any object satisfying the estimator contract
 * @param {Object} args.options      model configuration, passed through untouched
 * @param {string} args.asOf         the moment the estimate is made
 * @param {string} args.role         whose view to return
 */
export const run = ({ sensorDocs, qualityDocs, estimator, options, asOf, role }) => {
  const problems = checkEstimator(estimator);
  if (problems.length) {
    throw new Error(`the estimator does not satisfy the interface: ${problems.join('; ')}`);
  }
  if (typeof asOf !== 'string') {
    throw new Error('asOf is required: an estimate is only meaningful at a stated moment');
  }

  const sensors = readSensorEvents(sensorDocs);
  const quality = readQualityEvents(qualityDocs);
  const { joined, unmatched } = join(sensors, quality);

  const signals = joined
    .map((record) => {
      const estimate = estimator.estimate({
        palletId: record.palletId,
        qualityAtPack: record.qualityAtPack,
        temperatures: record.temperatures,
        asOf,
        options
      });
      return toSignal(record, estimate);
    })
    // Most urgent first: the reason the signal exists is to change a decision in time.
    .sort((a, b) => a.remainingDays - b.remainingDays);

  return {
    asOf,
    role,
    model: `${estimator.name}@${estimator.version}`,
    signals: signals.map((s) => filterForRole(s, role)),
    // Reported, never silently dropped: a pallet with readings and no quality record is a gap in
    // the capture, and the binding check in the protocol exists precisely to catch it.
    palletsWithoutQualityRecord: unmatched
  };
};
