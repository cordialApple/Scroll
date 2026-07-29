# PBT effectiveness study

Retrospective measurement of what property-based testing (fast-check) bought Scroll, run on `TreapOrderIndex` (`src/layout/orderIndex.ts`), the first stateful component built under PBT. The narrative write-up is in the repo root `README.md`, section "Property-based testing: a retrospective".

## Thesis

Two questions, two answers:

- **Sensitivity** (could PBT catch faults?): ~100% by 10 cases, and earned by oracle and generator design, not luck. The ablations show worst-class detection dropping to 80% when the harness is weakened.
- **Realized yield** (did it fix real wrong code?): about one. It is unrecoverable from git because squash-merge plus in-loop defect fixing erased the broken intermediate states before they reached version control. That loss is the finding, not a hedge.

## Layout

- `harness/sweep.mjs` — 20 mutants across 5 fault classes, budgets 1 to 3000, 10 seeds each. In-process esbuild transform plus dynamic import; mutated SUT compared against a pristine array/Fenwick oracle.
- `harness/ablation.mjs` — 4 harness configs (strong, no-boundary, const-weight, short-ops) over budgets [10, 100, 1000], 5 seeds each.
- `config/` — PBT-only StrykerJS and vitest configs (exclude provider chaos).
- `results/` — raw `sweep.json` and `ablation.json`.
- `data/` — star-schema CSVs (dimensions and facts) feeding the figure and the Power BI model.
- `viz/make_analytics.py` — regenerates the CSVs and standalone charts. `viz/dashboard_preview.py` — the composite figure embedded in the repo README.
- `powerbi/` — version-controlled Power BI project (PBIP) over the same star schema.

## Reproduce

```
node analysis/pbt/harness/sweep.mjs
node analysis/pbt/harness/ablation.mjs
python analysis/pbt/viz/make_analytics.py
python analysis/pbt/viz/dashboard_preview.py
```

## Limitations

The sweep measures sensitivity, not realized bugs: the mutants and the oracle are ours, so it is a capability measure by construction. Realized yield cannot be reconstructed from version control here. A project that wants that number should log every property-test failure at the moment it fires.
