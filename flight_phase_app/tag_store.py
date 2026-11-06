"""Persistent store and exporter for manual flight phase tags."""

from __future__ import annotations

import csv
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TAGS_FILE = WORKSPACE_ROOT / "data" / "manual_flight_phase_tags.json"


class TagStore:
    """Manages creation, query, persistence, and export of manual flight phase tags."""

    def __init__(self, storage_path: Path | str = DEFAULT_TAGS_FILE):
        self.storage_path = Path(storage_path)
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._tags: dict[str, dict[str, Any]] = {}
        self.load_tags()

    def load_tags(self) -> None:
        """Load stored tags from disk."""
        if not self.storage_path.is_file():
            self._tags = {}
            return

        try:
            with open(self.storage_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    self._tags = {t["tag_id"]: t for t in data if "tag_id" in t}
                elif isinstance(data, dict):
                    self._tags = data.get("tags", {})
        except Exception:
            self._tags = {}

    def save_tags(self) -> None:
        """Persist tags to disk JSON."""
        data = {
            "version": "1.0",
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "count": len(self._tags),
            "tags": self._tags,
        }
        with open(self.storage_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def get_tags(self, session_id: str | None = None, aircraft: str | None = None) -> list[dict[str, Any]]:
        """Retrieve tags, optionally filtered by session or aircraft."""
        results = list(self._tags.values())
        if session_id:
            results = [t for t in results if t.get("session_id") == session_id]
        if aircraft:
            results = [t for t in results if t.get("aircraft") == aircraft]
        results.sort(key=lambda t: (t.get("session_id", ""), t.get("t_start_s", 0)))
        return results

    def add_tag(
        self,
        session_id: str,
        aircraft: str,
        t_start_s: float,
        t_end_s: float,
        manual_phase: str,
        confidence: str = "high",
        notes: str = "",
        point_indices: list[int] | None = None,
        tag_id: str | None = None,
    ) -> dict[str, Any]:
        """Add or update a manual flight phase tag."""
        if not tag_id:
            tag_id = f"tag_{uuid.uuid4().hex[:8]}"

        t_start = min(float(t_start_s), float(t_end_s))
        t_end = max(float(t_start_s), float(t_end_s))

        record = {
            "tag_id": tag_id,
            "session_id": session_id,
            "aircraft": aircraft,
            "t_start_s": round(t_start, 2),
            "t_end_s": round(t_end, 2),
            "manual_phase": str(manual_phase).strip().lower(),
            "confidence": confidence,
            "notes": str(notes).strip(),
            "point_indices": point_indices or [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        self._tags[tag_id] = record
        self.save_tags()
        return record

    def delete_tag(self, tag_id: str) -> bool:
        """Delete a tag by ID."""
        if tag_id in self._tags:
            del self._tags[tag_id]
            self.save_tags()
            return True
        return False

    def export_tags_csv(self, output_path: Path | str | None = None) -> Path:
        """Export tags to CSV format."""
        if output_path is None:
            output_path = self.storage_path.with_suffix(".csv")
        else:
            output_path = Path(output_path)

        tags = self.get_tags()
        fieldnames = [
            "tag_id",
            "session_id",
            "aircraft",
            "t_start_s",
            "t_end_s",
            "manual_phase",
            "confidence",
            "notes",
            "point_indices_count",
            "created_at",
        ]

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for t in tags:
                row = dict(t)
                row["point_indices_count"] = len(row.get("point_indices", []))
                row.pop("point_indices", None)
                writer.writerow(row)

        return output_path

