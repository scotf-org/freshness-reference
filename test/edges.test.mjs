// What the pipeline does with events that are odd, sparse or malformed.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
//
// Real feeds carry gaps. These cases are the ones that would otherwise turn into a NaN, a silent
// drop or a confident number built on nothing, and each is checked for what a reader would notice
// rather than for the line it happens to execute.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readSensorEvents, readQualityEvents, join } from '../src/ingest.mjs';
import { exampleModel, bandFor } from '../src/estimator.mjs';
import { toSignal } from '../src/signal.mjs';

const PALLET = 'urn:epc:id:sscc:0614141.1000000001';
const OPTIONS = { baselineDays: 10, referenceC: 0 };

const doc = (event) => ({ epcisBody: { eventList: [event] } });
const sensorEvent = (over = {}) => ({
  bizStep: 'sensor_reporting',
  eventTime: '2026-09-14T07:00:00Z',
  epcList: [PALLET],
  sensorElementList: [{ sensorReport: [{ type: 'Temperature', uom: 'CEL', value: 3 }] }],
  ...over
});

describe('events that are missing pieces', () => {
  test('a temperature report with no reading is skipped, not read as NaN', () => {
    // Profile 1 requires a value, a mean, or a min and max pair. A feed that breaks that rule
    // must not put NaN into the history, where it would poison every later arithmetic step.
    const got = readSensorEvents(doc(sensorEvent({
      sensorElementList: [{ sensorReport: [
        { type: 'Temperature', uom: 'CEL' },
        { type: 'Temperature', uom: 'CEL', value: 4 }
      ] }]
    })));
    const temps = got.get(PALLET).temperatures;
    assert.equal(temps.length, 1);
    assert.equal(temps[0].celsius, 4);
    assert.ok(temps.every((t) => Number.isFinite(t.celsius)));
  });

  test('a min without a max is not half a reading', () => {
    const got = readSensorEvents(doc(sensorEvent({
      sensorElementList: [{ sensorReport: [{ type: 'Temperature', uom: 'CEL', minValue: 2 }] }]
    })));
    assert.equal(got.size, 0, 'a one-sided range is not a reading');
  });

  test('an event with no pallet is skipped rather than keyed to nothing', () => {
    assert.equal(readSensorEvents(doc(sensorEvent({ epcList: undefined }))).size, 0);
    assert.equal(readSensorEvents(doc(sensorEvent({ epcList: [] }))).size, 0);
  });

  test('a sensor element with no reports, and an event with no elements, are both harmless', () => {
    assert.equal(readSensorEvents(doc(sensorEvent({ sensorElementList: [{}] }))).size, 0);
    assert.equal(readSensorEvents(doc(sensorEvent({ sensorElementList: undefined }))).size, 0);
  });

  test('a document with no body does not throw', () => {
    assert.equal(readSensorEvents({}).size, 0);
    assert.equal(readQualityEvents([{}, { epcisBody: {} }]).size, 0);
  });

  test('a reading with no time of its own falls back to the window end, then the event', () => {
    const windowEnd = readSensorEvents(doc(sensorEvent({
      sensorElementList: [{
        sensorMetadata: { endTime: '2026-09-14T09:00:00Z' },
        sensorReport: [{ type: 'Temperature', uom: 'CEL', value: 3 }]
      }]
    })));
    assert.equal(windowEnd.get(PALLET).temperatures[0].at, '2026-09-14T09:00:00Z');

    const eventTime = readSensorEvents(doc(sensorEvent()));
    assert.equal(eventTime.get(PALLET).temperatures[0].at, '2026-09-14T07:00:00Z');
  });

  test('an inspection with no temperature is still a quality record', () => {
    const got = readQualityEvents(doc({
      bizStep: 'inspecting',
      eventTime: '2026-09-14T06:00:00Z',
      epcList: [PALLET],
      'scotf:inspection': { inspectedBy: 'supplier', acceptable: true }
    }));
    assert.equal(got.get(PALLET).acceptable, true);
    assert.equal(got.get(PALLET).temperatureC, undefined);
  });

  test('an inspection temperature in Fahrenheit is converted like any other', () => {
    const got = readQualityEvents(doc({
      bizStep: 'inspecting',
      eventTime: '2026-09-14T06:00:00Z',
      epcList: [PALLET],
      'scotf:inspection': { inspectedBy: 'supplier', acceptable: true, temperature: { value: 32, uom: 'FAH' } }
    }));
    assert.equal(got.get(PALLET).temperatureC, 0);
  });

  test('an event with no inspection object is not a quality record', () => {
    const got = readQualityEvents(doc({
      bizStep: 'inspecting', eventTime: '2026-09-14T06:00:00Z', epcList: [PALLET]
    }));
    assert.equal(got.size, 0);
  });

  test('joining nothing to nothing is empty, not an error', () => {
    const { joined, unmatched } = join(new Map(), new Map());
    assert.deepEqual(joined, []);
    assert.deepEqual(unmatched, []);
  });
});

describe('estimates built on thin evidence', () => {
  const base = {
    palletId: PALLET,
    qualityAtPack: { acceptable: true, inspectedAt: '2026-09-14T06:00:00Z' },
    asOf: '2026-09-15T07:00:00Z',
    options: OPTIONS
  };

  test('no readings consumes nothing, and says so rather than guessing', () => {
    const e = exampleModel.estimate({ ...base, temperatures: [] });
    assert.equal(e.consumedDays, 0);
    assert.equal(e.remainingDays, OPTIONS.baselineDays);
    assert.match(e.basis, /0\.00 days consumed/);
  });

  test('a reading timestamped after asOf does not run the clock backwards', () => {
    // A backfilled reading can arrive with a time later than the moment being estimated. It must
    // not credit shelf life back, which an unguarded negative span would do.
    const e = exampleModel.estimate({
      ...base,
      temperatures: [{ at: '2026-09-16T07:00:00Z', celsius: 20 }]
    });
    assert.ok(e.consumedDays >= 0, 'a later reading gave back shelf life');
    assert.ok(e.remainingDays <= OPTIONS.baselineDays);
  });

  test('a long warm journey floors at zero rather than going negative', () => {
    const e = exampleModel.estimate({
      ...base,
      temperatures: [{ at: '2026-08-01T00:00:00Z', celsius: 30 }],
      asOf: '2026-09-15T00:00:00Z'
    });
    assert.equal(e.remainingDays, 0);
    assert.equal(e.band, 'expired');
    assert.ok(e.confidenceDays[0] >= 0, 'a confidence range must not promise negative days');
  });

  test('every band edge lands on the band a reader would expect', () => {
    assert.equal(bandFor(5), 'fresh');
    assert.equal(bandFor(4.99), 'use-soon');
    assert.equal(bandFor(2), 'use-soon');
    assert.equal(bandFor(1.99), 'use-now');
    assert.equal(bandFor(0.5), 'use-now');
    assert.equal(bandFor(0.49), 'expired');
  });

  test('a signal rounds for reading without changing the band', () => {
    const estimate = exampleModel.estimate({ ...base, temperatures: [{ at: '2026-09-14T07:00:00Z', celsius: 2 }] });
    const signal = toSignal({ palletId: PALLET, temperatures: [{}], qualityAtPack: base.qualityAtPack }, estimate);
    assert.equal(signal.band, estimate.band, 'rounding must not move a pallet into another band');
    assert.equal(signal.readings, 1);
    assert.ok(Number.isFinite(signal.remainingDays));
  });
});
