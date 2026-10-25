// Ingest, join, role filter and the pipeline end to end.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readSensorEvents, readQualityEvents, join, toCelsius } from '../src/ingest.mjs';
import { filterForRole, alertFor, ROLES } from '../src/signal.mjs';
import { exampleModel } from '../src/estimator.mjs';
import { run } from '../src/pipeline.mjs';

const PALLET = 'urn:epc:id:sscc:0614141.1000000001';
const OTHER = 'urn:epc:id:sscc:0614141.1000000002';

const sensorDoc = (palletId, reports) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
    { scotf: 'https://ref.scotf.org/epcis-ext/' }],
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  epcisBody: {
    eventList: [{
      type: 'ObjectEvent',
      eventTime: '2026-09-14T07:00:00Z',
      eventTimeZoneOffset: '+00:00',
      action: 'OBSERVE',
      bizStep: 'sensor_reporting',
      disposition: 'in_transit',
      epcList: [palletId],
      readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' },
      sensorElementList: [{ sensorReport: reports }]
    }]
  }
});

const qualityDoc = (palletId, inspection) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
    { scotf: 'https://ref.scotf.org/epcis-ext/' }],
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  epcisBody: {
    eventList: [{
      type: 'ObjectEvent',
      eventTime: '2026-09-14T06:00:00Z',
      eventTimeZoneOffset: '+00:00',
      action: 'OBSERVE',
      bizStep: 'inspecting',
      disposition: inspection.acceptable ? 'conformant' : 'non_conformant',
      epcList: [palletId],
      readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' },
      'scotf:inspection': inspection
    }]
  }
});

const OPTIONS = { baselineDays: 10, referenceC: 0 };

describe('ingest', () => {
  test('Fahrenheit readings are converted on the way in', () => {
    assert.equal(toCelsius(32, 'FAH'), 0);
    assert.equal(toCelsius(5, 'CEL'), 5);
    assert.throws(() => toCelsius(5, 'KGM'), /unsupported temperature unit/);
  });

  test('a Fahrenheit event and a Celsius event give the same history', () => {
    const c = readSensorEvents(sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', value: 0 }]));
    const f = readSensorEvents(sensorDoc(PALLET, [{ type: 'Temperature', uom: 'FAH', value: 32 }]));
    assert.equal(c.get(PALLET).temperatures[0].celsius, f.get(PALLET).temperatures[0].celsius);
  });

  test('a position report is not mistaken for a temperature', () => {
    const got = readSensorEvents(sensorDoc(PALLET, [
      { type: 'Temperature', uom: 'CEL', value: 4 },
      { type: 'https://ref.scotf.org/epcis-ext/Position', coordinateReferenceSystem: 'EPSG:4326', component: 'latitude', value: 36.7, uom: 'DD' }
    ]));
    assert.equal(got.get(PALLET).temperatures.length, 1);
    assert.equal(got.get(PALLET).temperatures[0].celsius, 4);
  });

  test('a min and max pair is read as its midpoint, and a mean is read directly', () => {
    const pair = readSensorEvents(sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', minValue: 2, maxValue: 6 }]));
    assert.equal(pair.get(PALLET).temperatures[0].celsius, 4);
    const mean = readSensorEvents(sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', meanValue: 5 }]));
    assert.equal(mean.get(PALLET).temperatures[0].celsius, 5);
  });

  test('readings come back in time order even when the events are not', () => {
    const late = sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', value: 9, time: '2026-09-14T20:00:00Z' }]);
    const early = sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', value: 1, time: '2026-09-14T08:00:00Z' }]);
    const got = readSensorEvents([late, early]).get(PALLET).temperatures;
    assert.deepEqual(got.map((t) => t.celsius), [1, 9]);
  });

  test('an inspection by a receiver is not quality at pack', () => {
    const supplier = readQualityEvents(qualityDoc(PALLET, { inspectedBy: 'supplier', acceptable: true }));
    assert.equal(supplier.size, 1);
    const receiver = readQualityEvents(qualityDoc(PALLET, { inspectedBy: 'receiver', acceptable: true }));
    assert.equal(receiver.size, 0, 'an arrival check describes what arrived, not what shipped');
  });

  test('a pallet with readings but no quality record is reported, not dropped', () => {
    const sensors = readSensorEvents([
      sensorDoc(PALLET, [{ type: 'Temperature', uom: 'CEL', value: 2 }]),
      sensorDoc(OTHER, [{ type: 'Temperature', uom: 'CEL', value: 2 }])
    ]);
    const quality = readQualityEvents(qualityDoc(PALLET, { inspectedBy: 'supplier', acceptable: true }));
    const { joined, unmatched } = join(sensors, quality);
    assert.equal(joined.length, 1);
    assert.deepEqual(unmatched, [OTHER]);
  });
});

describe('the role filter', () => {
  const full = {
    palletId: PALLET, remainingDays: 6, confidenceDays: [5, 7], consumedDays: 4,
    band: 'fresh', alert: false, basis: 'because', readings: 12,
    qualityAtPack: { acceptable: true, ripenessStage: 3 }
  };

  test('a distributor sees the signal and the flag, not the grower record', () => {
    const seen = filterForRole(full, 'distributor');
    assert.deepEqual(Object.keys(seen).sort(), ['alert', 'band', 'palletId', 'remainingDays']);
    assert.ok(!('qualityAtPack' in seen), "the grower's record must not travel to the distributor");
    assert.ok(!('basis' in seen));
  });

  test('a retailer sees less again, and the grower sees all of it', () => {
    assert.deepEqual(Object.keys(filterForRole(full, 'retailer')).sort(), ['alert', 'band', 'palletId']);
    assert.ok('qualityAtPack' in filterForRole(full, 'grower'));
  });

  test('an unknown role is refused rather than defaulted', () => {
    assert.throws(() => filterForRole(full, 'anyone'), /unknown role/);
  });

  test('a field nobody has decided about is withheld from every role', () => {
    // The allow-list matters most for fields added later: they must not leak by default.
    const withNewField = { ...full, 'commercialValue': 12345 };
    for (const role of ROLES) {
      assert.ok(!('commercialValue' in filterForRole(withNewField, role)),
        `${role} received a field that was never added to the allow-list`);
    }
  });

  test('an alert is raised only when the product needs attention', () => {
    assert.equal(alertFor('fresh'), false);
    assert.equal(alertFor('use-soon'), false);
    assert.equal(alertFor('use-now'), true);
    assert.equal(alertFor('expired'), true);
  });
});

describe('the pipeline end to end', () => {
  const sensors = [sensorDoc(PALLET, [
    { type: 'Temperature', uom: 'CEL', value: 2, time: '2026-09-14T07:00:00Z' },
    { type: 'Temperature', uom: 'CEL', value: 2, time: '2026-09-15T07:00:00Z' }
  ])];
  const quality = [qualityDoc(PALLET, { inspectedBy: 'supplier', acceptable: true, ripenessStage: 3 })];

  test('events in, a role-filtered signal out', () => {
    const out = run({
      sensorDocs: sensors, qualityDocs: quality, estimator: exampleModel,
      options: OPTIONS, asOf: '2026-09-15T07:00:00Z', role: 'distributor'
    });
    assert.equal(out.signals.length, 1);
    assert.equal(out.model, 'open-q10-example@0.1.0');
    assert.equal(out.signals[0].palletId, PALLET);
    assert.ok(out.signals[0].remainingDays < 10, 'the journey must have consumed some of the budget');
    assert.deepEqual(out.palletsWithoutQualityRecord, []);
  });

  test('the most urgent pallet is listed first', () => {
    const warm = sensorDoc(OTHER, [
      { type: 'Temperature', uom: 'CEL', value: 25, time: '2026-09-14T07:00:00Z' },
      { type: 'Temperature', uom: 'CEL', value: 25, time: '2026-09-15T07:00:00Z' }
    ]);
    const out = run({
      sensorDocs: [...sensors, warm],
      qualityDocs: [...quality, qualityDoc(OTHER, { inspectedBy: 'supplier', acceptable: true })],
      estimator: exampleModel, options: OPTIONS, asOf: '2026-09-15T07:00:00Z', role: 'grower'
    });
    assert.equal(out.signals[0].palletId, OTHER, 'the warm pallet needs attention first');
    assert.ok(out.signals[0].remainingDays < out.signals[1].remainingDays);
  });

  test('a model that does not satisfy the interface is refused with the reason', () => {
    assert.throws(() => run({
      sensorDocs: sensors, qualityDocs: quality, estimator: { name: 'x' },
      options: OPTIONS, asOf: '2026-09-15T07:00:00Z', role: 'grower'
    }), /does not satisfy the interface: version must be/);
  });

  test('an estimate without a stated moment is refused', () => {
    assert.throws(() => run({
      sensorDocs: sensors, qualityDocs: quality, estimator: exampleModel,
      options: OPTIONS, role: 'grower'
    }), /asOf is required/);
  });

  test('any model can plug in, without the pipeline knowing anything about it', () => {
    const flatModel = {
      name: 'always-three', version: '9.9',
      estimate: () => ({ remainingDays: 3, confidenceDays: [3, 3], consumedDays: 0, band: 'use-soon', basis: 'a fixed answer, for the test' })
    };
    const out = run({
      sensorDocs: sensors, qualityDocs: quality, estimator: flatModel,
      options: {}, asOf: '2026-09-15T07:00:00Z', role: 'distributor'
    });
    assert.equal(out.model, 'always-three@9.9');
    assert.equal(out.signals[0].remainingDays, 3);
  });
});
