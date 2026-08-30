-- ============================================================================
-- Distinguishes manually-entered companies (editable) from ones populated
-- from Bolagsverket via the registry (read-only company info — the registry
-- cache is the source of truth for those, editing a local copy would just
-- silently diverge from it). org_number nullability alone isn't a reliable
-- signal for this: a manual entry can still have a known real org number.
-- ============================================================================

alter table company add column is_manual boolean not null default false;
