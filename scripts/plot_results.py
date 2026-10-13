"""Generate the README / report figures from results/*.json.

Usage:  pip install matplotlib && python scripts/plot_results.py
Output: docs/figures/gas_per_function.png, docs/figures/settlement_latency.png

Only stored measurements are plotted; nothing is estimated or extrapolated.
"""
import json
import random
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
OUT = ROOT / "docs" / "figures"

# Palette: categorical slots 1-2 (validated light-mode pair) and neutral inks.
SURFACE, INK, INK_2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
SERIES = ["#2a78d6", "#eb6834"]

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "font.size": 10, "axes.edgecolor": GRID, "axes.labelcolor": INK_2,
    "xtick.color": INK_2, "ytick.color": INK_2, "axes.titlecolor": INK,
    "axes.titlesize": 12, "axes.titleweight": "bold", "axes.titlelocation": "left",
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
})


def load(name):
    return json.loads((RESULTS / name).read_text())


def gas_per_function():
    d = load("gas_comparison.json")
    fns = ["createTransaction", "confirmDelivery", "redeemToken", "reclaimToken"]
    labels = ["create", "confirm\ndelivery", "redeem", "reclaim"]
    series = [("Current (v1)", "SettlementSystem"), ("Storage-optimised", "SettlementSystemOptimized")]

    fig, ax = plt.subplots(figsize=(7.2, 3.8), dpi=160)
    width, gap = 0.36, 0.02
    for k, (name, key) in enumerate(series):
        vals = [d["contracts"][key]["perCall"][f]["mean"] for f in fns]
        xs = [i + (k - 0.5) * (width + gap) for i in range(len(fns))]
        ax.bar(xs, vals, width=width, color=SERIES[k], label=name, zorder=2)
        for x, v in zip(xs, vals):
            ax.text(x, v + 3000, f"{v / 1000:.0f}k", ha="center", va="bottom", fontsize=8, color=INK_2)

    ax.set_xticks(range(len(fns)), labels)
    ax.set_ylabel("gas per call (mean)")
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v / 1000:.0f}k"))
    ax.grid(axis="x", visible=False)
    life = d["optimizedVsCurrent"]["lifecycleRedeem"]
    ax.set_title(f"Gas per call: lifecycle {life:+.1f}% with packed storage")
    ax.legend(frameon=False, loc="upper right")
    n = d["lifecyclesPerContract"]
    fig.text(0.01, 0.01, f"{n} lifecycles per contract, local EVM ({d['environment']['hardfork']}), "
             f"solc {d['environment']['solc']}. Source: results/gas_comparison.json",
             fontsize=7, color=INK_2)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "gas_per_function.png")
    plt.close(fig)


def settlement_latency():
    e1 = load("full_latency_results.json")["100"]["records"]
    e4 = load("besu_results.json")["100"]["records"]
    groups = [
        ("Sepolia testnet\n(Exp 1, n=%d)" % len(e1), [r["settlementLatency_s"] for r in e1]),
        ("Local chain, 2 s blocks\n(Exp 4, n=%d)" % len(e4), [r["settlementLatency_s"] for r in e4]),
    ]

    fig, ax = plt.subplots(figsize=(7.2, 3.8), dpi=160)
    rng = random.Random(0)  # fixed jitter so the figure is reproducible
    for i, (_, vals) in enumerate(groups):
        xs = [i + rng.uniform(-0.18, 0.18) for _ in vals]
        ax.scatter(xs, vals, s=14, color=SERIES[0], alpha=0.55, linewidths=0, zorder=2)
        med = sorted(vals)[len(vals) // 2] if len(vals) % 2 else sum(sorted(vals)[len(vals) // 2 - 1:len(vals) // 2 + 1]) / 2
        ax.plot([i - 0.28, i + 0.28], [med, med], color=INK, linewidth=2, zorder=3)
        ax.text(i + 0.31, med, f"median {med:.2f} s", va="center", fontsize=8, color=INK)

    ax.set_yscale("log")
    ax.set_xticks(range(len(groups)), [g[0] for g in groups])
    ax.set_xlim(-0.6, 1.9)
    ax.set_ylabel("settlement latency (s, log scale)")
    ax.yaxis.set_major_locator(matplotlib.ticker.FixedLocator([1, 2, 5, 10, 20, 50]))
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:g}"))
    ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    ax.set_ylim(1.5, 60)
    ax.grid(axis="x", visible=False)
    ax.set_title("Settlement latency: createTx confirmed → confirmDelivery confirmed")
    fig.text(0.01, 0.01, "Each dot is one transaction (batch 100). Local latency reflects the configured block "
             "interval, not Besu.\nSources: results/full_latency_results.json, results/besu_results.json",
             fontsize=7, color=INK_2)
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    fig.savefig(OUT / "settlement_latency.png")
    plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    gas_per_function()
    settlement_latency()
    print(f"Wrote figures to {OUT}")
