"""Generate a version-controllable Power BI Project (PBIP) from the PBT-effectiveness CSVs.

Emits a self-contained PBIP under ../powerbi/PBTEffectiveness.* :
  - SemanticModel: TMDL with data INLINED as M #table (no external CSV path — diffs cleanly)
  - Report: PBIR (report.json + one page + visuals)
Deterministic GUIDs so re-runs produce stable diffs. Run from repo root:
    python analysis/pbt/viz/build_pbip.py
"""
import csv
from pathlib import Path

HERE = Path(__file__).resolve().parent
PBT = HERE.parent
DATA = PBT / "data"
OUT = PBT / "powerbi"
NAME = "PBTEffectiveness"
SM = OUT / f"{NAME}.SemanticModel"
RP = OUT / f"{NAME}.Report"
TAB = "\t"

for p in [OUT, SM, SM / "definition" / "tables", RP, RP / "definition" / "pages" / "page1" / "visuals"]:
    p.mkdir(parents=True, exist_ok=True)

def rd(name):
    with open(DATA / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))

# column type hints: name -> (tmdl dataType, m type, is_numeric)
INT, DBL, STR = "int64", "double", "string"
TYPES = {
    "budget": INT, "log10": DBL, "order_of_magnitude": INT, "detection_rate": DBL,
    "first_full_budget": INT, "covered_score": INT, "total_score": INT, "killed": INT,
    "timeout": INT, "survived": INT, "nocov": INT, "mutants": INT, "detected": INT,
    "value": INT, "line": INT,
}
MTYPE = {INT: "Int64.Type", DBL: "number", STR: "text"}

def col_type(c):
    return TYPES.get(c, STR)

def m_value(v, t):
    if v is None or v == "":
        return "null"
    if t == INT:
        return str(int(float(v)))
    if t == DBL:
        return repr(round(float(v), 6))
    return '"' + str(v).replace('"', '""') + '"'

def table_tmdl(table, rows, measures=None, hidden_cols=()):
    cols = list(rows[0].keys())
    lines = [f"table {table}", ""]
    if measures:
        for mname, expr, fmt in measures:
            lines.append(f"{TAB}measure '{mname}' = {expr}")
            if fmt:
                lines.append(f"{TAB}{TAB}formatString: {fmt}")
            lines.append("")
    for c in cols:
        t = col_type(c)
        lines.append(f"{TAB}column {c}")
        lines.append(f"{TAB}{TAB}dataType: {t}")
        if t in (INT, DBL):
            lines.append(f"{TAB}{TAB}summarizeBy: none")
        lines.append(f"{TAB}{TAB}sourceColumn: {c}")
        if c in hidden_cols:
            lines.append(f"{TAB}{TAB}isHidden")
        lines.append("")
    # inline M #table partition
    mtypes = ", ".join(f"{c} = {MTYPE[col_type(c)]}" for c in cols)
    row_strs = []
    for r in rows:
        vals = ", ".join(m_value(r[c], col_type(c)) for c in cols)
        row_strs.append(f"{TAB}{TAB}{TAB}{TAB}{TAB}{{ {vals} }}")
    rows_block = ",\n".join(row_strs)
    lines += [
        f"{TAB}partition {table} = m",
        f"{TAB}{TAB}mode: import",
        f"{TAB}{TAB}source =",
        f"{TAB}{TAB}{TAB}let",
        f"{TAB}{TAB}{TAB}{TAB}Source = #table(",
        f"{TAB}{TAB}{TAB}{TAB}{TAB}type table [{mtypes}],",
        f"{TAB}{TAB}{TAB}{TAB}{TAB}{{",
        rows_block,
        f"{TAB}{TAB}{TAB}{TAB}{TAB}}}",
        f"{TAB}{TAB}{TAB}{TAB})",
        f"{TAB}{TAB}{TAB}in",
        f"{TAB}{TAB}{TAB}{TAB}Source",
        "",
    ]
    (SM / "definition" / "tables" / f"{table}.tmdl").write_text("\n".join(lines), encoding="utf-8")
    return cols

# ---- tables ----
measures_cd = [
    ("Detection Rate", "AVERAGE(fact_class_detection[detection_rate])", "0%"),
]
measures_fd = [
    ("Mutant Detection", "AVERAGE(fact_detection[detection_rate])", "0%"),
    ("Mutants Caught", "DISTINCTCOUNT(fact_detection[mutant_id])", "0"),
]
measures_ab = [("Ablation Detection", "AVERAGE(fact_ablation[detection_rate])", "0%")]
measures_st = [
    ("Covered Kill Rate", "AVERAGE(fact_stryker_module[covered_score])", "0"),
    ("Total Mutants", "SUM(fact_stryker_module[mutants])", "#,0"),
]

table_tmdl("dim_budget", rd("dim_budget.csv"))
table_tmdl("dim_class", rd("dim_class.csv"))
table_tmdl("dim_mutant", rd("dim_mutant.csv"))
table_tmdl("fact_class_detection", rd("fact_class_detection.csv"), measures=measures_cd)
table_tmdl("fact_detection", rd("fact_detection.csv"), measures=measures_fd)
table_tmdl("fact_ablation", rd("fact_ablation.csv"), measures=measures_ab)
table_tmdl("fact_stryker_module", rd("fact_stryker_module.csv"), measures=measures_st)
table_tmdl("fact_ledger", rd("fact_ledger.csv"))

# ---- model.tmdl ----
tbls = ["dim_budget", "dim_class", "dim_mutant", "fact_class_detection", "fact_detection",
        "fact_ablation", "fact_stryker_module", "fact_ledger"]
model = [
    "model Model",
    f"{TAB}culture: en-US",
    f"{TAB}defaultPowerBIDataSourceVersion: powerBI_V3",
    f"{TAB}discourageImplicitMeasures",
    f"{TAB}sourceQueryCulture: en-US",
    "",
] + [f"{TAB}ref table {t}" for t in tbls] + [
    "",
    f"{TAB}ref cultureInfo en-US",
    "",
]
(SM / "definition" / "model.tmdl").write_text("\n".join(model), encoding="utf-8")

# ---- database.tmdl ----
(SM / "definition" / "database.tmdl").write_text(
    "database\n\tcompatibilityLevel: 1567\n", encoding="utf-8")

# ---- relationships.tmdl (deterministic GUIDs) ----
rels = [
    ("f1000000-0000-0000-0000-000000000001", "fact_detection.mutant_id", "dim_mutant.mutant_id"),
    ("f1000000-0000-0000-0000-000000000002", "fact_detection.budget", "dim_budget.budget"),
    ("f1000000-0000-0000-0000-000000000003", "dim_mutant.fault_class", "dim_class.fault_class"),
    ("f1000000-0000-0000-0000-000000000004", "fact_class_detection.budget", "dim_budget.budget"),
    ("f1000000-0000-0000-0000-000000000005", "fact_ablation.budget", "dim_budget.budget"),
    ("f1000000-0000-0000-0000-000000000006", "fact_ablation.fault_class", "dim_class.fault_class"),
]
rl = []
for gid, frm, to in rels:
    rl += [f"relationship {gid}", f"{TAB}fromColumn: {frm}", f"{TAB}toColumn: {to}", ""]
(SM / "definition" / "relationships.tmdl").write_text("\n".join(rl), encoding="utf-8")

# ---- cultureInfo (needed by some engines; keep minimal) ----
(SM / "definition").joinpath("cultures").mkdir(exist_ok=True)
(SM / "definition" / "cultures" / "en-US.tmdl").write_text(
    "cultureInfo en-US\n", encoding="utf-8")

# ---- SemanticModel platform + pbism ----
def platform(item_type, disp, logical):
    return ('{\n'
            '  "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",\n'
            f'  "metadata": {{ "type": "{item_type}", "displayName": "{disp}" }},\n'
            f'  "config": {{ "version": "2.0", "logicalId": "{logical}" }}\n'
            '}\n')
(SM / ".platform").write_text(platform("SemanticModel", NAME, "a1000000-0000-0000-0000-0000000000aa"), encoding="utf-8")
(SM / "definition.pbism").write_text(
    '{\n'
    '  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",\n'
    '  "version": "4.0",\n'
    '  "settings": {}\n'
    '}\n', encoding="utf-8")

# ---- Report .platform / .pbir ----
(RP / ".platform").write_text(platform("Report", NAME, "b2000000-0000-0000-0000-0000000000bb"), encoding="utf-8")
(RP / "definition.pbir").write_text(
    '{\n'
    '  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",\n'
    '  "version": "4.0",\n'
    f'  "datasetReference": {{ "byPath": {{ "path": "../{NAME}.SemanticModel" }} }}\n'
    '}\n', encoding="utf-8")

# ---- Report definition (PBIR) ----
import json
(RP / "definition" / "report.json").write_text(json.dumps({
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/1.0.0/schema.json",
    "themeCollection": {"baseTheme": {"name": "CY24SU06", "reportVersionAtImport": "5.55", "type": "SharedResources"}},
    "layoutOptimization": "None",
}, indent=2), encoding="utf-8")
(RP / "definition" / "version.json").write_text(json.dumps({
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json",
    "version": "1.0.0",
}, indent=2), encoding="utf-8")
(RP / "definition" / "pages" / "pages.json").write_text(json.dumps({
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json",
    "pageOrder": ["page1"], "activePageName": "page1",
}, indent=2), encoding="utf-8")
(RP / "definition" / "pages" / "page1" / "page.json").write_text(json.dumps({
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json",
    "name": "page1", "displayName": "PBT effectiveness", "displayOption": "FitToPage",
    "height": 720, "width": 1280,
}, indent=2), encoding="utf-8")

def col_field(entity, prop, ref=None):
    return {"field": {"Column": {"Expression": {"SourceRef": {"Entity": entity}}, "Property": prop}},
            "queryRef": ref or f"{entity}.{prop}"}
def meas_field(entity, prop, ref=None):
    return {"field": {"Measure": {"Expression": {"SourceRef": {"Entity": entity}}, "Property": prop}},
            "queryRef": ref or f"{entity}.{prop}"}

def visual(name, x, y, w, h, vtype, states, title):
    return {
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.0.0/schema.json",
        "name": name,
        "position": {"x": x, "y": y, "z": 0, "width": w, "height": h, "tabOrder": 0},
        "visual": {
            "visualType": vtype,
            "query": {"queryState": states, "sortDefinition": {"sort": [], "isDefaultSort": True}},
            "objects": {"title": [{"properties": {"text": {"expr": {"Literal": {"Value": f"'{title}'"}}},
                                                  "show": {"expr": {"Literal": {"Value": "true"}}}}}]},
            "drillFilterOtherVisuals": True,
        },
    }

visuals = [
    visual("v_line", 16, 88, 760, 400, "lineChart", {
        "Category": {"projections": [col_field("dim_budget", "budget")]},
        "Y": {"projections": [meas_field("fact_class_detection", "Detection Rate")]},
        "Series": {"projections": [col_field("dim_class", "label")]},
    }, "Injected-fault sensitivity vs. case budget"),
    visual("v_bars", 792, 88, 472, 400, "barChart", {
        "Category": {"projections": [col_field("fact_stryker_module", "module")]},
        "Y": {"projections": [meas_field("fact_stryker_module", "Covered Kill Rate")]},
    }, "StrykerJS kill rate by module (PBT only)"),
    visual("v_card", 792, 504, 232, 200, "card", {
        "Values": {"projections": [meas_field("fact_detection", "Mutants Caught")]},
    }, "Mutants caught"),
    visual("v_card2", 1032, 504, 232, 200, "card", {
        "Values": {"projections": [meas_field("fact_stryker_module", "Total Mutants")]},
    }, "Mechanical mutants"),
]
for v in visuals:
    d = RP / "definition" / "pages" / "page1" / "visuals" / v["name"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "visual.json").write_text(json.dumps(v, indent=2), encoding="utf-8")

# ---- root .pbip ----
(OUT / f"{NAME}.pbip").write_text(json.dumps({
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json",
    "version": "1.0",
    "artifacts": [{"report": {"path": f"{NAME}.Report"}}],
    "settings": {"enableAutoRecovery": True},
}, indent=2), encoding="utf-8")

# ---- validate all JSON parses ----
bad = []
for p in OUT.rglob("*"):
    if p.suffix in (".json", ".pbip", ".pbir", ".pbism", ".platform"):
        try:
            json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            bad.append((p.name, str(e)))
print("PBIP ->", OUT)
print("files:", sum(1 for _ in OUT.rglob("*") if _.is_file()))
print("JSON validation:", "ALL OK" if not bad else bad)
