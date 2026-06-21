import os
import time
from datetime import date, datetime, timedelta

from curl_cffi import requests as curl_requests
from comicgeeks import Comic_Geeks
from comicgeeks.extract import extract as parse_title

WINDOW_MONTHS = 3
REQUEST_DELAY = 1.5  # seconds between calls — be polite to LoCG


class _LoCGClient(Comic_Geeks):
    """Usa curl-cffi con impersonación de Chrome para evitar el bloqueo de Cloudflare.

    La librería requests estándar expone un fingerprint TLS que Cloudflare detecta
    y bloquea desde IPs de datacenter (GitHub Actions). curl-cffi replica el
    fingerprint TLS exacto de Chrome, pasando la detección desde cualquier IP.
    También omite la validación de home page de comicgeeks (que haría un GET
    innecesario a leagueofcomicgeeks.com/).
    """

    def __init__(self, ci_session: str):
        self._session = curl_requests.Session(impersonate="chrome124")
        self._session.headers.update({
            "Cookie": f"ci_session={ci_session}",
        })
        self._session.authenticated = True


def _add_months(d: date, n: int) -> date:
    m = d.month + n
    y = d.year + (m - 1) // 12
    m = ((m - 1) % 12) + 1
    return d.replace(year=y, month=m, day=1)


def _week_dates_in_window() -> list[datetime]:
    today = date.today()
    start = _add_months(today, -WINDOW_MONTHS)
    end = _add_months(today, WINDOW_MONTHS)

    weeks = []
    current = start
    while current <= end:
        weeks.append(datetime(current.year, current.month, current.day))
        current += timedelta(weeks=1)
    return weeks


def _parse_date(raw) -> str | None:
    if raw is None:
        return None
    try:
        if isinstance(raw, int):
            return date.fromtimestamp(raw).isoformat()
        s = str(raw).strip()
        if s.isdigit():
            return date.fromtimestamp(int(s)).isoformat()
        return str(datetime.strptime(s, "%Y-%m-%d").date())
    except Exception:
        return None


def _cover_url(cover) -> str | None:
    if cover is None:
        return None
    if isinstance(cover, str):
        return cover
    if isinstance(cover, dict):
        return cover.get("image") or cover.get("url")
    return None


def fetch_window() -> list[dict]:
    client = _LoCGClient(os.environ["LOCG_CI_SESSION"])

    seen_ids: set[int] = set()
    # cache: "series_name|publisher_name" (lowercase) -> series_id from LoCG
    series_cache: dict[str, int | None] = {}
    issues: list[dict] = []

    for week_dt in _week_dates_in_window():
        week_releases = client.new_releases(date=week_dt)
        time.sleep(REQUEST_DELAY)

        for issue in week_releases:
            if issue.issue_id in seen_ids:
                continue
            seen_ids.add(issue.issue_id)

            full_title = issue.name or ""
            publisher_name = (issue.publisher or "").strip()
            series_name, issue_number, _ = parse_title(full_title)
            series_name = series_name.strip()

            cache_key = f"{series_name}|{publisher_name}".lower()
            description = None

            if cache_key not in series_cache:
                # One extra call per new series to get series_id and description
                try:
                    full = client.issue_info(issue.issue_id)
                    pagination = full.series_pagination  # triggers _get_data()
                    series_obj = pagination.get("series") if isinstance(pagination, dict) else None
                    series_cache[cache_key] = series_obj.series_id if series_obj else None
                    description = full.description
                except Exception as e:
                    print(f"  Warning: could not get series_id for '{series_name}': {e}")
                    series_cache[cache_key] = None
                time.sleep(REQUEST_DELAY)

            issues.append({
                "issue_id": issue.issue_id,
                "series_id": series_cache.get(cache_key),
                "series_name": series_name,
                "publisher_name": publisher_name,
                "issue_number": issue_number or "",
                "release_date": _parse_date(issue.store_date),
                "cover_url": _cover_url(issue.cover),
                "price": str(issue.price) if issue.price not in (None, "Unknown") else None,
                "description": description,
            })

    return issues
