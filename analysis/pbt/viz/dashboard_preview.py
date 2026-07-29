"""Compose a dashboard-preview PNG that mirrors the PBIP report page, on the same data.
Not a Power BI render — a faithful mockup so the layout/story can be seen without Desktop.
    python analysis/pbt/viz/dashboard_preview.py
"""
import csv, math
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec
from matplotlib.patches import FancyBboxPatch

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
def rd(n):
    with open(DATA / n, newline="", encoding="utf-8") as f: return list(csv.DictReader(f))

PAGE="#eef0f2"; PANEL="#ffffff"; INK="#111318"; MUT="#6b6e76"; BORDER="#d9dde2"
ACC="#2a78d6"; GOOD="#0f9d0f"; WARN="#d98a1f"
CLS={"index-off-by-one":"#008300","boundary-comparator":"#e87ba4","dropped-term":"#eda100",
     "exec-order-linkage":"#2a78d6","split-rank-boundary":"#1baf7a"}
CLABEL={"index-off-by-one":"Index off-by-one","boundary-comparator":"Boundary comparator",
        "dropped-term":"Dropped height term","exec-order-linkage":"Execution order / linkage",
        "split-rank-boundary":"Split / merge rank"}
ORDER=["exec-order-linkage","index-off-by-one","boundary-comparator","dropped-term","split-rank-boundary"]

cd=rd("fact_class_detection.csv"); ab=rd("fact_ablation.csv"); sm=rd("fact_stryker_module.csv")
budgets=sorted({int(r["budget"]) for r in cd})

plt.rcParams.update({"font.family":"DejaVu Sans","savefig.dpi":150})
fig=plt.figure(figsize=(14.2,9.0)); fig.patch.set_facecolor(PAGE)
gs=GridSpec(4,5,figure=fig,height_ratios=[0.5,0.62,1.5,1.15],hspace=0.42,wspace=0.34,
            left=0.035,right=0.975,top=0.965,bottom=0.055)

# ---- title band ----
axt=fig.add_subplot(gs[0,:]); axt.axis("off")
axt.text(0,0.62,"Property-based testing: sensitivity vs. realized yield",fontsize=23,fontweight="bold",color=INK,va="center")
axt.text(0,0.05,"Scroll · TreapOrderIndex. What PBT could catch (measured) vs. what it did catch (≈1), and why git can't say more",
         fontsize=11.5,color=MUT,va="center")

def card(ax,big,label,sub,color=INK):
    ax.axis("off")
    ax.add_patch(FancyBboxPatch((0.02,0.06),0.96,0.9,boxstyle="round,pad=0.02,rounding_size=0.05",
                mutation_aspect=0.5,fc=PANEL,ec=BORDER,lw=1.2,transform=ax.transAxes))
    ax.text(0.5,0.66,big,fontsize=27,fontweight="bold",color=color,ha="center",va="center")
    ax.text(0.5,0.34,label,fontsize=10.3,color=INK,ha="center",va="center",wrap=True)
    ax.text(0.5,0.15,sub,fontsize=8.6,color=MUT,ha="center",va="center")

cards=[("≈1","realized corrective catch","a >/>= off-by-one; units passed",WARN),
       ("~100%","injected-fault sensitivity","by 10 cases; self-designed oracle",INK),
       ("+225","lines of risky rewrite guarded","O(log n) treap, differential oracle",ACC),
       ("86% · 95%","Stryker kill: treap, layout","mechanical, PBT-only",ACC),
       ("0","broken states left in git","squash-merge + in-loop fixes erased",MUT)]
for i,c in enumerate(cards):
    card(fig.add_subplot(gs[1,i]),*c)

# ---- line chart ----
axl=fig.add_subplot(gs[2,0:3]); axl.set_facecolor(PANEL)
for c in ORDER:
    d=sorted([r for r in cd if r["fault_class"]==c],key=lambda r:int(r["budget"]))
    axl.plot([int(r["budget"]) for r in d],[float(r["detection_rate"])*100 for r in d],
             marker="o",ms=5,lw=2,color=CLS[c],label=CLABEL[c])
agg=sorted([r for r in cd if r["fault_class"]=="__aggregate__"],key=lambda r:int(r["budget"]))
axl.plot([int(r["budget"]) for r in agg],[float(r["detection_rate"])*100 for r in agg],
         marker="o",ms=6,lw=3,color=INK,label="All 20 (mean)",zorder=5)
axl.set_xscale("log"); axl.set_xticks(budgets); axl.set_xticklabels(budgets,fontsize=9)
axl.set_ylim(0,105); axl.set_xlabel("case budget (numRuns, log)",fontsize=10)
axl.set_ylabel("detection %",fontsize=10); axl.tick_params(labelsize=9)
axl.set_title("Injected-fault sensitivity vs. case budget  (capability, not realized catches)",fontsize=11.5,fontweight="bold",loc="left",color=INK,pad=8)
axl.axhline(100,ls=":",lw=1,color=MUT); axl.grid(True,color="#eef0f2",lw=0.8)
axl.legend(frameon=False,fontsize=8,loc="center",ncol=2)
for s in axl.spines.values(): s.set_color(BORDER)

# ---- ablation: sensitivity is earned ----
axa=fig.add_subplot(gs[2,3:5]); axa.set_facecolor(PANEL)
ab_order=["full","no-boundary","short-ops","const-weight"]
ab_short={"full":"Strong oracle + generator","no-boundary":"Drop exact-boundary probes",
          "short-ops":"Shorten op sequences (≤2)","const-weight":"Equalize all heights"}
worst=[]
for k in ab_order:
    rows=[r for r in ab if r["config_key"]==k and int(r["budget"])==10]
    lo=min(rows,key=lambda r:float(r["detection_rate"]))
    worst.append((ab_short[k],float(lo["detection_rate"])*100,lo["fault_class_label"]))
cols=[GOOD if w[1]>=100 else WARN for w in worst]
axa.barh([w[0] for w in worst],[w[1] for w in worst],color=cols,edgecolor="white")
axa.invert_yaxis()
for i,w in enumerate(worst):
    lab=f'{w[1]:.0f}%' if w[1]>=100 else f'{w[1]:.0f}%  ({w[2]})'
    axa.text(min(w[1]+1.5,101),i,lab,va="center",fontsize=8,color=MUT)
axa.set_xlim(0,150); axa.set_xlabel("worst-class detection @ 10 cases (%)",fontsize=9.5); axa.tick_params(labelsize=8.5)
axa.set_title("Sensitivity is earned, not free",fontsize=12.5,fontweight="bold",loc="left",color=INK,pad=8)
axa.axvline(100,ls=":",lw=1,color=MUT)
for s in axa.spines.values(): s.set_color(BORDER)
axa.grid(True,axis="x",color="#eef0f2",lw=0.8)

# ---- stryker bars ----
axb=fig.add_subplot(gs[3,0:3]); axb.set_facecolor(PANEL)
rows=sorted(sm,key=lambda r:int(r["covered_score"]))
y=range(len(rows))
cols=[ACC if int(r["covered_score"])>=80 else WARN if int(r["covered_score"])>=60 else "#9a9a95" for r in rows]
axb.barh([r["module"] for r in rows],[int(r["covered_score"]) for r in rows],color=cols,edgecolor="white")
for i,r in enumerate(rows):
    axb.text(int(r["covered_score"])+1.5,i,f'{r["covered_score"]}%  ({r["mutants"]}m)',va="center",fontsize=8,color=MUT)
axb.set_xlim(0,116); axb.set_xlabel("kill rate on covered code (%)",fontsize=10); axb.tick_params(labelsize=8.5)
axb.set_title("StrykerJS kill rate by module — PBT only",fontsize=12.5,fontweight="bold",loc="left",color=INK,pad=8)
axb.annotate("model.ts low = 294 mutants in untested\nimage/tabs code (coverage artifact, not a miss)",
             xy=(43,0),xytext=(62,0.35),fontsize=7.6,color=MUT,va="center",
             arrowprops=dict(arrowstyle="->",color=MUT,lw=0.8))
for s in axb.spines.values(): s.set_color(BORDER)
axb.grid(True,axis="x",color="#eef0f2",lw=0.8)

# ---- ledger panel ----
axp=fig.add_subplot(gs[3,3:5]); axp.axis("off")
axp.add_patch(FancyBboxPatch((0.02,0.04),0.96,0.92,boxstyle="round,pad=0.02,rounding_size=0.04",
              mutation_aspect=0.35,fc=PANEL,ec=BORDER,lw=1.2,transform=axp.transAxes))
axp.text(0.06,0.89,"Why realized yield is ≈1, and unrecoverable",fontsize=12,fontweight="bold",color=INK,transform=axp.transAxes)
lines=[("0","broken intermediate states in git; squash-merge collapsed each PR to 1 commit"),
       ("in-loop","an agent fixed defects mid-dev, before commit; the causal signal never reached git"),
       ("1","organic catch survived, only because a transcript logged it (a >/>= off-by-one)"),
       ("0","committed regression fixtures; designed (§4.3), never built"),
       ("152 → 0","CI runs to PBT-red on a logic bug (1 red = Postgres pool flake)")]
yy=0.74
for n,t in lines:
    axp.text(0.06,yy,n,fontsize=10.5,fontweight="bold",color=ACC,transform=axp.transAxes,va="center")
    axp.text(0.34,yy,t,fontsize=7.5,color=INK,transform=axp.transAxes,va="center")
    yy-=0.128
axp.text(0.06,0.03,"Small because defects were rare and the record is lossy, not because PBT was blind.\nSensitivity ~100%; the +225-line treap rewrite shipped fearless. n=1 is a floor, not a ceiling.",
         fontsize=7.2,color=MUT,style="italic",transform=axp.transAxes,va="bottom")

fig.savefig(HERE/"dashboard_preview.png",facecolor=PAGE,bbox_inches="tight")
print("wrote",HERE/"dashboard_preview.png")
