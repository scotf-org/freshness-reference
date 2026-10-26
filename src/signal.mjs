// Turning an estimate into the signal each role is allowed to see.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
//
// The Pilot 1 capture protocol states the rule this file implements: each participant owns its
// data and shares only the fields agreed for each role, and the distributor sees the signal and
// an alert flag, not the grower's commercial data.
//
// The filter is an allow-list, not a deny-list. A field added to an estimate later is withheld
// from every role until someone decides it may be shared, which is the safe direction for a
// mistake to fall.

export const ROLES = ['grower', 'distributor', 'retailer'];

// Which fields each role receives. The grower owns the record and sees all of it.
const VISIBLE = {
  grower: ['palletId', 'remainingDays', 'confidenceDays', 'consumedDays', 'band', 'alert', 'basis', 'readings', 'qualityAtPack'],
  distributor: ['palletId', 'remainingDays', 'band', 'alert'],
  retailer: ['palletId', 'band', 'alert']
};

/** An alert is the one judgement the signal carries: this pallet needs attention before arrival. */
export const alertFor = (band) => band === 'use-now' || band === 'expired';

export const filterForRole = (record, role) => {
  const allowed = VISIBLE[role];
  if (!allowed) {
    throw new Error(`unknown role ${role}: expected one of ${ROLES.join(', ')}`);
  }
  const out = {};
  for (const key of allowed) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
};

/** Build the full record once, then filter it per role, so every role sees the same estimate. */
export const toSignal = (palletRecord, estimate) => ({
  palletId: palletRecord.palletId,
  remainingDays: Number(estimate.remainingDays.toFixed(2)),
  confidenceDays: estimate.confidenceDays.map((d) => Number(d.toFixed(2))),
  consumedDays: Number(estimate.consumedDays.toFixed(2)),
  band: estimate.band,
  alert: alertFor(estimate.band),
  basis: estimate.basis,
  readings: palletRecord.temperatures.length,
  qualityAtPack: palletRecord.qualityAtPack
});
