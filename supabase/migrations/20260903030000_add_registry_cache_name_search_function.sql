-- The "All Companies" search box times out unpredictably on some terms
-- (reported live against 'saab' -- reproduced directly: even a one-off,
-- non-prepared `WHERE name ILIKE '%x%' ORDER BY registered_at LIMIT n`
-- sometimes has Postgres scan the registered_at index and check the ILIKE
-- condition row by row instead of using the name trigram index, betting it
-- can find n matches quickly. For a broad term that gamble pays off; for a
-- rare, unevenly-dated term like 'saab' it can mean scanning most of the
-- table before finding 51 matches. Ordering by `name` instead just moves
-- the same gamble onto the name btree index -- confirmed 'bygg' still
-- picks the wrong plan that way (123ms and climbing with data volume,
-- not the ~0.2ms a trigram scan takes).
--
-- Fix: force the ILIKE filter to run to completion via the trigram index
-- FIRST (a `MATERIALIZED` CTE is a real optimization fence, unlike a plain
-- subquery Postgres is free to reorder), before ordering. Only carries
-- (org_number, registered_at) through the fence, not full rows -- full rows
-- for a broad term like 'ab' (750k+ matches) would otherwise mean
-- materializing three seconds worth of text/jsonb payloads just to sort and
-- throw away all but 51 of them.
--
-- Scoped to name search only. The no-filter browse case already goes
-- straight through the registered_at index with nothing to fight it, and
-- shouldn't pay this fence's cost for no reason.
create or replace function search_registry_cache_by_name(p_pattern text, p_limit int, p_offset int)
returns setof company_registry_cache
language sql stable security invoker as $$
  with matched as materialized (
    select org_number, registered_at
    from company_registry_cache
    where name ilike p_pattern
  ),
  page as (
    select org_number
    from matched
    order by registered_at desc nulls last
    offset p_offset
    limit p_limit
  )
  select c.*
  from company_registry_cache c
  join page p on p.org_number = c.org_number
  order by c.registered_at desc nulls last;
$$;

grant execute on function search_registry_cache_by_name(text, int, int) to authenticated;
