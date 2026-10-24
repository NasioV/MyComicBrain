-- Catálogos de previews (PDF de las editoriales) → sección "Pull List".
-- Permite planificar con 2-3 meses de antelación, más allá de lo que trae Metron.

-- ── Tabla previews: números solicitados en los catálogos ─────────────────────
CREATE TABLE IF NOT EXISTS previews (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id    bigint      NOT NULL REFERENCES publishers(publisher_id),
    item_key        text        NOT NULL,   -- serie normalizada + número (evita duplicados al reimportar)
    series_name     text        NOT NULL,
    issue_number    text        NOT NULL DEFAULT '',
    title           text        NOT NULL,   -- tal cual en el catálogo
    issue_type      text        NOT NULL DEFAULT 'Regular Issue',
    release_date    date,                   -- fecha exacta si el catálogo la trae
    release_month   date        NOT NULL,   -- primer día del mes de salida
    price           numeric(8,2),
    catalog         text,                   -- nombre del PDF de origen
    imported_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (publisher_id, item_key)
);

CREATE INDEX IF NOT EXISTS previews_month_idx ON previews (release_month);

ALTER TABLE previews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "previews_read"   ON previews FOR SELECT TO authenticated USING (true);
CREATE POLICY "previews_insert" ON previews FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "previews_update" ON previews FOR UPDATE TO authenticated USING (true);
CREATE POLICY "previews_delete" ON previews FOR DELETE TO authenticated USING (true);

-- ── pulls: fecha por confirmar y origen ──────────────────────────────────────
-- date_confirmed = false: el catálogo solo daba el mes. Se guarda con día 1 para
-- que caiga en su mes, y el calendario lo muestra en "Fecha por confirmar".
ALTER TABLE pulls ADD COLUMN IF NOT EXISTS date_confirmed boolean NOT NULL DEFAULT true;

-- origin: de dónde vino el pull. Los 'preview' los enlaza el worker con Metron
-- en cuanto Metron publica ese número (portada + fecha exacta).
ALTER TABLE pulls ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'catalogo';
ALTER TABLE pulls DROP CONSTRAINT IF EXISTS pulls_origin_check;
ALTER TABLE pulls ADD CONSTRAINT pulls_origin_check
    CHECK (origin IN ('catalogo', 'manual', 'preview'));
UPDATE pulls SET origin = 'manual' WHERE issue_id IS NULL;

ALTER TABLE pulls ADD COLUMN IF NOT EXISTS preview_id uuid REFERENCES previews(id) ON DELETE SET NULL;
