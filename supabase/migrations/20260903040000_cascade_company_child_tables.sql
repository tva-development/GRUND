-- Removing a company from "My Companies" (removeCompany, a plain DELETE on
-- `company`) failed outright once it had any interaction history --
-- interaction/note/task/cooldown_override all reference company(id) with no
-- ON DELETE action, so Postgres blocked the delete with a foreign key
-- violation. Reproduced directly: any company with a real (committed)
-- cooldown has at least one interaction row, so this hit every such company.
--
-- These four are detail records of one specific company, not independent
-- data with meaning of their own once that company is no longer tracked --
-- company_tag already cascades for the same reason (see the initial
-- migration). Cascading here matches that.
alter table interaction drop constraint interaction_company_id_fkey,
  add constraint interaction_company_id_fkey foreign key (company_id) references company(id) on delete cascade;

alter table note drop constraint note_company_id_fkey,
  add constraint note_company_id_fkey foreign key (company_id) references company(id) on delete cascade;

alter table task drop constraint task_company_id_fkey,
  add constraint task_company_id_fkey foreign key (company_id) references company(id) on delete cascade;

alter table cooldown_override drop constraint cooldown_override_company_id_fkey,
  add constraint cooldown_override_company_id_fkey foreign key (company_id) references company(id) on delete cascade;
