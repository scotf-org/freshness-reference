# Freshness Reference

Runnable reference code showing how quality at pack and in-transit sensor events combine into a remaining shelf-life signal, using the SCOTF schema profiles, synthetic data and an open example model.

Part of [Supply Chain of the Future](https://www.scotf.org) (SCOTF). Documentation and explainers are published on The Shelf, SCOTF's open resource library.

## Quick start

```bash
npm install
npm test
npm run example
```

`npm run example` reads the synthetic dataset in `examples/synthetic/`, joins each pallet's temperature history to its quality-at-pack record, estimates remaining shelf life and prints what a distributor is allowed to see. It needs no network and no credentials.

To run it over your own events:

```bash
node bin/freshness-run.mjs --in my-events/ --role distributor --options my-model.json
```

**Validate your events first.** This repository reads events; it does not check them against the profiles. That is `scotf-validate`'s job in [scotf-schemas](https://github.com/scotf-org/scotf-schemas), and duplicating its rules here would give the project two definitions of a valid event that could drift apart.

## What it does

| Step | Module | What happens |
| --- | --- | --- |
| Ingest | `src/ingest.mjs` | Reads Profile 1 sensor events into a temperature history per pallet. Fahrenheit is converted on the way in, so the pipeline holds one unit. Position reports are ignored: a track is irrelevant to shelf life and is the strongest location signal in the data. |
| Join | `src/ingest.mjs` | Matches each history to the supplier's quality-at-pack record on the pallet SSCC. A receiver's arrival check is not quality at pack: it describes what arrived, which is what an estimate is later compared against. |
| Estimate | `src/estimator.mjs` | Calls whichever model you supply. |
| Signal | `src/signal.mjs` | Returns only the fields the asking role may see. |

A pallet with readings but no quality record is **reported, not dropped**. A silent drop looks exactly like a pallet that never shipped.

## The estimator interface

An estimator is any object of this shape. The pipeline never looks inside one, so your model can be anything: a lookup table, a kinetics model, a trained model behind an API call.

```js
{
  name: 'my-model',          // non-empty string
  version: '1.0.0',          // non-empty string
  estimate(input) { ... }    // returns an Estimate
}
```

`checkEstimator(candidate)` returns a list of what is missing, as strings, and an empty list when the model conforms. The pipeline calls it and refuses to run with the reasons rather than failing part way through.

**Input**

```js
{
  palletId: 'urn:epc:id:sscc:0614141.1000000001',
  qualityAtPack: { acceptable: true, ripenessStage: 3, inspectedAt: '2026-09-14T06:30:00Z', temperatureC: 1.5 },
  temperatures: [ { at: '2026-09-14T08:00:00Z', celsius: 1.8 } ],   // time order
  asOf: '2026-09-15T08:00:00Z',
  options: { /* whatever your model needs; passed through untouched */ }
}
```

**Output**

```js
{
  remainingDays: 8.84,
  confidenceDays: [8.3, 9.4],     // must contain remainingDays
  consumedDays: 1.16,
  band: 'fresh',                  // one of fresh, use-soon, use-now, expired
  basis: 'what produced this number, in words'
}
```

`basis` is required and carries weight: a number with no stated basis cannot be judged by the person it reaches.

## The example model

`exampleModel` is **illustrative and not validated**. Nothing in it is fitted to data and it contains no partner's model. It exists so the pipeline can run end to end and so the interface has a worked example to copy.

It encodes one openly documented rule: ageing roughly doubles for every 10 °C (18 °F) rise, so a shelf-life budget is consumed faster when the journey is warm. It integrates that rate across the recorded temperatures and subtracts the result from a starting budget.

**It will not invent a shelf life.** `baselineDays` and `referenceC` have no defaults and the model throws without them:

```
baselineDays is required: the shelf life at the reference temperature,
which only the owner of the commodity can supply
```

That is deliberate. A reference implementation that shipped a default shelf life would be inventing a domain fact, and every reader would inherit it without noticing. In the worked example those values live in `examples/synthetic/model-options.json`, beside the data they describe, labelled as illustrative.

## Roles

The Pilot 1 capture protocol states the rule: each participant owns its data and shares only the fields agreed for each role, and the distributor sees the signal and an alert flag, not the grower's commercial data.

| Role | Sees |
| --- | --- |
| `grower` | the whole record, including the quality-at-pack input and the basis |
| `distributor` | pallet, remaining days, band, alert |
| `retailer` | pallet, band, alert |

The filter is an **allow-list**. A field added to an estimate later is withheld from every role until someone decides it may be shared, which is the safe direction for a mistake to fall. A test asserts exactly that.

## Synthetic data

Everything in `examples/synthetic/` is invented and labelled `synthetic` in its file name. The identifiers use the GS1 documentation prefix. No real company, site, shipment or reading appears. Real pilot data is used only after an owner approves it through the deidentification method, and then only in its deidentified form.

## Status

In development for the SCOTF Batch 3 release (December 2026). Interfaces may change until v1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Questions: hello@scotf.org.

## License

Code: Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE); attribution is required.
Documentation: CC BY-NC 4.0 unless a file states otherwise.

Freshness Reference, contributed by TOTEM LLC.
