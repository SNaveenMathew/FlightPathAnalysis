"""FastAPI backend server for the Flight Phase Visualization and Manual Tagging App."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from flight_phase_app.data_manager import DataManager
from flight_phase_app.evaluator import PhaseEvaluator
from flight_phase_app.tag_store import TagStore

STATIC_DIR = Path(__file__).resolve().parent / "static"

data_manager = DataManager()
tag_store = TagStore()
evaluator = PhaseEvaluator(data_manager=data_manager, tag_store=tag_store)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up data loading on startup
    data_manager.load_data()
    yield


app = FastAPI(
    title="Flight Phase Visualization & Manual Tagging App",
    description="Interactive visualization, animation, and manual flight-phase tagging studio.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class BatchSessionsRequest(BaseModel):
    session_ids: list[str] = Field(..., description="List of session IDs to fetch")

class ManualTagRequest(BaseModel):
    session_id: str
    aircraft: str
    t_start_s: float
    t_end_s: float
    manual_phase: str
    confidence: str = "high"
    notes: str = ""
    point_indices: list[int] = Field(default_factory=list)
    tag_id: str | None = None


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    aircraft = data_manager.get_aircraft_list()
    tags = tag_store.get_tags()
    return {
        "status": "ready",
        "total_aircraft": len(aircraft),
        "total_sessions": sum(a["session_count"] for a in aircraft),
        "total_manual_tags": len(tags),
    }


@app.get("/api/aircraft")
def get_aircraft() -> list[dict[str, Any]]:
    return data_manager.get_aircraft_list()


@app.get("/api/aircraft/{aircraft_id}")
def get_aircraft_details(aircraft_id: str) -> dict[str, Any]:
    details = data_manager.get_aircraft_details(aircraft_id)
    if not details:
        raise HTTPException(status_code=404, detail=f"Aircraft '{aircraft_id}' not found")

    # Add tag counts to sessions
    tags = tag_store.get_tags(aircraft=aircraft_id)
    tags_by_session = {}
    for t in tags:
        sid = t["session_id"]
        tags_by_session[sid] = tags_by_session.get(sid, 0) + 1

    for sess in details["sessions"]:
        sid = sess["id"]
        sess["manual_tag_count"] = tags_by_session.get(sid, 0)
        sess["has_manual_tags"] = sess["manual_tag_count"] > 0

    return details


@app.post("/api/sessions/batch")
def get_sessions_batch(req: BatchSessionsRequest) -> dict[str, Any]:
    if not req.session_ids:
        raise HTTPException(status_code=400, detail="session_ids cannot be empty")

    data = data_manager.get_sessions_batch(req.session_ids)

    # Attach any existing manual tags to each returned session
    for sess in data["sessions"]:
        sid = sess["id"]
        sess["manual_tags"] = tag_store.get_tags(session_id=sid)

    return data


@app.get("/api/sessions/{session_id}/neighborhood")
def get_session_neighborhood(
    session_id: str,
    max_distance_nm: float = Query(15.0, description="Maximum CPA distance in nautical miles"),
    limit: int = Query(15, description="Maximum number of neighbor flights to return"),
) -> dict[str, Any]:
    neighborhood = data_manager.get_session_neighborhood(
        session_id=session_id,
        max_distance_nm=max_distance_nm,
        max_neighbors=limit,
    )
    if not neighborhood:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return neighborhood


@app.get("/api/tags")
def get_tags(
    session_id: str | None = Query(None),
    aircraft: str | None = Query(None),
) -> list[dict[str, Any]]:
    return tag_store.get_tags(session_id=session_id, aircraft=aircraft)


@app.post("/api/tags")
def create_or_update_tag(req: ManualTagRequest) -> dict[str, Any]:
    tag = tag_store.add_tag(
        session_id=req.session_id,
        aircraft=req.aircraft,
        t_start_s=req.t_start_s,
        t_end_s=req.t_end_s,
        manual_phase=req.manual_phase,
        confidence=req.confidence,
        notes=req.notes,
        point_indices=req.point_indices,
        tag_id=req.tag_id,
    )
    return {"status": "success", "tag": tag}


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: str) -> dict[str, Any]:
    deleted = tag_store.delete_tag(tag_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Tag '{tag_id}' not found")
    return {"status": "success", "tag_id": tag_id}


@app.post("/api/tags/export")
def export_tags() -> dict[str, Any]:
    csv_path = tag_store.export_tags_csv()
    tags = tag_store.get_tags()
    return {
        "status": "success",
        "csv_path": str(csv_path),
        "tag_count": len(tags),
    }


@app.get("/api/evaluate")
def evaluate_tags(
    session_id: str | None = Query(None),
    aircraft: str | None = Query(None),
) -> dict[str, Any]:
    return evaluator.evaluate(session_id=session_id, aircraft=aircraft)


# Mount static directory for frontend web UI
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def serve_index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.is_file():
        return {"message": "Frontend static files are being prepared"}
    return FileResponse(str(index_file))
