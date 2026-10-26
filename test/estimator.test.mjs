// The estimator contract: what any model must accept and return to plug in.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
//
// This file is the specification of the interface, not only a check on one model. The acceptance
// criterion is that any model can plug in, so the tests run against the contract and the example
// model is just the first implementation to satisfy it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, bandFor, checkEstimator, exampleModel } from '../src/estimator.mjs';

const input = {
  palletId: 'urn:epc:id:sscc:0614141.1000000001',
  qualityAtPack: { acceptable: true, ripenessStage: 3, inspectedAt: '2026-09-14T06:00:00Z' },
  temperatures: [
    { at: '2026-09-14T07:00:00Z', celsius: 2 },
    { at: '2026-09-14T08:00:00Z', celsius: 2 }
  ],
  asOf: '2026-09-14T08:00:00Z',
  // Supplied by the caller, never by the model. Illustrative values for the test only.
  options: { baselineDays: 10, referenceC: 0 }
};

describe('the estimator contract', () => {
  test('a model is named, versioned and callable', () => {
    assert.equal(typeof exampleModel.name, 'string');
    assert.ok(exampleModel.name.length > 0);
    assert.equal(typeof exampleModel.version, 'string');
    assert.equal(typeof exampleModel.estimate, 'function');
  });

  test('checkEstimator accepts a conforming model', () => {
    assert.deepEqual(checkEstimator(exampleModel), []);
  });

  test('checkEstimator names what is missing, rather than throwing', () => {
    assert.deepEqual(checkEstimator({}), [
      'name must be a non-empty string',
      'version must be a non-empty string',
      'estimate must be a function'
    ]);
    assert.deepEqual(checkEstimator({ name: 'm', version: '1', estimate: 1 }),
      ['estimate must be a function']);
  });

  test('an estimate carries days, a confidence range, a band and its basis', () => {
    const e = exampleModel.estimate(input);
    assert.equal(typeof e.remainingDays, 'number');
    assert.ok(Number.isFinite(e.remainingDays));
    assert.ok(Array.isArray(e.confidenceDays) && e.confidenceDays.length === 2);
    assert.ok(e.confidenceDays[0] <= e.remainingDays && e.remainingDays <= e.confidenceDays[1],
      'the estimate must sit inside its own confidence range');
    assert.ok(BANDS.includes(e.band));
    assert.ok(typeof e.basis === 'string' && e.basis.length > 20,
      'an estimate must say what produced it, or a reader cannot judge it');
  });

  test('the model refuses to invent a shelf life it was not given', () => {
    // The whole point: a reference implementation must not supply a domain constant by default.
    assert.throws(() => exampleModel.estimate({ ...input, options: {} }), /baselineDays/);
    assert.throws(() => exampleModel.configure({ referenceC: 0 }), /baselineDays/);
    assert.throws(() => exampleModel.configure({ baselineDays: 10 }), /referenceC/);
  });

  test('warmer transit consumes more of the budget than colder transit', () => {
    const cold = exampleModel.estimate(input);
    const warm = exampleModel.estimate({
      ...input,
      temperatures: input.temperatures.map((t) => ({ ...t, celsius: 20 }))
    });
    assert.ok(warm.remainingDays < cold.remainingDays,
      'a warmer history must leave less life, or the model is not using temperature');
  });

  test('the ageing rule is the documented doubling, not a hidden curve', () => {
    // Ten degrees warmer should age the product about twice as fast. Checked as a ratio of
    // consumption over the same window, so it does not depend on the baseline chosen.
    const at = (c) => {
      const e = exampleModel.estimate({
        ...input,
        temperatures: [
          { at: '2026-09-14T07:00:00Z', celsius: c },
          { at: '2026-09-15T07:00:00Z', celsius: c }
        ],
        asOf: '2026-09-15T07:00:00Z',
        options: { baselineDays: 10, referenceC: 0 }
      });
      return e;
    };
    const consumedAt0 = at(0).consumedDays;
    const consumedAt10 = at(10).consumedDays;
    assert.ok(Math.abs(consumedAt10 / consumedAt0 - 2) < 1e-9,
      `ten degrees should double consumption, got ${consumedAt10 / consumedAt0}`);
  });

  test('bands run from the most to the least life, and cover every value', () => {
    assert.deepEqual(BANDS, ['fresh', 'use-soon', 'use-now', 'expired']);
    assert.equal(bandFor(99), 'fresh');
    assert.equal(bandFor(0), 'expired');
    assert.equal(bandFor(-5), 'expired');
    // Every non-negative day count must land in a band.
    for (let d = 0; d <= 30; d += 0.5) assert.ok(BANDS.includes(bandFor(d)), `no band for ${d}`);
  });

  test('a quality record that was not acceptable at pack cannot read as fresh', () => {
    const e = exampleModel.estimate({
      ...input,
      qualityAtPack: { ...input.qualityAtPack, acceptable: false }
    });
    assert.equal(e.remainingDays, 0);
    assert.equal(e.band, 'expired');
    assert.match(e.basis, /not acceptable at pack/);
  });
});
