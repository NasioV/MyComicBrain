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

# None = fetch all publishers
ALLOWED_PUBLISHERS: frozenset[str] | None = None

_FORMAT_ID_MAP = {
    "1": "Regular Issue",
    "2": "Annual",
    "3": "Trade Paperback",
    "4": "Hardcover",
    "5": "Omnibus",
    "6": "Variant & Reprint",
}


def _detect_issue_type(comic, name: str) -> str:
    """Detect format type from the HTML <li> element or fall back to name parsing."""
    # Check data attributes
    for attr in ("data-format-id", "data-format", "data-type"):
        val = comic.get(attr)
        if val:
            return _FORMAT_ID_MAP.get(str(val), "Regular Issue")

    # Check CSS classes (format-1, format-2, …)
    for cls in comic.get("class", []):
        if cls.startswith("format-"):
            fid = cls[len("format-"):]
            if fid in _FORMAT_ID_MAP:
                return _FORMAT_ID_MAP[fid]

    # Name-based fallback
    n = name.lower()
    if "annual" in n:
        return "Annual"
    if "omnibus" in n:
        return "Omnibus"
    if any(x in n for x in ("hardcover", " hc ", " hc:", ":hc")):
        return "Hardcover"
    if any(x in n for x in ("trade paperback", " tpb", " tp ", "vol.")):
        return "Trade Paperback"
    if any(x in n for x in ("facsimile", "variant", "director's cut", "ratio", "reprint")):
        return "Variant & Reprint"
    return "Regular Issue"


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

    def new_releases(self, date: datetime = "now") -> list:  # type: ignore[override]
        """Fetch all formats and attach _issue_type to each Issue."""
        if date == "now":
            date = datetime.now()
        date_str = f"{date.month}/{date.day}/{date.year}"

        # Include all known formats (1=Regular, 2=Annual, 3=TPB, 4=HC, 5=Omnibus, 6=Variant)
        url = (
            "https://leagueofcomicgeeks.com/comic/get_comics"
            f"?list=releases&view=thumbs&format[]=1%2C2%2C3%2C4%2C5%2C6"
            f"&date_type=week&date={date_str}&order=pulls"
        )
        r = self._session.get(url).json()
        if r["count"] == 0:
            return []

        soup = BeautifulSoup(r["list"], features="lxml")
        content = soup.find(id="comic-list-block")
        comics = content.find_all("li")
        data = []
        for comic in comics:
            a = comic.find("a")
            if not a:
                continue
            price_el = comic.find(class_="price")
            price = (
                float(price_el.text.split("·")[1].strip()[1:])
                if price_el else "Unknown"
            )
            name = comic.find(class_="title").text.strip()
            issue_id = int(a["href"].split("/")[2])
            date_el = comic.find(class_="date")
            store_date = date_el["data-date"] if date_el else None
            publisher_el = comic.find(class_="publisher")
            publisher = publisher_el.text.strip() if publisher_el else ""
            img_el = comic.find("img")
            cover = img_el["data-src"] if img_el else None
            community = {
                "rating": comic.get("data-community", 0),
                "pull": comic.get("data-pulls", 0),
            }

            issue = Issue(issue_id=issue_id, session=self._session)
            issue.name = name
            issue.url = a["href"]
            issue.store_date = store_date
            issue.price = price
            issue.publisher = publisher
            issue.cover = cover
            issue.community = community
            issue._issue_type = _detect_issue_type(comic, name)
            data.append(issue)
        return data


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
    """ID negativo estable para series donde no se puede obtener el ID de LoCG.

    Negativo para no colisionar nunca con IDs positivos reales de LoCG.
    Determinista: el mismo nombre+editorial siempre da el mismo ID.
    """
    raw = f"{series_name}|{publisher_name}".lower().encode()
    return -(int(hashlib.sha256(raw).hexdigest(), 16) % (2 ** 52))


def fetch_window() -> list[dict]:
    client = _LoCGClient(os.environ["LOCG_CI_SESSION"])

    seen_ids: set[int] = set()
    series_cache: dict[str, int] = {}
    issues: list[dict] = []

    week_dates = _week_dates_in_window()
    print(f"  Fetching {len(week_dates)} weeks...", flush=True)

    for week_dt in week_dates:
        print(f"  Week {week_dt.date()}...", flush=True)
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
                    print(f"  Warning: no series_id for '{series_name}' ({publisher_name}): {e}", flush=True)
                    series_cache[cache_key] = _synthetic_series_id(series_name, publisher_name)
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
