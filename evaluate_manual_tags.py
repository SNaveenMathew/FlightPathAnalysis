"""Standalone CLI tool to benchmark manual flight phase tags against flight_phase.py predictions.

Usage:
    python evaluate_manual_tags.py [--aircraft <ID>] [--session <ID>] [--export-csv <PATH>]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from flight_phase_app.data_manager import DataManager
from flight_phase_app.evaluator import PhaseEvaluator
from flight_phase_app.tag_store import TagStore


def main():
    parser = argparse.ArgumentParser(
        description="Benchmark manual human tags against flight_phase.py predictions."
    )
    parser.add_argument("--aircraft", help="Filter evaluation by aircraft ID")
    parser.add_argument("--session", help="Filter evaluation by session ID")
    parser.add_argument("--export-csv", help="Export evaluation details to CSV file")
    args = parser.parse_args()

    print("Loading flight sessions dataset and manual tags...")
    dm = DataManager()
    dm.load_data()
    ts = TagStore()
    evaluator = PhaseEvaluator(data_manager=dm, tag_store=ts)

    res = evaluator.evaluate(session_id=args.session, aircraft=args.aircraft)

    print("\n" + "=" * 70)
    print("   📊 FLIGHT PHASE EVALUATION & REFINEMENT REPORT")
    print("=" * 70)
    print(f"Total Human Tags Analyzed:       {res['total_tags']}")
    print(f"Total Trajectory Points Tested:  {res['total_points_evaluated']}")
    print(f"Matching Points:                 {res['matching_points']}")
    print(f"Mismatching Points:              {res['mismatching_points']}")
    print(f"Overall Agreement Rate:          {res['agreement_rate_pct']} %")
    print("=" * 70)

    # Per-phase precision and recall
    if res["phase_metrics"]:
        print("\n📈 PER-PHASE ACCURACY METRICS:")
        print(f"{'Phase':<24} {'Support':<10} {'Precision':<12} {'Recall':<12}")
        print("-" * 58)
        for ph, m in res["phase_metrics"].items():
            if m["manual_support_points"] > 0 or m["predicted_points"] > 0:
                print(
                    f"{ph:<24} {m['manual_support_points']:<10} {m['precision_pct']:>5.1f}%      {m['recall_pct']:>5.1f}%"
                )

    # Refinement Suggestions
    print("\n🔬 HEURISTIC REFINEMENT RECOMMENDATIONS FOR flight_phase.py:")
    for idx, s in enumerate(res["refinement_suggestions"], 1):
        print(f" {idx}. {s}")

    # Disagreements sample
    disagreements = res.get("disagreements", [])
    if disagreements:
        print(f"\n⚠️  DISAGREEMENT AUDIT SAMPLES (Showing up to {min(10, len(disagreements))} of {len(disagreements)}):")
        print(f"{'Time':<8} {'Alt(ft)':<10} {'Manual Tag':<16} {'Model Pred':<16} {'Notes'}")
        print("-" * 70)
        for d in disagreements[:10]:
            t_str = f"{d['time_s']:.1f}s"
            alt_str = f"{d['altitude_ft']:.0f}"
            print(f"{t_str:<8} {alt_str:<10} {d['manual_phase']:<16} {d['predicted_phase']:<16} {d['tag_notes']}")

    if args.export_csv and disagreements:
        import csv
        out_path = Path(args.export_csv)
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            fieldnames = ["session_id", "aircraft", "time_s", "altitude_ft", "manual_phase", "predicted_phase", "model_confidence", "model_detail", "tag_notes"]
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for d in disagreements:
                writer.writerow(d)
        print(f"\nExported {len(disagreements)} disagreement records to: {out_path.resolve()}")

    print("\nReport complete.\n")


if __name__ == "__main__":
    main()

