import io
import json

from fastapi.testclient import TestClient

from aureon.api import create_app
from aureon.service import Service
from conftest import MCX_SAMPLE


def client(settings, store):
    return TestClient(create_app(Service(settings, store)))


def test_empty_state_is_honest(tmp_settings, store):
    c = client(tmp_settings, store)
    s = c.get("/api/status").json()
    assert s["has_data"] is False and s["counts"]["quotes"] == 0
    assert c.get("/api/overview").json() == {"has_data": False}
    q = c.get("/api/quality").json()
    assert q["empty"] is True and q["warnings"][0]["code"] == "no_data"
    rv = c.get("/api/relative-value", params={"a": "GOLDM", "b": "GOLDTEN"}).json()
    assert rv["series"] == [] and rv["stats"] == {}
    bt = c.post("/api/backtest", json={"pair": {"a": "GOLDM", "b": "GOLDTEN"}}).json()
    assert bt["trades"] == [] and bt["metrics"]["verdict"] == "no_data"


def test_input_validation(tmp_settings, store):
    c = client(tmp_settings, store)
    assert c.get("/api/relative-value", params={"a": "SILVER", "b": "GOLDM"}).status_code == 400
    assert c.get("/api/relative-value", params={"a": "GOLDM", "b": "GOLDM"}).status_code == 400
    assert c.post("/api/backtest", json={"execution": "same_close"}).status_code == 400
    assert c.post("/api/collect/tinyfish", json={"start": "2026-01-01"}).status_code == 400  # no key configured


def test_upload_then_views(tmp_settings, store):
    c = client(tmp_settings, store)
    r = c.post("/api/ingest/upload", files={"file": ("d.json", io.BytesIO(json.dumps(MCX_SAMPLE).encode()), "application/json")})
    assert r.status_code == 200 and r.json()["inserted"] == 5
    assert c.get("/api/status").json()["has_data"] is True
    ct = c.get("/api/contracts").json()["contracts"]
    assert {x["symbol"] for x in ct} == {"GOLD", "GOLDM", "GOLDTEN", "GOLDGUINEA", "GOLDPETAL"}
    ts = c.get("/api/term-structure", params={"symbol": "GOLDTEN"}).json()
    assert ts["has_data"] is True
    ov = c.get("/api/overview").json()
    assert ov["has_data"] is True
    raw_id = r.json()["raw_id"]
    assert json.loads(c.get(f"/api/ingest/raw/{raw_id}").text) == MCX_SAMPLE


def test_full_research_flow_on_synthetic_store(tmp_settings, synthetic_store):
    c = client(tmp_settings, synthetic_store)
    assert c.get("/api/relative-value/matrix").status_code == 200
    sig = c.post("/api/signals", json={"pair": {"a": "GOLDTEN", "b": "GOLDGUINEA", "lookback": 40}}).json()
    assert len(sig["evaluations"]) > 0
    assert 0 < sig["signal_episodes"] <= sig["signal_count"] or sig["signal_count"] == 0
    bt = c.post("/api/backtest", json={"pair": {"a": "GOLDTEN", "b": "GOLDGUINEA", "lookback": 40},
                                       "signal": {"entry_z": 1.5, "min_open_interest": 0, "target_fine_grams": 100,
                                                  "max_participation": 1.0}}).json()
    assert "metrics" in bt and len(bt["cost_sensitivity"]) == 6
    wf = c.post("/api/walkforward", json={"pair": {"a": "GOLDTEN", "b": "GOLDGUINEA"},
                                          "walkforward": {"train_days": 120, "validation_days": 40, "test_days": 40,
                                                          "lookbacks": [20, 40], "entry_zs": [2.0]}}).json()
    assert "folds" in wf
    assert c.get("/api/results/latest").json()["backtest"] is not None


def test_seed_loads_into_empty_database_once(tmp_settings, store):
    from aureon.data.pipeline import seed_if_empty
    tmp_settings.seed_dir = tmp_settings.data_dir / "seed"
    tmp_settings.seed_dir.mkdir()
    (tmp_settings.seed_dir / "s.json").write_text(json.dumps(MCX_SAMPLE), encoding="utf-8")
    first = seed_if_empty(store, tmp_settings)
    assert first and first[0]["inserted"] == 5
    assert seed_if_empty(store, tmp_settings) == []  # already populated: skipped
    assert (tmp_settings.seed_dir / "s.json").exists()  # seed files are never moved


def test_read_only_blocks_writes(tmp_settings, store, monkeypatch):
    from aureon import api as api_mod
    tmp_settings.read_only = True
    monkeypatch.setattr(api_mod, "get_settings", lambda: tmp_settings)
    c = TestClient(api_mod.create_app(Service(tmp_settings, store)))
    assert c.get("/api/status").json()["read_only"] is True
    r = c.post("/api/ingest/upload", files={"file": ("d.json", io.BytesIO(b"{}"), "application/json")})
    assert r.status_code == 403
    assert c.post("/api/ingest/scan").status_code == 403
    assert c.post("/api/collect/tinyfish", json={"start": "2026-01-01"}).status_code == 403
    assert c.get("/api/overview").status_code == 200  # reading still works
