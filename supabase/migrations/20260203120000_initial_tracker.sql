-- Task tracker: schema, RLS, realtime, storage bucket hookup
-- Выполните ВЕСЬ файл целиком в Supabase → SQL Editor (если таблиц ещё нет — так создадутся).
-- Проекты «публичные» для всех авторизованных пользователей (см. политики RLS ниже).
-- Run in Supabase SQL Editor or via CLI: supabase db push

-- Extensions
create extension if not exists "pgcrypto";

-- Profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  deadline date,
  position int not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  milestone_id uuid references public.milestones (id) on delete set null,
  title text not null,
  description text,
  status text not null default 'В работе',
  priority text not null default 'medium',
  assignee_id uuid references public.profiles (id) on delete set null,
  assignee_name text,
  start_date date not null,
  due_date date not null,
  is_completed boolean not null default false,
  created_by uuid references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  predecessor_task_id uuid not null references public.tasks (id) on delete cascade,
  successor_task_id uuid not null references public.tasks (id) on delete cascade,
  dependency_type text not null default 'finish_start',
  unique (successor_task_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_url text,
  mime_type text,
  size bigint not null default 0,
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- updated_at triggers
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tr_projects_updated on public.projects;
create trigger tr_projects_updated before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists tr_milestones_updated on public.milestones;
create trigger tr_milestones_updated before update on public.milestones
  for each row execute function public.set_updated_at();

drop trigger if exists tr_tasks_updated on public.tasks;
create trigger tr_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();

-- New project → add creator to project_members
create or replace function public.add_project_creator_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_members (project_id, user_id)
  values (new.id, new.created_by)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists tr_projects_member on public.projects;
create trigger tr_projects_member after insert on public.projects
  for each row execute function public.add_project_creator_member();

-- New auth user → profile row
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Align is_completed with status (optional consistency)
create or replace function public.sync_task_completed()
returns trigger language plpgsql as $$
begin
  new.is_completed := (new.status = 'Готово');
  return new;
end;
$$;

drop trigger if exists tr_tasks_completed on public.tasks;
create trigger tr_tasks_completed before insert or update on public.tasks
  for each row execute function public.sync_task_completed();

-- RLS
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.milestones enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.comments enable row level security;
alter table public.attachments enable row level security;

-- RLS: общее рабочее пространство — любой авторизованный видит все проекты и данные.
-- Создать проект может любой (created_by = auth.uid()).

drop policy if exists "profiles_select_auth" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "projects_select_member" on public.projects;
drop policy if exists "projects_select_creator" on public.projects;
drop policy if exists "projects_insert_self" on public.projects;
drop policy if exists "projects_insert_own" on public.projects;
drop policy if exists "projects_insert_logged" on public.projects;
drop policy if exists "projects_update_member" on public.projects;
drop policy if exists "projects_update_all" on public.projects;
drop policy if exists "projects_delete_member" on public.projects;
drop policy if exists "projects_delete_all" on public.projects;
drop policy if exists "projects_select_all" on public.projects;
drop policy if exists "pm_select" on public.project_members;
drop policy if exists "pm_insert" on public.project_members;
drop policy if exists "pm_select_all" on public.project_members;
drop policy if exists "pm_insert_all" on public.project_members;
drop policy if exists "project_members_all" on public.project_members;
drop policy if exists "milestones_all" on public.milestones;
drop policy if exists "tasks_all" on public.tasks;
drop policy if exists "deps_all" on public.task_dependencies;
drop policy if exists "comments_all" on public.comments;
drop policy if exists "attachments_all" on public.attachments;

create policy "profiles_select_auth" on public.profiles for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "projects_select_all" on public.projects for select to authenticated using (true);
create policy "projects_insert_own" on public.projects for insert to authenticated with check (created_by = auth.uid());
create policy "projects_update_all" on public.projects for update to authenticated using (true) with check (true);
create policy "projects_delete_all" on public.projects for delete to authenticated using (true);

create policy "project_members_all" on public.project_members for all to authenticated using (true) with check (true);

create policy "milestones_all" on public.milestones for all to authenticated using (true) with check (true);
create policy "tasks_all" on public.tasks for all to authenticated using (true) with check (true);
create policy "deps_all" on public.task_dependencies for all to authenticated using (true) with check (true);
create policy "comments_all" on public.comments for all to authenticated using (true) with check (true);
create policy "attachments_all" on public.attachments for all to authenticated using (true) with check (true);

-- Realtime: включите таблицы в Dashboard → Database → Replication,
-- или раскомментируйте (может выдать ошибку, если таблица уже в publication):
-- alter publication supabase_realtime add table public.projects;
-- alter publication supabase_realtime add table public.milestones;
-- alter publication supabase_realtime add table public.tasks;
-- alter publication supabase_realtime add table public.task_dependencies;
-- alter publication supabase_realtime add table public.comments;
-- alter publication supabase_realtime add table public.attachments;

-- Storage bucket (create in Dashboard if this fails on older projects)
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', true)
on conflict (id) do nothing;

drop policy if exists "storage_task_attach_read" on storage.objects;
create policy "storage_task_attach_read" on storage.objects for select to authenticated using (bucket_id = 'task-attachments');

drop policy if exists "storage_task_attach_write" on storage.objects;
create policy "storage_task_attach_write" on storage.objects for insert to authenticated with check (bucket_id = 'task-attachments');

drop policy if exists "storage_task_attach_update" on storage.objects;
create policy "storage_task_attach_update" on storage.objects for update to authenticated using (bucket_id = 'task-attachments');

drop policy if exists "storage_task_attach_delete" on storage.objects;
create policy "storage_task_attach_delete" on storage.objects for delete to authenticated using (bucket_id = 'task-attachments');
