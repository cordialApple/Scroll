"""Two standalone, README-sized figures from the PBT-effectiveness CSVs.
    python analysis/pbt/viz/readme_figs.py
Emits sensitivity_vs_budget.png (the capability curve) and sensitivity_earned.png
(worst-class detection at 10 cases as the harness is weakened).
"""
import csv
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
def rd(n):
    with open(DATA / n, newline="", encoding="utf-8") as f: return list(csv.DictReader(f))

INK="#111318"; MUT="#6b6e76"; BORDER="#d9dde2"; GOOD="#0f9d0f"; WARN="#d98a1f"
CLS={"exec-order-linkage":"#2a78d6","index-off-by-one":"#008300","boundary-comparator":"#e87ba4",
     "dropped-term":"#eda100","split-rank-boundary":"#1baf7a"}
CLABEL={"exec-order-linkage":"Execution order / linkage","index-off-by-one":"Index off-by-one",
        "boundary-comparator":"Boundary comparator","dropped-term":"Dropped height term",
        "split-rank-boundary":"Split / merge rank"}
ORDER=list(CLS)
plt.rcParams.update({"font.family":"DejaVu Sans","savefig.dpi":150,"axes.titleweight":"bold"})

cd=rd("fact_class_detection.csv"); ab=rd("fact_ablation.csv")
budgets=sorted({int(r["budget"]) for r in cd})

# ---- figure 1: sensitivity curve ----
fig,ax=plt.subplots(figsize=(8.6,4.9)); fig.patch.set_facecolor("white")
for c in ORDER:
    d=sorted([r for r in cd if r["fault_class"]==c],key=lambda r:int(r["budget"]))
    ax.plot([int(r["budget"]) for r in d],[float(r["detection_rate"])*100 for r in d],
            marker="o",ms=5,lw=2,color=CLS[c],label=CLABEL[c])
agg=sorted([r for r in cd if r["fault_class"]=="__aggregate__"],key=lambda r:int(r["budget"]))
ax.plot([int(r["budget"]) for r in agg],[float(r["detection_rate"])*100 for r in agg],
        marker="o",ms=6,lw=3,color=INK,label="All 20 (mean)",zorder=5)
ax.set_xscale("log"); ax.set_xticks(budgets); ax.set_xticklabels(budgets,fontsize=9)
ax.set_ylim(0,105); ax.set_xlabel("case budget (numRuns, log scale)",fontsize=10.5)
ax.set_ylabel("detection rate (%)",fontsize=10.5); ax.tick_params(labelsize=9)
ax.set_title("Injected-fault sensitivity vs. case budget",fontsize=14,color=INK,loc="left",pad=10)
ax.axhline(100,ls=":",lw=1,color=MUT); ax.grid(True,color="#eef0f2",lw=0.8)
ax.legend(frameon=False,fontsize=8.5,loc="lower right",ncol=2)
for s in ax.spines.values(): s.set_color(BORDER)
fig.tight_layout(); fig.savefig(HERE/"sensitivity_vs_budget.png",facecolor="white"); plt.close(fig)

# ---- figure 2: sensitivity is earned ----
ab_order=["full","no-boundary","short-ops","const-weight"]
ab_short={"full":"Strong oracle + generator","no-boundary":"Drop exact-boundary probes",
          "short-ops":"Shorten op sequences (≤2)","const-weight":"Equalize all heights"}
worst=[]
for k in ab_order:
    rows=[r for r in ab if r["config_key"]==k and int(r["budget"])==10]
    lo=min(rows,key=lambda r:float(r["detection_rate"]))
    worst.append((ab_short[k],float(lo["detection_rate"])*100,lo["fault_class_label"]))
fig,ax=plt.subplots(figsize=(8.6,4.0)); fig.patch.set_facecolor("white")
cols=[GOOD if w[1]>=100 else WARN for w in worst]
ax.barh([w[0] for w in worst],[w[1] for w in worst],color=cols,edgecolor="white")
ax.invert_yaxis()
for i,w in enumerate(worst):
    lab=f"{w[1]:.0f}%" if w[1]>=100 else f"{w[1]:.0f}%   ({w[2]})"
    ax.text(min(w[1]+1.5,101),i,lab,va="center",fontsize=9,color=MUT)
ax.set_xlim(0,150); ax.set_xlabel("worst-class detection @ 10 cases (%)",fontsize=10.5); ax.tick_params(labelsize=9.5)
ax.set_title("Sensitivity is earned, not free",fontsize=14,color=INK,loc="left",pad=10)
ax.axvline(100,ls=":",lw=1,color=MUT); ax.grid(True,axis="x",color="#eef0f2",lw=0.8)
for s in ax.spines.values(): s.set_color(BORDER)
fig.tight_layout(); fig.savefig(HERE/"sensitivity_earned.png",facecolor="white"); plt.close(fig)
print("wrote sensitivity_vs_budget.png + sensitivity_earned.png")
