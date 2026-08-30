-- ============================================================================
-- Extend company + company_registry_cache with fields the Bolagsverket
-- "värdefulla datamängder" API supports and that matter for a sponsorship
-- CRM: active status, ongoing liquidation, marketing-contact opt-out,
-- deregistration, and registration date. See plan "Column decision" for the
-- full relevant/irrelevant breakdown.
--
-- Also fixes company.company_form's check constraint, which only allowed
-- ('AB','KB','EF','none','other') — real Bolagsverket data includes HB, EK,
-- BRF, E, none of which matched, so any non-AB company insert would have
-- been rejected.
-- ============================================================================

alter table company
  add column is_active            boolean,
  add column in_liquidation       boolean not null default false,
  add column no_marketing         boolean,
  add column deregistered_at      timestamptz,
  add column deregistration_reason text,
  add column registered_at        date,
  add column description          text;

-- company_registry_cache never had city/zip/industry_label — only a single
-- `address` field and raw sni_code, unlike `company`. Adding them here too so
-- a cache-only (tier 2, not yet added by this tenant) result can be displayed
-- without parsing the raw blob.
alter table company_registry_cache
  add column city                 text,
  add column zip                  text,
  add column industry_label       text,
  add column is_active            boolean,
  add column in_liquidation       boolean not null default false,
  add column no_marketing         boolean,
  add column deregistered_at      timestamptz,
  add column deregistration_reason text,
  add column registered_at        date,
  add column raw                  jsonb;

alter table company drop constraint company_company_form_check;
alter table company add constraint company_company_form_check
  check (company_form in ('AB','HB','KB','EK','BRF','E','none','other'));
