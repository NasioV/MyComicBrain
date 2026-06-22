-- Permit authenticated users to insert and update manual series
-- (source = 'manual' check prevents touching locg-sourced rows)
CREATE POLICY "series_insert" ON series
  FOR INSERT TO authenticated
  WITH CHECK (source = 'manual');

CREATE POLICY "series_update" ON series
  FOR UPDATE TO authenticated
  USING (source = 'manual');
