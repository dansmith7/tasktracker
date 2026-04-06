-- Разрешить удалять пользователей из Authentication без ошибки
-- "Database error deleting user": раньше projects.created_by был NOT NULL + ON DELETE RESTRICT.
--
-- Выполните в Supabase → SQL Editor (один раз).

-- projects: создатель может обнулиться при удалении аккаунта
alter table public.projects drop constraint if exists projects_created_by_fkey;
alter table public.projects alter column created_by drop not null;
alter table public.projects
  add constraint projects_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- milestones / tasks: те же правила
alter table public.milestones drop constraint if exists milestones_created_by_fkey;
alter table public.milestones
  add constraint milestones_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table public.tasks drop constraint if exists tasks_created_by_fkey;
alter table public.tasks
  add constraint tasks_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table public.tasks drop constraint if exists tasks_updated_by_fkey;
alter table public.tasks
  add constraint tasks_updated_by_fkey
  foreign key (updated_by) references auth.users (id) on delete set null;
