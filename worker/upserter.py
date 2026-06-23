from datetime import date, datetime, timezone

from supabase import Client

WINDOW_MONTHS = 3
UPSERT_BATCH = 200
SELECT_PAGE = 1000


def fetch_known_series(db: Client) -> dict[str, int]:
    """Mapa {nombre|editorial (minúsculas): series_id} de las series ya conocidas.

    Permite reutilizar el series_id entre runs y saltarse la llamada issue_info()
    (lo más lento del worker) para series que ya están en la BD.
    """
    pubs = db.table("publishers").select("publisher_id, name").execute().data
    pub_name = {p["publisher_id"]: p["name"] for p in pubs}

    known: dict[str, int] = {}
    offset = 0
    while True:
        rows = (
            db.table("series")
            .select("series_id, name, publisher_id")
            .range(offset, offset + SELECT_PAGE - 1)
            .execute()
            .data
        )
        if not rows:
            break
        for r in rows:
            pname = pub_name.get(r["publisher_id"], "")
            known[f"{r['name']}|{pname}".lower()] = r["series_id"]
        if len(rows) < SELECT_PAGE:
            break
        offset += SELECT_PAGE
    return known


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

PUBLISHER_GROUP_MAP = {
    "DC Comics": "DC",
    "Marvel Comics": "MARVEL",
}


def _publisher_group(name: str) -> str:
    return PUBLISHER_GROUP_MAP.get(name, "OTROS")


def _add_months(d: date, n: int) -> date:
    m = d.month + n
    y = d.year + (m - 1) // 12
    m = ((m - 1) % 12) + 1
    return d.replace(year=y, month=m, day=1)


def upsert_all(db: Client, issues: list[dict]) -> int:
    if not issues:
        return 0

    synced_at = datetime.now(timezone.utc).isoformat()

    # 1. Publishers — upsert por name (publisher_id lo asigna Postgres automáticamente)
    pub_names = list({i["publisher_name"] for i in issues if i["publisher_name"]})
    pub_rows = [{"name": n, "publisher_group": _publisher_group(n)} for n in pub_names]
    if pub_rows:
        db.table("publishers").upsert(pub_rows, on_conflict="name").execute()

    # Leer IDs asignados para usarlos al insertar series
    pub_result = (
        db.table("publishers")
        .select("publisher_id, name")
        .in_("name", pub_names)
        .execute()
    )
    publisher_id_map: dict[str, int] = {
        row["name"]: row["publisher_id"] for row in pub_result.data
    }

    # 2. Series — upsert por series_id (real de LoCG o sintético negativo)
    series_seen: dict[int, dict] = {}
    for i in issues:
        sid = i["series_id"]
        if sid is None or sid in series_seen:
            continue
        pub_id = publisher_id_map.get(i["publisher_name"])
        series_seen[sid] = {
            "series_id": sid,
            "name": i["series_name"],
            "publisher_id": pub_id,
            "source": "locg",
        }
    if series_seen:
        _batch_upsert(db, "series", list(series_seen.values()), "series_id")

    # 3. Releases — upsert por issue_id en lotes para evitar payload excesivo
    releases = [
        {
            "issue_id": i["issue_id"],
            "series_id": i["series_id"],
            "issue_number": i["issue_number"],
            "release_date": i["release_date"],
            "cover_url": i["cover_url"],
            "price": i["price"],
            "issue_type": i.get("issue_type", "Regular Issue"),
            "synced_at": synced_at,
        }
        for i in issues
        if i["series_id"] is not None and i["release_date"]
    ]
    print(f"  Upserting {len(releases)} releases in batches of {UPSERT_BATCH}...", flush=True)
    if releases:
        _batch_upsert(db, "releases", releases, "issue_id")

    # 4. Poda: borrar releases fuera de la ventana ±3 meses
    today = date.today()
    window_start = _add_months(today, -WINDOW_MONTHS)
    window_end_cutoff = _add_months(today, WINDOW_MONTHS + 1)

    db.table("releases").delete().lt("release_date", str(window_start)).execute()
    db.table("releases").delete().gte("release_date", str(window_end_cutoff)).execute()

    # 5. Refresco de pulls en ventana — solo toca fecha/portada/número, nunca format/status.
    # pulls es una tabla pequeña (selección personal): la leemos entera y filtramos en
    # Python. Antes se hacía un in_(miles de ids) que generaba una URL gigante y un
    # 400 Bad Request del servidor.
    in_window = {
        i["issue_id"]: i for i in issues
        if i["release_date"]
        and window_start <= date.fromisoformat(i["release_date"]) < window_end_cutoff
    }
    if in_window:
        offset = 0
        while True:
            pulls = (
                db.table("pulls")
                .select("id, issue_id")
                .range(offset, offset + SELECT_PAGE - 1)
                .execute()
                .data
            )
            if not pulls:
                break
            for pull in pulls:
                fresh = in_window.get(pull["issue_id"])
                if not fresh:
                    continue
                db.table("pulls").update({
                    "release_date": fresh["release_date"],
                    "cover_url": fresh["cover_url"],
                    "issue_number": fresh["issue_number"],
                }).eq("id", pull["id"]).execute()
            if len(pulls) < SELECT_PAGE:
                break
            offset += SELECT_PAGE

    return len(releases)
