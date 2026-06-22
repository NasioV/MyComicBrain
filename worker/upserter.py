from datetime import date, datetime, timezone

from supabase import Client

WINDOW_MONTHS = 3
UPSERT_BATCH = 200


def _batch_upsert(db: Client, table: str, rows: list[dict], on_conflict: str) -> None:
    for i in range(0, len(rows), UPSERT_BATCH):
        db.table(table).upsert(rows[i:i + UPSERT_BATCH], on_conflict=on_conflict).execute()

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
            "description": i["description"],
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

    # 5. Refresco de pulls en ventana — solo toca fecha/portada/número, nunca format/status
    in_window = {
        i["issue_id"]: i for i in issues
        if i["release_date"]
        and window_start <= date.fromisoformat(i["release_date"]) < window_end_cutoff
    }
    if in_window:
        pulls = (
            db.table("pulls")
            .select("id, issue_id")
            .in_("issue_id", list(in_window.keys()))
            .execute()
        )
        for pull in pulls.data:
            fresh = in_window[pull["issue_id"]]
            db.table("pulls").update({
                "release_date": fresh["release_date"],
                "cover_url": fresh["cover_url"],
                "issue_number": fresh["issue_number"],
            }).eq("id", pull["id"]).execute()

    return len(releases)
