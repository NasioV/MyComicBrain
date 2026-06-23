ALTER TABLE releases ADD COLUMN IF NOT EXISTS issue_type text DEFAULT 'Regular Issue';
