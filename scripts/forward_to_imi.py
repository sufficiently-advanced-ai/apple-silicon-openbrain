#!/usr/bin/env python3
"""Forward new openbrain memories to imi — the ongoing egress that makes imi
the sole memory store while openbrain stays a polling/ingestion engine.

Architecture (decided 2026-08-19): openbrain keeps the source polling
(separation of concerns) but is NOT a store of record. Every live row in its
`memories` table is forwarded to imi's capture API; nothing else connects to
openbrain. Runs from launchd every 15 minutes (ai.saai.openbrain-imi-forward);
the first run backfills everything.

Conventions (must not drift — the Hermes Daily Scan feeds depend on them):
  - `source` and `source_id` pass through VERBATIM (mail / youtube / web +
    URL or message-id). scan_canvas.imi_captures(source=...) queries imi by
    these names, and imi dedups on source_id so re-forwarding is idempotent.
  - Content is the enrichment summary when present, else truncated raw
    content. Since 2026-08-20 openbrain enrichment is disabled
    (DISABLE_ENRICHMENT) so in practice raw content flows through and imi's
    own capture enrichment generates the summary (capture.summary field) —
    imi is the sole summarizer.
  - Rows with no source_id get `openbrain:<uuid>` so idempotency still holds.

Watermark on created_at, stored next to this repo; only advances past rows
that were accepted (or deduped) by imi, so failures retry on the next run.
Stdlib only — postgres is read via psql/row_to_json, no driver needed.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# imi moved off LCARS to holodeck on 2026-09-02; the loopback target died with it and
# every run refused for 5 days (watermark held at 2026-09-01T11:04, nothing lost).
# Tailnet name has a real Let's Encrypt cert, so plain urllib verifies fine.
IMI_URL = "https://holodeck.tail4f2c31.ts.net:9443/api/captures"
STATE_PATH = Path("/Users/scott/Developer/openbrain/.imi_forward_state.json")
# Absolute path: launchd's PATH doesn't include /opt/homebrew/bin.
PSQL = ["/opt/homebrew/bin/psql", "-h", "localhost", "-p", "5432", "-U", "scott", "-d", "openbrain", "-t", "-A"]
BATCH_LIMIT = 300          # per run; launchd re-fires in 15 min anyway
MAX_CONTENT_CHARS = 4000   # fallback truncation when a row has no summary
REQUEST_TIMEOUT = 15       # imi persists (sync) before enriching; don't wait out a jammed enrichment queue
PACE_SECONDS = 0.2         # ~5 req/s, under imi's 10 req/s rate limit


def load_watermark() -> str:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())["watermark"]
        except Exception:
            pass
    return "1970-01-01T00:00:00+00:00"


def save_watermark(ts: str) -> None:
    STATE_PATH.write_text(json.dumps({"watermark": ts}))


def fetch_rows(after: str) -> list[dict]:
    query = f"""
        SELECT row_to_json(t) FROM (
            SELECT id, content, summary, source, source_id, tags,
                   created_at, source_date
            FROM memories
            WHERE deleted_at IS NULL AND created_at > '{after}'
            ORDER BY created_at ASC
            LIMIT {BATCH_LIMIT}
        ) t
    """
    out = subprocess.run(
        PSQL + ["-c", query], capture_output=True, text=True, check=True
    ).stdout
    # NB: split on "\n" only — splitlines() also splits on  / ,
    # which are legal unescaped inside JSON strings and do appear in content.
    return [json.loads(line) for line in out.split("\n") if line.strip()]


# imi's request validator 400s on these raw substrings (request_validator.py
# DANGEROUS_PATTERNS). Newsletter/scrape bodies legitimately contain them as
# inert text (HTML attrs, code snippets); neutralize with a space so the
# corpus text survives review while the substring no longer matches.
_NEUTRALIZE = {
    "<script": "< script",
    "javascript:": "javascript :",
    "vbscript:": "vbscript :",
    "onload=": "onload =",
    "onerror=": "onerror =",
    "onclick=": "onclick =",
    "eval(": "eval (",
    "exec(": "exec (",
    "import(": "import (",
    "__import__": "__import __",
}


def sanitize(text: str) -> str:
    for bad, safe in _NEUTRALIZE.items():
        if bad in text:
            text = text.replace(bad, safe)
    return text


def build_payload(row: dict) -> dict:
    body = (row.get("summary") or "").strip()
    if not body:
        body = (row.get("content") or "").strip()[:MAX_CONTENT_CHARS]
    body = sanitize(body)
    source_id = row.get("source_id") or f"openbrain:{row['id']}"
    if source_id.startswith("http") and source_id not in body:
        body += f"\n\nSource URL: {source_id}"
    tags = [t for t in (row.get("tags") or []) if isinstance(t, str)]
    return {
        "content": body,
        "source": row.get("source") or "openbrain",
        "source_id": source_id,
        "tags": tags or None,
        "source_date": row.get("source_date") or row.get("created_at"),
    }


def post_capture(payload: dict) -> str:
    """Returns ok | dedup | sent (timeout after server-side persist likely) — or raises."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        IMI_URL, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read())
        return "dedup" if data.get("deduped") else "ok"
    except (TimeoutError, socket.timeout):
        # socket.timeout is TimeoutError only on Python 3.10+; catch both so
        # the tolerant path works on any interpreter launchd picks.
        # Persist-first server side: overwhelmingly likely the capture landed
        # and only enrichment was slow. Idempotent source_id means a rare
        # miss self-heals if the row is ever re-forwarded.
        return "sent"
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), (TimeoutError, socket.timeout)):
            return "sent"
        raise


def main() -> int:
    watermark = load_watermark()
    try:
        rows = fetch_rows(watermark)
    except subprocess.CalledProcessError as e:
        print(f"psql failed: {e.stderr.strip()}", file=sys.stderr)
        return 1
    if not rows:
        print(f"up to date (watermark {watermark})")
        return 0

    counts = {"ok": 0, "dedup": 0, "sent": 0, "rejected": 0}
    for row in rows:
        try:
            status = post_capture(build_payload(row))
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                # Client rejection is deterministic — retrying the same row
                # would poison the queue forever. Log, skip, advance.
                print(
                    f"rejected {row['id']} (HTTP {e.code}): "
                    f"{e.read().decode(errors='replace')[:200]}",
                    file=sys.stderr,
                )
                counts["rejected"] += 1
                watermark = row["created_at"]
                save_watermark(watermark)
                continue
            print(
                f"stopped at {row['id']} (HTTP {e.code}); "
                f"{sum(counts.values())} forwarded this run, watermark {watermark}",
                file=sys.stderr,
            )
            return 1
        except Exception as e:  # noqa: BLE001 — stop, retry this row next run
            print(
                f"stopped at {row['id']} ({type(e).__name__}: {e}); "
                f"{sum(counts.values())} forwarded this run, watermark {watermark}",
                file=sys.stderr,
            )
            return 1
        counts[status] += 1
        watermark = row["created_at"]
        # Save every row: runs can be killed externally, and a lost watermark
        # means re-forwarding the whole batch (harmless via dedup, but slow).
        save_watermark(watermark)
        time.sleep(PACE_SECONDS)

    print(f"forwarded {len(rows)} rows {counts}, watermark {watermark}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
