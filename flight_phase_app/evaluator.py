"""Evaluator comparing manual flight phase tags against model predictions.

Provides confusion matrices, agreement metrics, and heuristic refinement recommendations
for 02-Preprocessing/flight_phase.py.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any


class PhaseEvaluator:
    """Evaluates agreement between manual human tags and algorithmic predictions."""

    def __init__(self, data_manager: Any, tag_store: Any):
        self.data_manager = data_manager
        self.tag_store = tag_store

    def evaluate(self, session_id: str | None = None, aircraft: str | None = None) -> dict[str, Any]:
        """Perform evaluation across all or filtered manual tags."""
        tags = self.tag_store.get_tags(session_id=session_id, aircraft=aircraft)
        if not tags:
            return {
                "total_tags": 0,
                "total_points_evaluated": 0,
                "agreement_rate_pct": 0.0,
                "matching_points": 0,
                "mismatching_points": 0,
                "confusion_matrix": {},
                "phase_metrics": {},
                "disagreements": [],
                "refinement_suggestions": [
                    "No manual tags found yet. Tag flight phases in the visualizer to generate benchmark metrics."
                ],
            }

        # Need full sessions batch
        session_ids = list(set(t["session_id"] for t in tags))
        batch = self.data_manager.get_sessions_batch(session_ids)
        sessions_map = {s["id"]: s for s in batch["sessions"]}

        total_points = 0
        matching_points = 0
        confusion: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        disagreements = []
        phase_support: Counter[str] = Counter()
        phase_matches: Counter[str] = Counter()

        for tag in tags:
            sid = tag["session_id"]
            sess = sessions_map.get(sid)
            if not sess:
                continue

            manual_phase = tag["manual_phase"]
            t_start = tag["t_start_s"]
            t_end = tag["t_end_s"]
            notes = tag.get("notes", "")

            phase_samples = sess.get("phase_samples", [])
            points = sess.get("points", [])

            for idx, ps in enumerate(phase_samples):
                t_sample = float(ps.get("time_s", 0.0))
                if t_start <= t_sample <= t_end:
                    total_points += 1
                    pred_phase = ps.get("phase", "unknown")
                    phase_support[manual_phase] += 1
                    confusion[manual_phase][pred_phase] += 1

                    is_match = (pred_phase == manual_phase)
                    if is_match:
                        matching_points += 1
                        phase_matches[manual_phase] += 1
                    else:
                        # Capture disagreement context
                        pt = points[idx] if idx < len(points) else [0, 0, 0, 0]
                        alt_ft = pt[2] if len(pt) >= 3 else 0
                        evidence = ps.get("evidence", [])
                        detail = ps.get("detail", "")
                        conf = ps.get("confidence", 0.0)

                        if len(disagreements) < 50:  # limit audit size
                            disagreements.append({
                                "session_id": sid,
                                "aircraft": tag.get("aircraft", sess.get("aircraft", "")),
                                "time_s": t_sample,
                                "point_index": idx,
                                "altitude_ft": alt_ft,
                                "manual_phase": manual_phase,
                                "predicted_phase": pred_phase,
                                "model_confidence": round(float(conf), 2),
                                "model_detail": detail,
                                "model_evidence": evidence,
                                "tag_notes": notes,
                            })

        agreement_pct = round((matching_points / total_points * 100), 1) if total_points > 0 else 0.0

        # Per-phase precision / recall / agreement
        phase_metrics = {}
        all_phases = sorted(list(set(list(confusion.keys()) + [p for row in confusion.values() for p in row.keys()])))

        for ph in all_phases:
            support = phase_support[ph]
            matches = phase_matches[ph]
            recall = round(matches / support * 100, 1) if support > 0 else 0.0

            # Predicted count for precision
            pred_count = sum(confusion[m][ph] for m in confusion)
            precision = round(matches / pred_count * 100, 1) if pred_count > 0 else 0.0

            phase_metrics[ph] = {
                "manual_support_points": support,
                "predicted_points": pred_count,
                "matching_points": matches,
                "precision_pct": precision,
                "recall_pct": recall,
            }

        # Generate rule refinement suggestions for flight_phase.py
        refinement_suggestions = self._generate_suggestions(confusion, disagreements)

        return {
            "total_tags": len(tags),
            "total_points_evaluated": total_points,
            "agreement_rate_pct": agreement_pct,
            "matching_points": matching_points,
            "mismatching_points": total_points - matching_points,
            "confusion_matrix": {m: dict(preds) for m, preds in confusion.items()},
            "phase_metrics": phase_metrics,
            "disagreements": disagreements,
            "refinement_suggestions": refinement_suggestions,
        }

    def _generate_suggestions(
        self, confusion: dict[str, dict[str, int]], disagreements: list[dict[str, Any]]
    ) -> list[str]:
        """Infer actionable heuristic adjustments for flight_phase.py based on disagreements."""
        suggestions = []

        # Check Descent vs Approach confusion
        descent_as_approach = confusion.get("approach", {}).get("descent", 0)
        approach_as_descent = confusion.get("descent", {}).get("approach", 0)
        if descent_as_approach > 5:
            suggestions.append(
                f"Observed {descent_as_approach} samples where manual tag was 'approach' but model predicted 'descent'. "
                "Check `AIRPORT_CONTEXT_NM` (currently 50.0 nm), `closure_rate_kts >= 25.0`, or altitude <= 8,000 ft in `flight_phase.py`."
            )
        if approach_as_descent > 5:
            suggestions.append(
                f"Observed {approach_as_descent} samples where manual tag was 'descent' but model predicted 'approach'. "
                "The aircraft may be within 50nm but still enroute or not in final descent to the target airport."
            )

        # Check Ground vs Landing Roll confusion
        ground_as_roll = confusion.get("ground", {}).get("landing_roll", 0)
        if ground_as_roll > 5:
            suggestions.append(
                f"Observed {ground_as_roll} samples where manual tag was 'ground' but model predicted 'landing_roll'. "
                "Consider lowering the 90-second dwell time window (`now - last_touchdown_ms <= 90_000`) or raising the 10 kt threshold."
            )

        # Check Level Flight vs Cruise
        level_as_cruise = confusion.get("level_flight", {}).get("cruise", 0)
        cruise_as_level = confusion.get("cruise", {}).get("level_flight", 0)
        if level_as_cruise > 5 or cruise_as_level > 5:
            suggestions.append(
                "Disagreements detected between 'cruise' and 'level_flight'. "
                "Consider refining the 20nm distance boundary or sector context criteria in `flight_phase.py` line 485."
            )

        # Check Climb vs Initial Climb
        climb_as_initial = confusion.get("climb", {}).get("initial_climb", 0)
        if climb_as_initial > 5:
            suggestions.append(
                f"Observed {climb_as_initial} samples where manual tag was 'climb' but model predicted 'initial_climb'. "
                "The 180-second window (`now - last_takeoff_ms <= 180_000`) may be too long for rapid climb profiles."
            )

        if not suggestions:
            suggestions.append(
                "High concordance observed or insufficient disagreement volume to trigger specific heuristic alerts. "
                "Continue tagging edge cases around airport transitions (liftoff, top of descent, approach intercept, touchdown)."
            )

        return suggestions

