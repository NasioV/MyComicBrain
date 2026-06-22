import hashlib
import os
import time
import requests
from datetime import date, datetime, timedelta

from bs4 import BeautifulSoup
from comicgeeks import Comic_Geeks
from comicgeeks.classes import Issue
from comicgeeks.extract import extract as parse_title

WINDOW_MONTHS = 3
REQUEST_DELAY = 1.5  # seconds between calls — be polite to LoCG

# Set to None to fetch all publishers; restrict here to keep runs fast
ALLOWED_PUBLISHERS: frozenset[str] | None = frozenset({
    "DC Comics",
    "Marvel Comics",
    "Image Comics",
})

# LoCG format IDs (confirmed from their filter HTML)
# Fetched as separate requests so each issue is tagged directly.
# Digital Chapters (5) excluded — not relevant for a pull list.
LOCG_FORMATS = [
    ("1", "Regular Issue"),
    ("6", "Annual"),
    ("2", "Variant & Reprint"),
    ("3", "Trade Paperback"),
    ("4", "Hardcover"),
]


class _LoCGClient(Comic_Geeks):
    """Omite la validación de sesión con la home page de LoCG."""

    def __init__(self, ci_session: str):
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        })
        self._session.authenticated = True
        self._session.cookies.set(
            "ci_session", ci_session,
            domain="leagueofcomicgeeks.com", path="/",
        )

    def _fetch_releases_page(self, date_str: str, format_id: str) -> list[Issue]:
        """Un request: todos los releases de un formato para una semana."""
        url = (
            "https://leagueofcomicgeeks.com/comic/get_comics"
            f"?list=releases&view=thumbs&format[]={format_id}"
            f"&date_type=week&date={date_str}&order=pulls"
        )
        r = self._session.get(url).json()
        if r["count"] == 0:
            return []

        soup = BeautifulSoup(r["list"], features="lxml")
        content = soup.find(id="comic-list-block")
        if not content:
            return []

        issues = []
        for comic in content.find_all("li"):
            a = comic.find("a")
            if not a:
                continue
            price_el = comic.find(class_="price")
            price = (
                float(price_el.text.split("·")[1].strip()[1:])
                if price_el and "·" in price_el.text
                else "Unknown"
            )
            name_el = comic.find(class_="title")
            date_el = comic.find(class_="date")
            pub_el = comic.find(class_="publisher")
            img_el = comic.find("img")

            issue = Issue(issue_id=int(a["href"].split("/")[2]), session=self._session)
            issue.name = name_el.text.strip() if name_el else ""
            issue.url = a["href"]
            issue.store_date = date_el["data-date"] if date_el else None
            issue.price = price
            issue.publisher = pub_el.text.strip() if pub_el else ""
            issue.cover = img_el["data-src"] if img_el else None
            issue.community = {
                "rating": comic.get("data-community", 0),
                "pull": comic.get("data-pulls", 0),
            }
            issues.append(issue)
        return issues

    def new_releases(self, date: datetime = "now") -> list[Issue]:  # type: ignore[override]
        """Fetches all formats via separate requests, tagging each issue with _issue_type."""
        if date == "now":
            date = datetime.now()
        date_str = f"{date.month}/{date.day}/{date.year}"

        all_issues: list[Issue] = []
        seen_ids: set[int] = set()

        for format_id, issue_type in LOCG_FORMATS:
            page = self._fetch_releases_page(date_str, format_id)
            for issue in page:
                if issue.issue_id not in seen_ids:
                    seen_ids.add(issue.issue_id)
                    issue._issue_type = issue_type
                    all_issues.append(issue)
            time.sleep(REQUEST_DELAY)

        return all_issues


def _add_months(d: date, n: int) -> date:
    m = d.month + n
    y = d.year + (m - 1) // 12
    m = ((m - 1) % 12) + 1
    return d.replace(year=y, month=m, day=1)


def _week_dates_in_window() -> list[datetime]:
    today = date.today()
    start = _add_months(today, -WINDOW_MONTHS)
    # Last day of the month WINDOW_MONTHS ahead (not just the 1st)
    end = _add_months(today, WINDOW_MONTHS + 1) - timedelta(days=1)

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


def _synthetic_series_id(series_name: str, publisher_name: str) -> int:
    """ID negativo estable para series donde no se puede obtener el ID de LoCG."""
    raw = f"{series_name}|{publisher_name}".lower().encode()
    return -(int(hashlib.sha256(raw).hexdigest(), 16) % (2 ** 52))


def fetch_window() -> list[dict]:
    client = _LoCGClient(os.environ["LOCG_CI_SESSION"])

    seen_ids: set[int] = set()
    series_cache: dict[str, int] = {}
    issues: list[dict] = []

    week_dates = _week_dates_in_window()
    print(f"  Fetching {len(week_dates)} weeks × {len(LOCG_FORMATS)} formats...", flush=True)

    for week_dt in week_dates:
        print(f"  Week {week_dt.date()}...", flush=True)
        # new_releases() already sleeps between format requests internally
        week_releases = client.new_releases(date=week_dt)
        time.sleep(REQUEST_DELAY)

        for issue in week_releases:
            if issue.issue_id in seen_ids:
                continue

            publisher_name = (issue.publisher or "").strip()

            if ALLOWED_PUBLISHERS is not None and publisher_name not in ALLOWED_PUBLISHERS:
                continue

            seen_ids.add(issue.issue_id)

            full_title = issue.name or ""
            series_name, issue_number, _ = parse_title(full_title)
            series_name = series_name.strip()

            cache_key = f"{series_name}|{publisher_name}".lower()
            description = None

            if cache_key not in series_cache:
                try:
                    full = client.issue_info(issue.issue_id)
                    pagination = full.series_pagination
                    series_obj = pagination.get("series") if isinstance(pagination, dict) else None
                    series_cache[cache_key] = series_obj.series_id if series_obj else _synthetic_series_id(series_name, publisher_name)
                    description = full.description
                except Exception as e:
                    # Casos límite del parseo de comicgeeks (TPB sin número, fechas
                    # pre-1970 en Windows...). No es pérdida de dato: se usa un
                    # series_id sintético determinista como fallback de diseño.
                    series_cache[cache_key] = _synthetic_series_id(series_name, publisher_name)
                    print(f"  Nota: series_id sintético para '{series_name}' ({publisher_name}) — issue_info no parseable ({e})", flush=True)
                time.sleep(REQUEST_DELAY)

            issues.append({
                "issue_id": issue.issue_id,
                "series_id": series_cache[cache_key],
                "series_name": series_name,
                "publisher_name": publisher_name,
                "issue_number": issue_number or "",
                "release_date": _parse_date(issue.store_date),
                "cover_url": _cover_url(issue.cover),
                "price": str(issue.price) if issue.price not in (None, "Unknown") else None,
                "description": description,
                "issue_type": getattr(issue, "_issue_type", "Regular Issue"),
            })

    return issues
