-- =====================================================================
-- 002 – Custom columns (Monday-style) for the table view
-- Run once in Supabase → SQL Editor. Safe to run more than once.
-- =====================================================================

-- Values of custom columns live on the task as JSON: { "<field_id>": value }
alter table public.tasks add column if not exists custom jsonb not null default '{}'::jsonb;

-- Column definitions per project
create table if not exists public.project_fields (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  type        text not null check (type in ('text','number','date','select','person','checkbox','link')),
  options     jsonb not null default '[]'::jsonb,   -- for 'select': [{ "id": "...", "label": "...", "color": "#..." }]
  position    double precision not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists project_fields_project_idx on public.project_fields (project_id);

alter table public.project_fields enable row level security;
drop policy if exists fields_all on public.project_fields;
create policy fields_all on public.project_fields for all
  using (public.is_member(project_id)) with check (public.is_member(project_id));

do $$
begin
  alter publication supabase_realtime add table public.project_fields;
exception when duplicate_object then null;
end $$;

-- Set one custom value without overwriting other columns edited concurrently.
-- Runs as the caller, so RLS on tasks still applies.
create or replace function public.set_task_field(p_task uuid, p_field uuid, p_value jsonb)
returns jsonb language sql security invoker set search_path = public as $$
  update tasks
     set custom = case when p_value is null or p_value = 'null'::jsonb
                       then custom - p_field::text
                       else custom || jsonb_build_object(p_field::text, p_value) end
   where id = p_task
  returning custom;
$$;
