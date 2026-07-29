"""Build the PBT-effectiveness star schema (CSV) + seaborn dashboard PNGs.

Reads the raw experiment JSON under ../results and ../../../test-results/stryker-pbt,
emits tidy CSVs to ../data and charts to . (this viz dir). Run from repo root:
    python analysis/pbt/viz/make_analytics.py
"""
import json
import os
from pathlib import Path

import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

HERE = Path(__file__).resolve().parent
PBT = HERE.parent
DATA = PBT / "data"
RESULTS = PBT / "results"
STRYKER = PBT.parent.parent / "test-results" / "stryker-pbt"
DATA.mkdir(exist_ok=True)

# ---- static metadata (from the harness MUTANTS array) ----
CLASS_LABEL = {
    "index-off-by-one": "Index off-by-one",
    "boundary-comparator": "Boundary comparator",
    "dropped-term": "Dropped height term",
    "exec-order-linkage": "Execution order / linkage",
    "split-rank-boundary": "Split / merge rank",
}
CLASS_COLOR = {
    "index-off-by-one": "#008300",
    "boundary-comparator": "#e87ba4",
    "dropped-term": "#eda100",
    "exec-order-linkage": "#2a78d6",
    "split-rank-boundary": "#1baf7a",
}
MUT_DESC = {
    "A1": "tpull size: drop +1", "A2": "indexOf rank: drop +1", "A3": "idAt: k-=ls (drop +1)",
    "A4": "prefixHeight: need-=ls (drop +1)", "B1": "findByOffset: <= -> <", "B2": "tsplit: k<=ls -> <",
    "B3": "prefixHeight: need<=ls -> <", "B4": "idAt: k<ls -> <=", "C1": "tpull sumH: drop n.height",
    "C2": "prefixHeight acc: drop n.height", "C3": "findByOffset: drop n.height", "C4": "setHeight repair: drop height",
    "D1": "tmerge(a,b.left) -> (b.left,a)", "D2": "tmerge(a.right,b) -> (b,a.right)",
    "D3": "insertAfter merge order swap", "D4": "tpull: right.parent = null",
    "E1": "tsplit right: k-ls-1 -> k-ls", "E2": "remove: tsplit(rest,1) -> 0",
    "E3": "findByOffset pos: drop +1", "E4": "insertAfter split: at -> at-1",
}
# StrykerJS per-module summary (PBT-only run)
STRYKER_MODULES = [
    # module, covered%, total%, killed, timeout, survived, nocov, n
    ("layout.ts", 96, 95, 110, 12, 5, 2, 129),
    ("orderIndex.ts", 87, 86, 221, 20, 37, 3, 281),
    ("guardTracker.ts", 86, 86, 6, 0, 1, 0, 7),
    ("docModel.ts", 84, 72, 78, 1, 15, 15, 109),
    ("spatialGuard.ts", 92, 78, 44, 2, 4, 9, 59),
    ("observer.ts", 67, 67, 4, 0, 2, 0, 6),
    ("anchor.ts", 67, 50, 6, 0, 3, 3, 12),
    ("model.ts", 43, 13, 57, 0, 75, 294, 426),
]
LEDGER = [
    ("committed_regression_fixtures", 0, "the counterexample ledger (plan §4.3) was designed but never built"),
    ("commit_msgs_attributing_pbt", 0, "no commit attributes a fix to a property-test failure"),
    ("ci_runs_examined", 152, "GitHub Actions runs mined"),
    ("ci_runs_pbt_red", 0, "PBT tests never red on a logic bug; the 1 red run was a Postgres pool flake"),
    ("dev_transcripts_mined", 188, "local Claude Code session JSONL files searched"),
    ("organic_pbt_catches", 1, "a > vs >= boundary off-by-one unit tests passed; reproduced as mutant B1"),
    ("sabotage_teeth_sessions", 7, "sabotage-then-revert gate confirmations found (validated test sensitivity)"),
    ("curated_faults_caught", 20, "of 20 hand-built treap mutants, all detected by >=10 cases"),
]

# ---- load experiment results ----
sweep = json.loads((RESULTS / "sweep.json").read_text())
ablation = json.loads((RESULTS / "ablation.json").read_text())
budgets = [int(b) for b in sweep["budgets"]]

# ---- fact_detection: mutant x budget ----
rows = []
for m in sweep["mutants"]:
    for b in budgets:
        rows.append(dict(mutant_id=m["id"], fault_class=m["cls"], budget=b,
                         detection_rate=m["perBudget"][str(b)]))
fact_detection = pd.DataFrame(rows)
fact_detection.to_csv(DATA / "fact_detection.csv", index=False)

# ---- dim_mutant ----
dim_mutant = pd.DataFrame([
    dict(mutant_id=m["id"], fault_class=m["cls"], fault_class_label=CLASS_LABEL[m["cls"]],
         mutation=MUT_DESC.get(m["id"], ""), first_full_budget=m["firstFullDetectBudget"])
    for m in sweep["mutants"]])
dim_mutant.to_csv(DATA / "dim_mutant.csv", index=False)

# ---- dim_class ----
dim_class = pd.DataFrame([dict(fault_class=k, label=v, color=CLASS_COLOR[k]) for k, v in CLASS_LABEL.items()])
dim_class.to_csv(DATA / "dim_class.csv", index=False)

# ---- dim_budget ----
import math
dim_budget = pd.DataFrame([dict(budget=b, log10=round(math.log10(b), 4), order_of_magnitude=int(math.log10(b))) for b in budgets])
dim_budget.to_csv(DATA / "dim_budget.csv", index=False)

# ---- fact_class_detection ----
rows = []
for cls, per in sweep["byClass"].items():
    for b in budgets:
        rows.append(dict(fault_class=cls, fault_class_label=CLASS_LABEL[cls], budget=b, detection_rate=per[str(b)]))
for b in budgets:
    rows.append(dict(fault_class="__aggregate__", fault_class_label="All 20 mutants (mean)", budget=b,
                     detection_rate=sweep["aggregate"][str(b)]))
fact_class_detection = pd.DataFrame(rows)
fact_class_detection.to_csv(DATA / "fact_class_detection.csv", index=False)

# ---- fact_ablation ----
rows = []
abl_budgets = [int(b) for b in ablation["budgets"]]
for cfg in ablation["configs"]:
    for cls, per in cfg["byClass"].items():
        for b in abl_budgets:
            rows.append(dict(config_key=cfg["key"], config_label=cfg["label"], fault_class=cls,
                             fault_class_label=CLASS_LABEL[cls], budget=b, detection_rate=per[str(b)]))
fact_ablation = pd.DataFrame(rows)
fact_ablation.to_csv(DATA / "fact_ablation.csv", index=False)

# ---- fact_stryker_module ----
fact_stryker = pd.DataFrame([
    dict(module=m, covered_score=c, total_score=t, killed=k, timeout=to, survived=s, nocov=nc, mutants=n,
         detected=k + to)
    for (m, c, t, k, to, s, nc, n) in STRYKER_MODULES])
fact_stryker.to_csv(DATA / "fact_stryker_module.csv", index=False)

# ---- fact_ledger ----
pd.DataFrame([dict(metric=k, value=v, note=n) for (k, v, n) in LEDGER]).to_csv(DATA / "fact_ledger.csv", index=False)

print("CSVs ->", DATA)

# ================= CHARTS =================
sns.set_theme(style="whitegrid", context="talk", font_scale=0.8)
plt.rcParams.update({"figure.dpi": 140, "savefig.dpi": 140, "axes.edgecolor": "#c3c2b7",
                     "axes.linewidth": 0.8, "grid.color": "#e8e7e1", "font.family": "DejaVu Sans",
                     "axes.titleweight": "bold", "axes.titlepad": 12})
ACCENT = "#0b0b0b"
ORDER = ["exec-order-linkage", "index-off-by-one", "boundary-comparator", "dropped-term", "split-rank-boundary"]
pal = {CLASS_LABEL[c]: CLASS_COLOR[c] for c in ORDER}

# 1) detection vs budget (the hero)
fig, ax = plt.subplots(figsize=(9, 5.4))
for c in ORDER:
    d = fact_class_detection[fact_class_detection.fault_class == c].sort_values("budget")
    ax.plot(d.budget, d.detection_rate * 100, marker="o", ms=6, lw=2, color=CLASS_COLOR[c], label=CLASS_LABEL[c])
agg = fact_class_detection[fact_class_detection.fault_class == "__aggregate__"].sort_values("budget")
ax.plot(agg.budget, agg.detection_rate * 100, marker="o", ms=7, lw=3.2, color=ACCENT, label="All 20 (mean)", zorder=5)
ax.set_xscale("log")
ax.set_xticks(budgets); ax.set_xticklabels(budgets)
ax.set_xlabel("case budget (numRuns, log scale)"); ax.set_ylabel("detection rate (%)")
ax.set_ylim(0, 104)
ax.set_title("Injected-fault sensitivity vs. case budget (TreapOrderIndex)")
ax.axhline(100, ls=":", lw=1, color="#898781", zorder=0)
ax.legend(frameon=False, fontsize=9, loc="lower right", ncol=2)
sns.despine(ax=ax)
fig.tight_layout(); fig.savefig(HERE / "detection_vs_budget.png"); plt.close(fig)

# 2) stryker module bars
fs = fact_stryker.sort_values("covered_score", ascending=True)
fig, ax = plt.subplots(figsize=(9, 5))
colors = ["#2a78d6" if v >= 80 else "#eda100" if v >= 60 else "#898781" for v in fs.covered_score]
ax.barh(fs.module, fs.covered_score, color=colors, edgecolor="white")
for y, (v, n) in enumerate(zip(fs.covered_score, fs.mutants)):
    ax.text(v + 1.5, y, f"{v}%  ({n}m)", va="center", fontsize=9, color="#52514e")
ax.set_xlim(0, 108); ax.set_xlabel("mutation kill rate on covered code (%)")
ax.set_title("StrykerJS kill rate by module — PBT tests only")
sns.despine(ax=ax)
fig.tight_layout(); fig.savefig(HERE / "stryker_modules.png"); plt.close(fig)

# 3) ablation heatmap @ budget 10
abl10 = fact_ablation[fact_ablation.budget == 10]
piv2 = abl10.pivot(index="config_label", columns="fault_class_label", values="detection_rate")
# order configs: full first
order_cfg = [c["label"] for c in ablation["configs"]]
piv2 = piv2.reindex(order_cfg)[[CLASS_LABEL[c] for c in ORDER]]
fig, ax = plt.subplots(figsize=(9.5, 4.2))
sns.heatmap(piv2 * 100, ax=ax, cmap="Blues", vmin=0, vmax=100, annot=True, fmt=".0f",
            annot_kws={"size": 10}, cbar_kws={"label": "% detection @ 10 cases", "shrink": 0.7}, linewidths=1.5, linecolor="white")
ax.set_title("Ablations: detection @ 10 cases when the property is weakened")
ax.set_xlabel(""); ax.set_ylabel("")
plt.setp(ax.get_xticklabels(), rotation=20, ha="right", fontsize=9)
plt.setp(ax.get_yticklabels(), rotation=0, fontsize=9)
fig.tight_layout(); fig.savefig(HERE / "ablation_heatmap.png"); plt.close(fig)

print("charts ->", HERE)
print("done.")
