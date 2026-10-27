"""HTTP API + static frontend."""
from __future__ import annotations

import logging
import threading
from datetime import date
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .analytics.relative_value import PairConfig
from .backtest.costs import CostModel
from .backtest.engine import BacktestConfig
from .backtest.walkforward import WalkForwardConfig
from .config import ROOT, get_settings
from .data.pipeline import collect_tinyfish, ingest_import_dir, ingest_text, seed_if_empty
from .jsonify import to_jsonable
from .logging_setup import configure_logging
from .service import Service, build_dataclass
from .signals.engine import SignalConfig
from .specs import ALL_SYMBOLS, RESEARCH_SYMBOLS

log = logging.getLogger(__name__)
FRONTEND = ROOT / "frontend"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def J(obj) -> JSONResponse:
    return JSONResponse(to_jsonable(obj))


def _pair_cfg(a, b, lookback, min_dte, max_gap, carry, min_obs) -> PairConfig:
    for s in (a, b):
        if s not in RESEARCH_SYMBOLS:
            raise HTTPException(400, f"unknown research symbol {s!r}")
    if a == b:
        raise HTTPException(400, "pair legs must differ")
    if lookback < 5 or lookback > 1000:
        raise HTTPException(400, "lookback must be between 5 and 1000")
    return PairConfig(a=a, b=b, lookback=lookback, min_dte=min_dte, max_expiry_gap=max_gap, carry_adjust=carry,
                      min_obs=min(min_obs, lookback))


def _configs(body: dict) -> tuple[PairConfig, BacktestConfig]:
    p = body.get("pair", {})
    pc = _pair_cfg(p.get("a", "GOLDM"), p.get("b", "GOLDTEN"), int(p.get("lookback", 60)), int(p.get("min_dte", 10)),
                   int(p.get("max_expiry_gap", 10)), bool(p.get("carry_adjust", True)), int(p.get("min_obs", 30)))
    sig = build_dataclass(SignalConfig, body.get("signal"))
    costs = build_dataclass(CostModel, body.get("costs"))
    bt = BacktestConfig(a=pc.a, b=pc.b, execution=body.get("execution", "next_close"),
                        capital=float(body.get("capital", 1_000_000)), signal=sig, costs=costs)
    # Compare only contracts the strategy is allowed to trade; otherwise unusual gaps near expiry are
    # detected on contracts that the entry rule then forbids, and the strategy can never act.
    pc.min_dte = max(pc.min_dte, int(sig.min_entry_dte))
    if bt.execution not in ("next_close", "next_open"):
        raise HTTPException(400, "execution must be next_close or next_open")
    if sig.exit_dte < 2:
        raise HTTPException(400, "exit_dte must be at least 2 business days so positions close before expiry")
    return pc, bt


def create_app(service: Service | None = None) -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    svc = service or Service(settings)
    if service is None:
        seed_if_empty(svc.store, settings)
    # Read-only deployments serve ready-made answers for page loads (see aureon/prebuild.py).
    from .prebuild import load_prebuilt, request_key
    prebuilt = load_prebuilt(settings, svc.store) if settings.read_only else {}
    if prebuilt:
        log.info("serving %d prebuilt responses", len(prebuilt))
    app = FastAPI(title="Aureon", version="1.0.0")

    @app.middleware("http")
    async def _serve_prebuilt(request, call_next):
        if prebuilt and request.method == "GET":
            hit = prebuilt.get(request_key(request.url.path, request.url.query))
            if hit is not None:
                return Response(hit.read_bytes(), media_type="application/json")
        return await call_next(request)

    def _writable() -> None:
        if settings.read_only:
            raise HTTPException(403, "This Aureon deployment is read-only: data can't be uploaded or collected here.")
    app.state.service = svc

    @app.middleware("http")
    async def _revalidate_static(request, call_next):
        # Make browsers re-check UI files so an updated frontend is picked up without a hard refresh.
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(Exception)
    async def _err(_, exc: Exception):  # pragma: no cover - last-resort handler
        log.exception("unhandled error")
        return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)

    # ---------------------------------------------------------------- reference & status
    @app.get("/api/health")
    async def health():
        # Liveness for hosting platforms: answered on the event loop, independent of any analytics.
        return {"ok": True}

    @app.get("/api/status")
    def status():
        return J({**svc.status(), "read_only": settings.read_only})

    @app.get("/api/specs")
    def specs():
        return J(svc.specs())

    @app.get("/api/overview")
    def overview():
        return J(svc.overview())

    # ---------------------------------------------------------------- contracts
    @app.get("/api/contracts")
    def contracts(min_dte: int = 5, min_volume_lots: float = 1, min_open_interest: float = 0):
        return J({"contracts": svc.contracts({"min_dte": min_dte, "min_volume_lots": min_volume_lots,
                                               "min_open_interest": min_open_interest}),
                  "fronts": {k: {"transitions": v["transitions"]} for k, v in svc.fronts(min_dte).items()}})

    @app.get("/api/contracts/{symbol}/{expiry}")
    def contract(symbol: str, expiry: str):
        if symbol not in ALL_SYMBOLS:
            raise HTTPException(404, "unknown symbol")
        h = svc.contract_history(symbol, expiry)
        cols = ["trade_date", "open", "high", "low", "close", "prev_close", "volume_lots", "value_lakhs",
                "open_interest", "norm", "dte", "traded", "source", "raw_id"]
        return J({"symbol": symbol, "expiry": expiry, "history": h[cols] if not h.empty else []})

    # ---------------------------------------------------------------- research
    @app.get("/api/relative-value")
    def relative_value(a: str = "GOLDM", b: str = "GOLDTEN", lookback: int = 60, min_dte: int = 10,
                       max_gap: int = 10, carry: bool = True, min_obs: int = 30):
        res = svc.relative_value(_pair_cfg(a, b, lookback, min_dte, max_gap, carry, min_obs))
        cols = ["trade_date", "expiry_a", "expiry_b", "close_a", "close_b", "norm_a", "norm_b", "adj_a", "adj_b",
                "dte_a", "dte_b", "expiry_gap", "carry", "spread_abs", "spread_bps", "raw_spread_bps", "mean", "std",
                "z", "pctile", "upper", "lower", "roll", "segment", "volume_lots_a", "volume_lots_b"]
        s = res["series"]
        res["series"] = s[cols] if not s.empty else []
        return J(res)

    @app.get("/api/relative-value/matrix")
    def matrix(lookback: int = 60, min_dte: int = 10, max_gap: int = 10, carry: bool = True):
        return J(svc.matrix(PairConfig(lookback=lookback, min_dte=min_dte, max_expiry_gap=max_gap, carry_adjust=carry,
                                       min_obs=min(30, lookback))))

    @app.get("/api/term-structure")
    def term_structure(symbol: str = "GOLDM", date_: str | None = Query(None, alias="date")):
        if symbol not in ALL_SYMBOLS:
            raise HTTPException(404, "unknown symbol")
        return J(svc.term_structure(symbol, date_))

    @app.post("/api/signals")
    def signals(body: dict = Body(default={})):
        pc, bt = _configs(body)
        return J(svc.signals(pc, bt.signal, bt.costs, int(body.get("last_n", 250))))

    @app.post("/api/backtest")
    def backtest(body: dict = Body(default={})):
        pc, bt = _configs(body)
        return J(svc.backtest(pc, bt, body.get("start"), body.get("end"), body.get("cost_sensitivity")))

    @app.post("/api/walkforward")
    def walkforward(body: dict = Body(default={})):
        pc, bt = _configs(body)
        wf = build_dataclass(WalkForwardConfig, body.get("walkforward"))
        return J(svc.walkforward(pc, bt, wf))

    @app.get("/api/results/latest")
    def latest_results():
        return J({"backtest": svc.last_backtest, "walkforward": svc.last_walkforward})

    @app.get("/api/quality")
    def quality():
        return J(svc.quality())

    # ---------------------------------------------------------------- data ingestion
    @app.post("/api/ingest/upload")
    async def upload(file: UploadFile = File(...)):
        _writable()
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "file too large")
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise HTTPException(400, "file must be UTF-8 JSON or CSV") from exc
        run = svc.store.start_run("upload", {"file": file.filename})
        res = ingest_text(svc.store, settings, text, source="upload", request={"file": file.filename},
                          filename=file.filename or "")
        svc.store.finish_run(run, "error" if "error" in res else "ok", res)
        return J(res)

    @app.post("/api/ingest/scan")
    def scan():
        _writable()
        return J({"results": ingest_import_dir(svc.store, settings)})

    @app.get("/api/ingest/runs")
    def runs():
        return J({"runs": svc.store.runs(100), "raw": svc.store.raw_summary()})

    @app.get("/api/ingest/raw/{raw_id}")
    def raw(raw_id: int):
        r = svc.store.raw_payload(raw_id)
        if not r:
            raise HTTPException(404, "raw payload not found")
        return PlainTextResponse(r["payload"], media_type=r["content_type"] or "text/plain")

    @app.post("/api/collect/tinyfish")
    def collect(body: dict = Body(default={})):
        _writable()
        if not settings.tinyfish_api_key:
            raise HTTPException(400, "TINYFISH_API_KEY is not configured — add it to .env and restart.")
        if svc.collection_status.get("running"):
            raise HTTPException(409, "a collection is already running")
        try:
            start = date.fromisoformat(body["start"])
            end = date.fromisoformat(body.get("end") or body["start"])
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, "start/end must be YYYY-MM-DD") from exc
        if end < start or (end - start).days > 400:
            raise HTTPException(400, "date range must be ordered and at most 400 days")

        def work():
            svc.collection_status = {"running": True, "start": start, "end": end}
            try:
                res = collect_tinyfish(svc.store, settings, start, end)
                svc.collection_status = {"running": False, "last_result": {k: v for k, v in res.items() if k != "days"}}
            except Exception as exc:  # noqa: BLE001
                log.exception("TinyFish collection failed")
                svc.collection_status = {"running": False, "error": str(exc)}

        threading.Thread(target=work, daemon=True).start()
        return J({"started": True})

    @app.get("/api/collector-script", response_class=PlainTextResponse)
    def collector_script():
        return PlainTextResponse((FRONTEND / "collector" / "mcx_collector.js").read_text(encoding="utf-8"))

    # ---------------------------------------------------------------- frontend
    if FRONTEND.exists():
        app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

        @app.get("/")
        def index():
            return FileResponse(FRONTEND / "index.html")

        @app.get("/favicon.ico", include_in_schema=False)
        def favicon():
            return FileResponse(FRONTEND / "favicon.svg", media_type="image/svg+xml")

    return app


def main() -> None:  # pragma: no cover
    import uvicorn

    s = get_settings()
    uvicorn.run("aureon.api:create_app", factory=True, host=s.host, port=s.port, log_level=s.log_level.lower())
