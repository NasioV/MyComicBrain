import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from fetcher import fetch_window


def _log_sync(db, status: str, count: int = 0, message: str = None):
    db.table("sync_log").insert({
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "message": message,
        "releases_upserted": count,
    }).execute()


def dry_run():
    """Prueba local sin BD: solo DC, mes actual. Valida la conexión y el parseo."""
    today = date.today()
    start = today.replace(day=1)
    end = (start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    issues = fetch_window(publishers={2: "DC Comics"}, start=start, end=end)
    print(f"\n{len(issues)} números. Tipos: {dict(Counter(i['issue_type'] for i in issues))}")
    print(f"Con portada: {sum(1 for i in issues if i['cover_url'])}")
    for i in issues[:8]:
        print(f"  {i['release_date']}  {i['series_name']} #{i['issue_number']}  "
              f"[{i['issue_type']} / {i['series_type']}]")


def main():
    load_dotenv()

    if "--dry-run" in sys.argv:
        dry_run()
        return

    from supabase_client import get_client
    from upserter import fetch_known_series, upsert_all

    db = get_client()
    try:
        print("Fetching releases from Metron...")
        known = fetch_known_series(db)
        print(f"  {len(known)} series con tipo ya conocido en BD.")
        issues = fetch_window(known_types=known)
        print(f"Fetched {len(issues)} issues. Writing to Supabase...")

        count = upsert_all(db, issues)
        _log_sync(db, "ok", count=count)
        print(f"Done. {count} releases upserted.")

    except Exception as e:
        import traceback
        traceback.print_exc()
        _log_sync(db, "error", message=str(e))
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
