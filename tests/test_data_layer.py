import copy
import json
from datetime import date

import pytest

from aureon.data.parsers import detect_and_parse, parse_expiry, parse_mcx_csv, parse_mcx_json, parse_trade_date
from aureon.data.pipeline import ingest_import_dir, ingest_text
from aureon.data.validation import implied_average_price, validate_row, validate_rows
from conftest import MCX_SAMPLE


def test_parse_real_mcx_json_format():
    res = parse_mcx_json(MCX_SAMPLE)
    assert res.skipped_out_of_universe == 1  # ALUMINI
    syms = {r["symbol"] for r in res.rows}
    assert syms == {"GOLDM", "GOLDPETAL", "GOLDGUINEA", "GOLDTEN", "GOLD"}
    goldm = next(r for r in res.rows if r["symbol"] == "GOLDM")
    assert goldm["trade_date"] == "2026-10-23" and goldm["expiry"] == "2026-11-05"
    assert goldm["close"] == 140453 and goldm["volume_lots"] == 39364


def test_real_rows_pass_value_volume_check():
    # The turnover-implied average price confirms lot size and quotation unit for every product.
    rows = parse_mcx_json(MCX_SAMPLE).rows
    good, bad = validate_rows(rows)
    assert not bad
    for r in good:
        vwap = implied_average_price(r)
        if vwap is not None:
            assert r["low"] <= vwap <= r["high"], r["symbol"]


def test_wrong_lot_size_is_detected():
    row = parse_mcx_json(MCX_SAMPLE).rows[0]  # GOLDM
    bad = dict(row, value_lakhs=row["value_lakhs"] / 10)  # as if the lot were 10 g instead of 100 g
    clean, rej = validate_row(bad)
    assert clean is None and rej["reason"] == "value_volume_inconsistent"


@pytest.mark.parametrize("patch,reason", [
    ({"close": 0}, "invalid_price"),
    ({"high": 100, "low": 200}, "invalid_ohlc"),
    ({"close": 150000}, "invalid_ohlc"),
    ({"expiry": "2026-10-01"}, "expired_contract"),
    ({"volume_lots": -5}, "invalid_quantity"),
])
def test_validation_rejections(patch, reason):
    row = dict(parse_mcx_json(MCX_SAMPLE).rows[0], **patch)
    clean, rej = validate_row(row)
    assert clean is None and rej["reason"] == reason


def test_expiry_day_settlement_close_is_labelled():
    row = dict(parse_mcx_json(MCX_SAMPLE).rows[1], trade_date="2026-10-30", close=14500)  # GOLDPETAL, expiry day
    clean, rej = validate_row(row)
    assert clean is None and rej["reason"] == "expiry_settlement_price"


def test_zero_volume_row_kept_with_null_ohlc():
    row = next(r for r in parse_mcx_json(MCX_SAMPLE).rows if r["symbol"] == "GOLD")
    clean, rej = validate_row(row)
    assert rej is None and clean["open"] is None and clean["high"] is None and clean["close"] == 153479


def test_date_parsing_respects_declared_order():
    assert parse_trade_date("03/04/2026", "DMY") == date(2026, 4, 3)
    assert parse_trade_date("03/04/2026", "MDY") == date(2026, 3, 4)
    assert parse_trade_date("23 Oct 2026") == date(2026, 10, 23)
    assert parse_expiry("05NOV2026") == date(2026, 11, 5)
    with pytest.raises(ValueError):
        parse_trade_date("2026/13/45")


def test_csv_export_parsing():
    csv = ("Date,Instrument,Commodity,Expiry Date,Option Type,Strike Price,Open,High,Low,Close,PCP,Vol (Lots),"
           "Volume (000’s),Value (Lakhs),OI (Lots)\n"
           '"23 Oct 2026","FUTCOM","GOLDTEN","30OCT2026","-","-","141444","141872","140130","140832","142223",'
           '"16895","168.950 GRMS","23829.92","22198"\n'
           '"23 Oct 2026","FUTCOM","ZINC","30OCT2026","-","-","1","1","1","1","1","1","1","1","1"\n')
    res = parse_mcx_csv(csv)
    assert len(res.rows) == 1 and res.rows[0]["close"] == 140832 and res.skipped_out_of_universe == 1


def test_duplicate_handling(store):
    rows = parse_mcx_json(MCX_SAMPLE).rows
    good, _ = validate_rows(rows)
    s1 = store.upsert_quotes(good, "a", 1)
    assert s1["inserted"] == len(good)
    s2 = store.upsert_quotes(good, "b", 2)
    assert s2["inserted"] == 0 and s2["identical_duplicates"] == len(good)
    changed = [dict(good[0], close=good[0]["close"] + 1)]
    s3 = store.upsert_quotes(changed, "c", 3)
    assert s3["conflicting_duplicates"] == 1
    # first-ingested value is kept, conflict is recorded
    df = store.quotes_frame()
    assert df.loc[(df.symbol == good[0]["symbol"]) & (df.expiry == good[0]["expiry"]), "close"].iloc[0] == good[0]["close"]
    assert (store.duplicates_frame()["identical"] == 0).sum() == 1


def test_raw_payload_preserved_and_deduplicated(store, tmp_settings):
    text = json.dumps(MCX_SAMPLE)
    r1 = ingest_text(store, tmp_settings, text, "test")
    r2 = ingest_text(store, tmp_settings, text, "test")
    assert r1["raw_id"] == r2["raw_id"] and r2["new_raw_payload"] is False
    assert store.raw_payload(r1["raw_id"])["payload"] == text


def test_bundle_and_import_dir(store, tmp_settings):
    bundle = {"aureon_bundle": 1, "items": [
        {"request": {"fromDate": "23/10/2026"}, "response": MCX_SAMPLE},
        {"request": {"fromDate": "24/10/2026"}, "error": "non-JSON response"}]}
    (tmp_settings.import_dir / "b.json").write_text(json.dumps(bundle), encoding="utf-8")
    out = ingest_import_dir(store, tmp_settings)
    assert out[0]["inserted"] == 5 and out[0]["rejection_reasons"].get("source_error") == 1
    assert (tmp_settings.import_dir / "processed" / "b.json").exists()
    from aureon.analytics.quality import collection_failures
    assert collection_failures(store.rejections_frame()) == ["24/10/2026"]


def test_tinyfish_payload_is_validated(store, tmp_settings):
    payload = {"run_id": "x", "status": "COMPLETED", "result": {"date": "2026-10-23", "rows": [
        {"commodity": "GOLDTEN", "expiry": "30OCT2026", "open": 141444, "high": 141872, "low": 140130, "close": 140832,
         "volume_lots": 16895, "value_lakhs": 23829.92, "open_interest": 22198},
        # hallucinated row: turnover inconsistent with prices
        {"commodity": "GOLDPETAL", "expiry": "30OCT2026", "open": 14231, "high": 14250, "low": 14088, "close": 14155,
         "volume_lots": 165873, "value_lakhs": 2350.99, "open_interest": 126729}]}}
    res = ingest_text(store, tmp_settings, json.dumps(payload), "tinyfish")
    assert res["format"] == "tinyfish" and res["inserted"] == 1
    assert res["rejection_reasons"] == {"value_volume_inconsistent": 1}
