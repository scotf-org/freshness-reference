// The estimator interface, and one open example model that satisfies it.
// Part of Freshness Reference, contributed by TOTEM LLC. Licensed under Apache-2.0.
// Built with TOTEM Agentic OS (TAO) · https://url.totemltd.com/tao
//
// An estimator is any object of the shape { name, version, estimate(input) -> Estimate }.
// The pipeline never looks inside one, so a partner can supply their own model without this
// repository knowing anything about it. checkEstimator reports what a candidate is missing.
//
// The example model here is illustrative. It is open, it is simple enough to read in one sitting,
// and it is NOT a validated shelf-life model: no partner model is used, and nothing in it is
// fitted to data. It exists so the pipeline can be run end to end and so the interface has a
// worked example to copy.

/**
 * @typedef {Object} EstimatorInput
 * @property {string} palletId                     the pallet the estimate is about
 * @property {Object} qualityAtPack                the inspection recorded before departure
 * @property {boolean} qualityAtPack.acceptable
 * @property {number} [qualityAtPack.ripenessStage]
 * @property {string} qualityAtPack.inspectedAt    ISO 8601 with offset
 * @property {Array<{at: string, celsius: number}>} temperatures   readings, in time order
 * @property {string} asOf                         the moment the estimate is made
 * @property {Object} [options]                    model configuration; see configure()
 *
 * @typedef {Object} Estimate
 * @property {number} remainingDays
 * @property {[number, number]} confidenceDays     low and high, inclusive of remainingDays
 * @property {number} consumedDays                 how much of the budget the history used
 * @property {string} band                         one of BANDS
 * @property {string} basis                        what produced this number, in words
 */

export const BANDS = ['fresh', 'use-soon', 'use-now', 'expired'];

// Thresholds in days. A band is a reading aid, not a decision: the decision belongs to the
// receiver, and the thresholds are deliberately easy to change.
const BAND_EDGES = [
  { band: 'fresh', atLeast: 5 },
  { band: 'use-soon', atLeast: 2 },
  { band: 'use-now', atLeast: 0.5 },
  { band: 'expired', atLeast: -Infinity }
];

export const bandFor = (remainingDays) =>
  (BAND_EDGES.find((e) => remainingDays >= e.atLeast) ?? BAND_EDGES.at(-1)).band;

export const checkEstimator = (candidate) => {
  const problems = [];
  const c = candidate ?? {};
  if (typeof c.name !== 'string' || c.name.length === 0) problems.push('name must be a non-empty string');
  if (typeof c.version !== 'string' || c.version.length === 0) problems.push('version must be a non-empty string');
  if (typeof c.estimate !== 'function') problems.push('estimate must be a function');
  return problems;
};

// The one rule the example model encodes: ageing roughly doubles for every ten degrees Celsius.
// That is the Q10 idea, stated in the Pilot 1 capture protocol as postharvest life falling by
// about half for each 10 °C rise. Here it is an illustrative constant, not a fitted parameter.
const Q10 = 2;
const Q10_INTERVAL_C = 10;

const ageingRate = (celsius, referenceC) =>
  Q10 ** ((celsius - referenceC) / Q10_INTERVAL_C);

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3_600_000;

/**
 * Consume the shelf-life budget across a temperature history, trapezoid by trapezoid.
 * A reading holds until the next one; the last reading holds until asOf.
 */
const consumedDays = (temperatures, asOf, referenceC) => {
  if (temperatures.length === 0) return 0;
  let hours = 0;
  for (let i = 0; i < temperatures.length; i++) {
    const from = temperatures[i];
    const to = temperatures[i + 1];
    const span = hoursBetween(from.at, to ? to.at : asOf);
    if (!Number.isFinite(span) || span <= 0) continue;
    // Average the two endpoint rates rather than assuming a step change at each reading.
    const rate = to
      ? (ageingRate(from.celsius, referenceC) + ageingRate(to.celsius, referenceC)) / 2
      : ageingRate(from.celsius, referenceC);
    hours += span * rate;
  }
  return hours / 24;
};

const requireOptions = (options) => {
  const o = options ?? {};
  // Deliberately unset. A reference implementation that ships a default shelf life would be
  // inventing a domain fact, and every reader would inherit it without noticing.
  if (typeof o.baselineDays !== 'number') {
    throw new Error('baselineDays is required: the shelf life at the reference temperature, which only the owner of the commodity can supply');
  }
  if (typeof o.referenceC !== 'number') {
    throw new Error('referenceC is required: the temperature baselineDays is measured at');
  }
  return o;
};

export const exampleModel = {
  name: 'open-q10-example',
  version: '0.1.0',

  /** Validate configuration up front, so a misconfigured run fails before it produces numbers. */
  configure(options) {
    return requireOptions(options);
  },

  /** @param {EstimatorInput} input @returns {Estimate} */
  estimate(input) {
    const { baselineDays, referenceC } = requireOptions(input.options);

    if (input.qualityAtPack?.acceptable === false) {
      return {
        remainingDays: 0,
        confidenceDays: [0, 0],
        consumedDays: 0,
        band: 'expired',
        basis: 'The quality record says the product was not acceptable at pack, so no shelf life is estimated.'
      };
    }

    const used = consumedDays(input.temperatures ?? [], input.asOf, referenceC);
    const remaining = Math.max(0, baselineDays - used);

    // A flat band, widening with how much history was consumed. It expresses that the estimate
    // is less certain the longer and warmer the journey, and it is not a fitted interval.
    const spread = Math.max(0.5, used * 0.25);

    return {
      remainingDays: remaining,
      confidenceDays: [Math.max(0, remaining - spread), remaining + spread],
      consumedDays: used,
      band: bandFor(remaining),
      basis: `open-q10-example: ${baselineDays} day budget at ${referenceC} °C, ageing doubled per ${Q10_INTERVAL_C} °C, ${used.toFixed(2)} days consumed by the recorded history. Illustrative, not a validated model.`
    };
  }
};
