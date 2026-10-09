import re
from datetime import date, datetime, timezone

from supabase import Client

from fetcher import METRON_OFFSET, window_bounds

UPSERT_BATCH = 200
SELECT_PAGE = 1000
DELETE_BATCH = 100

PUBLISHER_GROUP_MAP = {
    "DC Comics": "DC",
    "Marvel Comics": "MARVEL",
}


def _publisher_group(name: str) -> str:
    return PUBLISHER_GROUP_MAP.get(name, "OTROS")


def _select_all(db: Client, table: str, columns: str, **eq) -> list[dict]:
    """Lee una tabla entera paginando (PostgREST devuelve máx. 1000 filas)."""
    rows: list[dict] = []
    offset = 0
    while True:
        q = db.table(table).select(columns)
        for col, val in eq.items():
            q = q.eq(col, val)
        page = q.range(offset, offset + SELECT_PAGE - 1).execute().data
        rows.extend(page)
        if len(page) < SELECT_PAGE:
            return rows
        offset += SELECT_PAGE


def fetch_known_series(db: Client) -> dict[int, str]:
    """{series_id: series_type} de las series de Metron ya guardadas.

    Permite saltarse la consulta del tipo de serie (una petición por serie)
    para todas las que ya conocemos de runs anteriores.
    """
    rows = _select_all(db, "series", "series_id, series_type", source="metron")
    return {r["series_id"]: r["series_type"] for r in rows if r.get("series_type")}


def _batch_upsert(db: Client, table: str, rows: list[dict], on_conflict: str) -> None:
    for i in range(0, len(rows), UPSERT_BATCH):
        batch = rows[i:i + UPSERT_BATCH]
        try:
            db.table(table).upsert(batch, on_conflict=on_conflict).execute()
        except Exception as e:
            # Para no perder un run entero por una fila problemática, reintentamos
            # el lote fila a fila y saltamos (registrando) la que falle.
            print(f"  Lote {table}[{i}:{i + len(batch)}] falló ({e}); reintento fila a fila...", flush=True)
            for row in batch:
                try:
                    db.table(table).upsert(row, on_conflict=on_conflict).execute()
                except Exception as e2:
                    key = row.get("issue_id") or row.get("series_id") or row.get("name")
                    print(f"    Fila saltada ({table} {key}): {e2}", flush=True)


# ── Adopción de pulls antiguos de LoCG ──────────────────────────────────────

def _norm_name(s: str) -> str:
    s = (s or "").lower().replace("&", "and")
    s = re.sub(r"^the\s+", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def _norm_number(s: str) -> str:
    s = (s or "").strip().lstrip("#").lower()
    return str(int(s)) if s.isdigit() else s


def _adopt_locg_pulls(db: Client, issues: list[dict]) -> int:
    """Re-enlaza a Metron los pulls que vinieron de LoCG.

    Busca cada pull antiguo (issue_id de LoCG) en los números de Metron de la
    ventana por (nombre de serie, número, grupo). Si lo encuentra, le pone el
    issue_id/series_id de Metron y refresca fecha y portada, así vuelve a
    actualizarse solo. Nunca toca format ni status.
    """
    index: dict[tuple, list[dict]] = {}
    for i in issues:
        key = (_norm_name(i["series_name"]), _norm_number(i["issue_number"]),
               _publisher_group(i["publisher_name"]))
        index.setdefault(key, []).append(i)

    pulls = _select_all(
        db, "pulls",
        "id, issue_id, issue_number, release_date, series(name, publishers(publisher_group))",
    )
    adopted = 0
    for p in pulls:
        old = p.get("issue_id")
        if old is None or old >= METRON_OFFSET:
            continue  # manual o ya de Metron
        series = p.get("series") or {}
        group = (series.get("publishers") or {}).get("publisher_group")
        key = (_norm_name(series.get("name")), _norm_number(p["issue_number"]), group)
        candidates = index.get(key)
        if not candidates:
            continue
        # Si hay varias (p. ej. dos volúmenes), la de fecha más cercana
        pull_date = date.fromisoformat(p["release_date"])
        best = min(candidates, key=lambda c: abs((date.fromisoformat(c["release_date"]) - pull_date).days))
        try:
            db.table("pulls").update({
                "issue_id": best["issue_id"],
                "series_id": best["series_id"],
                "release_date": best["release_date"],
                "cover_url": best["cover_url"],
            }).eq("id", p["id"]).execute()
            adopted += 1
        except Exception as e:
            # Ej.: ya existe un pull de esa serie+número de Metron (UNIQUE)
            print(f"    No se pudo adoptar pull {p['id']}: {e}", flush=True)
    return adopted


def _delete_orphan_locg_series(db: Client) -> int:
    """Borra las series de LoCG que ya no usa ningún pull (tras la adopción)."""
    locg = {r["series_id"] for r in _select_all(db, "series", "series_id", source="locg")}
    if not locg:
        return 0
    used = {r["series_id"] for r in _select_all(db, "pulls", "series_id")}
    orphans = sorted(locg - used)
    for i in range(0, len(orphans), DELETE_BATCH):
        db.table("series").delete().in_("series_id", orphans[i:i + DELETE_BATCH]).execute()
    return len(orphans)


# ── Escritura principal ─────────────────────────────────────────────────────

def upsert_all(db: Client, issues: list[dict]) -> int:
    if not issues:
        return 0

    synced_at = datetime.now(timezone.utc).isoformat()

    # 1. Publishers — upsert por name (publisher_id lo asigna Postgres)
    pub_names = sorted({i["publisher_name"] for i in issues})
    db.table("publishers").upsert(
        [{"name": n, "publisher_group": _publisher_group(n)} for n in pub_names],
        on_conflict="name",
    ).execute()
    publisher_id_map = {
        row["name"]: row["publisher_id"]
        for row in db.table("publishers").select("publisher_id, name").in_("name", pub_names).execute().data
    }

    # 2. Series de Metron (con su tipo, para no reconsultarlo en el próximo run)
    series_rows: dict[int, dict] = {}
    for i in issues:
        series_rows.setdefault(i["series_id"], {
            "series_id": i["series_id"],
            "name": i["series_name"],
            "publisher_id": publisher_id_map[i["publisher_name"]],
            "source": "metron",
            "series_type": i["series_type"],
        })
    _batch_upsert(db, "series", list(series_rows.values()), "series_id")

    # 3. Releases
    releases = [
        {
            "issue_id": i["issue_id"],
            "series_id": i["series_id"],
            "issue_number": i["issue_number"],
            "release_date": i["release_date"],
            "cover_url": i["cover_url"],
            "price": i["price"],
            "description": i["description"],
            "issue_type": i["issue_type"],
            "synced_at": synced_at,
        }
        for i in issues
    ]
    print(f"  Upserting {len(releases)} releases in batches of {UPSERT_BATCH}...", flush=True)
    _batch_upsert(db, "releases", releases, "issue_id")

    # 4. Poda: fuera de la ventana, y cualquier release antiguo de LoCG
    window_start, window_end = window_bounds()
    db.table("releases").delete().lt("release_date", str(window_start)).execute()
    db.table("releases").delete().gt("release_date", str(window_end)).execute()
    db.table("releases").delete().gt("issue_id", 0).lt("issue_id", METRON_OFFSET).execute()

    # 5. Adopción de pulls de LoCG (antes del refresco, para que entren en él)
    adopted = _adopt_locg_pulls(db, issues)
    print(f"  Pulls de LoCG adoptados en Metron: {adopted}", flush=True)

    # 6. Refresco de pulls en ventana — solo fecha/portada/número, nunca format/status.
    # pulls es pequeña: se lee entera y se filtra en Python (un in_ con miles de
    # ids genera una URL demasiado larga y un 400 Bad Request).
    by_issue = {i["issue_id"]: i for i in issues}
    for pull in _select_all(db, "pulls", "id, issue_id"):
        fresh = by_issue.get(pull["issue_id"])
        if not fresh:
            continue
        db.table("pulls").update({
            "release_date": fresh["release_date"],
            "cover_url": fresh["cover_url"],
            "issue_number": fresh["issue_number"],
        }).eq("id", pull["id"]).execute()

    # 7. Limpieza de series de LoCG sin pulls (evita duplicados en el autocompletado)
    removed = _delete_orphan_locg_series(db)
    if removed:
        print(f"  Series antiguas de LoCG eliminadas: {removed}", flush=True)

    return len(releases)
