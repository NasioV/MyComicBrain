"""Ingesta de lanzamientos desde la API de Metron (metron.cloud).

Metron es una base de datos comunitaria de cómics con API pública (requiere
cuenta gratuita). Sustituye a League of Comic Geeks, que dejó de ser accesible
tras poner un reto anti-bots de Cloudflare.
"""
import os
import re
import time
from datetime import date, timedelta

import requests

METRON_API = "https://metron.cloud/api"
USER_AGENT = "MyComicBrain/1.0 (personal pull list)"
REQUEST_DELAY = 3.2  # Metron permite ~20 peticiones/minuto
MAX_RETRIES = 5

WINDOW_MONTHS = 3

# Los IDs de Metron se guardan desplazados para no chocar nunca con los IDs
# antiguos de LoCG (positivos) ni con los sintéticos de las series manuales
# (negativos). Cabe de sobra en bigint y en un number de JS.
METRON_OFFSET = 1_000_000_000_000

# Editoriales a ingerir: id de Metron -> nombre canónico en nuestra BD
# (el mismo que usaba LoCG, para no duplicar filas en `publishers`).
PUBLISHERS: dict[int, str] = {
    2: "DC Comics",
    1: "Marvel Comics",
    4: "Image Comics",
    21: "Dynamite Entertainment",
    20: "BOOM! Studios",
    6: "IDW Publishing",
    197: "Ignition Press",
    31: "Oni Press",
    3: "Dark Horse Comics",
}

# Tipo de serie de Metron -> issue_type que usan los filtros de New Releases.
# Cualquier otro tipo (Ongoing, Limited Series, One-Shot...) es "Regular Issue".
SERIES_TYPE_TO_ISSUE_TYPE = {
    "Annual": "Annual",
    "Trade Paperback": "Trade Paperback",
    "Graphic Novel": "Trade Paperback",
    "Hardcover": "Hardcover",
    "Omnibus": "Hardcover",
}
# Capítulos digitales: no aplican a una pull list (igual que con LoCG).
SKIPPED_SERIES_TYPES = {"Digital Chapter"}


class MetronClient:
    def __init__(self, user: str, password: str):
        self._session = requests.Session()
        self._session.auth = (user, password)
        self._session.headers.update({"User-Agent": USER_AGENT})

    def get(self, url: str, params: dict | None = None) -> dict:
        """GET con pausa entre peticiones y reintentos ante 429 / 5xx."""
        if not url.startswith("http"):
            url = f"{METRON_API}{url}"
        for attempt in range(1, MAX_RETRIES + 1):
            r = self._session.get(url, params=params, timeout=60)
            time.sleep(REQUEST_DELAY)
            if r.status_code == 429 or r.status_code >= 500:
                wait = int(r.headers.get("Retry-After", 0)) or 30 * attempt
                print(f"  Metron {r.status_code}; reintento {attempt}/{MAX_RETRIES} en {wait}s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Metron no respondió tras {MAX_RETRIES} intentos: {url}")

    def issues(self, publisher_id: int, after: date, before: date) -> list[dict]:
        """Todos los números de una editorial en un rango de fechas de salida (paginado)."""
        data = self.get("/issue/", {
            "publisher_id": publisher_id,
            "store_date_range_after": after.isoformat(),
            "store_date_range_before": before.isoformat(),
        })
        results = list(data.get("results", []))
        while data.get("next"):
            data = self.get(data["next"])
            results.extend(data.get("results", []))
        return results

    def series_type(self, metron_series_id: int) -> str | None:
        data = self.get(f"/series/{metron_series_id}/")
        st = data.get("series_type") or {}
        return st.get("name")


def _add_months(d: date, n: int) -> date:
    m = d.month + n
    y = d.year + (m - 1) // 12
    m = ((m - 1) % 12) + 1
    return d.replace(year=y, month=m, day=1)


def window_bounds(today: date | None = None) -> tuple[date, date]:
    """Primer día del mes -3 y último día del mes +3 (meses completos)."""
    today = today or date.today()
    start = _add_months(today, -WINDOW_MONTHS)
    end = _add_months(today, WINDOW_MONTHS + 1) - timedelta(days=1)
    return start, end


# Postgres no admite NUL ni caracteres de control en columnas text.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean(s) -> str | None:
    if s is None:
        return None
    if not isinstance(s, str):
        s = str(s)
    s = s.encode("utf-8", "ignore").decode("utf-8", "ignore")
    return _CONTROL_CHARS.sub("", s).strip()


def fetch_window(
    known_types: dict[int, str] | None = None,
    publishers: dict[int, str] | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[dict]:
    """Descarga los números de la ventana para las editoriales configuradas.

    known_types: {series_id (desplazado): series_type} ya guardados en BD, para
    no volver a consultar el tipo de cada serie en cada run.
    """
    client = MetronClient(os.environ["METRON_USER"].strip(), os.environ["METRON_PASS"].strip())
    known = dict(known_types or {})
    publishers = publishers or PUBLISHERS
    if start is None or end is None:
        start, end = window_bounds()

    print(f"  Ventana {start} → {end}, {len(publishers)} editoriales", flush=True)

    issues: list[dict] = []
    reused = fetched = skipped = 0

    for pub_id, pub_name in publishers.items():
        raw = client.issues(pub_id, start, end)
        print(f"  {pub_name}: {len(raw)} números", flush=True)

        for it in raw:
            series = it.get("series") or {}
            if not series.get("id") or not it.get("store_date"):
                continue
            series_id = METRON_OFFSET + int(series["id"])

            if series_id in known:
                stype = known[series_id]
                reused += 1
            else:
                try:
                    stype = client.series_type(int(series["id"]))
                except Exception as e:
                    print(f"  Nota: sin tipo para '{series.get('name')}' ({e})", flush=True)
                    stype = None
                known[series_id] = stype
                fetched += 1

            if stype in SKIPPED_SERIES_TYPES:
                skipped += 1
                continue

            issues.append({
                "issue_id": METRON_OFFSET + int(it["id"]),
                "series_id": series_id,
                "series_name": _clean(series.get("name")),
                "series_type": stype,
                "publisher_name": pub_name,
                "issue_number": _clean(it.get("number") or ""),
                "release_date": it["store_date"],
                "cover_url": _clean(it.get("image")),
                "price": None,
                "description": None,
                "issue_type": SERIES_TYPE_TO_ISSUE_TYPE.get(stype or "", "Regular Issue"),
            })

    print(f"  Series: {reused} con tipo ya conocido, {fetched} consultadas. "
          f"Descartados {skipped} capítulos digitales.", flush=True)
    return issues
