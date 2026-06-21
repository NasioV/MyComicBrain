import sys
from datetime import datetime, timezone

from dotenv import load_dotenv

from fetcher import fetch_window
from supabase_client import get_client
from upserter import upsert_all


def _log_sync(db, status: str, count: int = 0, message: str = None):
    db.table("sync_log").insert({
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "message": message,
        "releases_upserted": count,
    }).execute()


def main():
    load_dotenv()
    db = get_client()

    try:
        print("Fetching releases from League of Comic Geeks...")
        issues = fetch_window()
        print(f"Fetched {len(issues)} issues. Writing to Supabase...")

        count = upsert_all(db, issues)
        _log_sync(db, "ok", count=count)
        print(f"Done. {count} releases upserted.")

    except Exception as e:
        _log_sync(db, "error", message=str(e))
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
