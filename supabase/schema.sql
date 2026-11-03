-- =====================================================================
-- Mesimot – task manager schema (Supabase / Postgres)
-- Projects ▸ Buckets ▸ Tasks ▸ Checklist, with members & email invites.
-- Every table is protected by Row Level Security: a user sees only the
-- projects they are a member of.
-- Safe to run more than once.
-- =====================================================================

-- ---------- Profiles (one per auth user) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_email_idx on public.profiles (lower(email));

-- ---------- Projects ----------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  color        text not null default '#2563eb',
  archived     boolean not null default false,
  created_by   uuid not null default auth.uid() references public.profiles(id),
  created_at   timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner','member')),
  joined_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.project_invites (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('owner','member')),
  invited_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (project_id, email)
);

-- ---------- Board ----------
create table if not exists public.buckets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  position    double precision not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists buckets_project_idx on public.buckets (project_id);

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  bucket_id     uuid references public.buckets(id) on delete set null,
  title         text not null,
  description   text,
  status        text not null default 'todo'
                check (status in ('todo','in_progress','waiting','done')),
  priority      text not null default 'medium'
                check (priority in ('low','medium','high','urgent')),
  due_date      date,
  assignee_id   uuid references public.profiles(id) on delete set null,
  position      double precision not null default 0,
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists tasks_project_idx  on public.tasks (project_id);
create index if not exists tasks_assignee_idx on public.tasks (assignee_id);

create table if not exists public.checklist_items (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  text        text not null,
  done        boolean not null default false,
  position    double precision not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists checklist_task_idx on public.checklist_items (task_id);

-- =====================================================================
-- Helper functions (security definer → no RLS recursion)
-- =====================================================================
create or replace function public.is_member(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members where project_id = p and user_id = auth.uid());
$$;

create or replace function public.is_owner(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members
                 where project_id = p and user_id = auth.uid() and role = 'owner');
$$;

create or replace function public.shares_project(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members a
    join project_members b on a.project_id = b.project_id
    where a.user_id = auth.uid() and b.user_id = other);
$$;

-- =====================================================================
-- Triggers
-- =====================================================================

-- New auth user → profile, and turn any pending invites into memberships
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, avatar_url)
  values (new.id, lower(new.email),
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
          new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;

  insert into project_members (project_id, user_id, role)
  select project_id, new.id, role from project_invites where lower(email) = lower(new.email)
  on conflict do nothing;
  delete from project_invites where lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- New project → creator becomes owner + default buckets
create or replace function public.handle_new_project()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'owner') on conflict do nothing;
  insert into buckets (project_id, name, position) values
    (new.id, 'לעשות', 1000), (new.id, 'בתהליך', 2000), (new.id, 'ממתין', 3000);
  return new;
end $$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created after insert on public.projects
  for each row execute function public.handle_new_project();

-- Keep updated_at / completed_at in sync
create or replace function public.touch_task()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.completed_at := now();
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_task();

-- =====================================================================
-- RPCs
-- =====================================================================

-- Invite by email: adds directly if the person already has an account,
-- otherwise stores a pending invite that is claimed on first sign-in.
create or replace function public.invite_member(p_project uuid, p_email text, p_role text default 'member')
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not is_owner(p_project) then raise exception 'only project owners can invite'; end if;
  select id into uid from profiles where lower(email) = lower(trim(p_email));
  if uid is not null then
    insert into project_members (project_id, user_id, role)
    values (p_project, uid, p_role) on conflict do nothing;
    return 'added';
  end if;
  insert into project_invites (project_id, email, role)
  values (p_project, lower(trim(p_email)), p_role)
  on conflict (project_id, email) do nothing;
  return 'invited';
end $$;

-- Safety net: claim invites for the signed-in user (called on every login)
create or replace function public.claim_invites()
returns int language plpgsql security definer set search_path = public as $$
declare my_email text; n int;
begin
  select lower(email) into my_email from auth.users where id = auth.uid();
  insert into profiles (id, email) values (auth.uid(), my_email) on conflict (id) do nothing;
  insert into project_members (project_id, user_id, role)
  select project_id, auth.uid(), role from project_invites where lower(email) = my_email
  on conflict do nothing;
  get diagnostics n = row_count;
  delete from project_invites where lower(email) = my_email;
  return n;
end $$;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.project_members  enable row level security;
alter table public.project_invites  enable row level security;
alter table public.buckets          enable row level security;
alter table public.tasks            enable row level security;
alter table public.checklist_items  enable row level security;

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.shares_project(id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid());

-- projects
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select
  using (public.is_member(id) or created_by = auth.uid());
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert with check (created_by = auth.uid());
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update using (public.is_member(id));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete using (public.is_owner(id));

-- members: everyone in the project sees the list; owners manage; anyone may leave
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members for select using (public.is_member(project_id));
drop policy if exists members_update on public.project_members;
create policy members_update on public.project_members for update using (public.is_owner(project_id));
drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members for delete
  using (public.is_owner(project_id) or user_id = auth.uid());

-- invites (created via invite_member RPC)
drop policy if exists invites_select on public.project_invites;
create policy invites_select on public.project_invites for select using (public.is_member(project_id));
drop policy if exists invites_delete on public.project_invites;
create policy invites_delete on public.project_invites for delete using (public.is_owner(project_id));

-- buckets / tasks: full access for project members
drop policy if exists buckets_all on public.buckets;
create policy buckets_all on public.buckets for all
  using (public.is_member(project_id)) with check (public.is_member(project_id));
drop policy if exists tasks_all on public.tasks;
create policy tasks_all on public.tasks for all
  using (public.is_member(project_id)) with check (public.is_member(project_id));

-- checklist: through the parent task
drop policy if exists checklist_all on public.checklist_items;
create policy checklist_all on public.checklist_items for all
  using (exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id)))
  with check (exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id)));

-- =====================================================================
-- Realtime (live updates between partners)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['tasks','buckets','checklist_items','project_members','projects'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
