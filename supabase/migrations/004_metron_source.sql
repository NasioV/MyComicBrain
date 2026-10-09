-- Migración a Metron como fuente de datos (sustituye a League of Comic Geeks).
-- Las series de Metron se guardan con source = 'metron' y su tipo
-- (Annual, Trade Paperback, Hardcover...) para no reconsultarlo en cada sync.

ALTER TABLE series DROP CONSTRAINT IF EXISTS series_source_check;
ALTER TABLE series ADD CONSTRAINT series_source_check
    CHECK (source IN ('locg', 'manual', 'metron'));
ALTER TABLE series ALTER COLUMN source SET DEFAULT 'metron';

ALTER TABLE series ADD COLUMN IF NOT EXISTS series_type text;
