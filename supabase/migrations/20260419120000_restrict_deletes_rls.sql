-- Ограничение DELETE через API (anon/authenticated): прямой DELETE разрешён только для public.tasks.
-- Остальные удаления — только через SECURITY DEFINER RPC (приложение), не через Table Editor с ключом пользователя.
-- Примечание: пользователь postgres / SQL Editor в Supabase обходит RLS; доступ к Dashboard ограничивайте отдельно.

-- --- Снять широкие политики с DELETE ---
drop policy if exists "projects_delete_all" on public.projects;
drop policy if exists "project_members_all" on public.project_members;
drop policy if exists "milestones_all" on public.milestones;
drop policy if exists "tasks_all" on public.tasks;
drop policy if exists "deps_all" on public.task_dependencies;
drop policy if exists "comments_all" on public.comments;
drop policy if exists "attachments_all" on public.attachments;

-- projects: политики select/insert/update уже заданы в 20260203120000; удалён только projects_delete_all.

-- --- project_members: без DELETE через API ---
create policy "project_members_select" on public.project_members for select to authenticated using (true);
create policy "project_members_insert" on public.project_members for insert to authenticated with check (true);
create policy "project_members_update" on public.project_members for update to authenticated using (true) with check (true);

-- --- milestones: без DELETE через API ---
create policy "milestones_select" on public.milestones for select to authenticated using (true);
create policy "milestones_insert" on public.milestones for insert to authenticated with check (true);
create policy "milestones_update" on public.milestones for update to authenticated using (true) with check (true);

-- --- tasks: единственная таблица с прямым DELETE для клиента ---
create policy "tasks_select" on public.tasks for select to authenticated using (true);
create policy "tasks_insert" on public.tasks for insert to authenticated with check (true);
create policy "tasks_update" on public.tasks for update to authenticated using (true) with check (true);
create policy "tasks_delete" on public.tasks for delete to authenticated using (true);

-- --- task_dependencies: только чтение через API; изменения через RPC ---
create policy "task_dependencies_select" on public.task_dependencies for select to authenticated using (true);

-- --- comments: INSERT; DELETE через RPC ---
create policy "comments_select" on public.comments for select to authenticated using (true);
create policy "comments_insert" on public.comments for insert to authenticated with check (true);

-- --- attachments: INSERT; DELETE через RPC ---
create policy "attachments_select" on public.attachments for select to authenticated using (true);
create policy "attachments_insert" on public.attachments for insert to authenticated with check (true);

-- --- RPC: зависимости между задачами ---
create or replace function public.replace_task_dependency(
  p_successor_task_id uuid,
  p_predecessor_task_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.task_dependencies
  where successor_task_id = p_successor_task_id;

  if p_predecessor_task_id is not null then
    insert into public.task_dependencies (predecessor_task_id, successor_task_id, dependency_type)
    values (p_predecessor_task_id, p_successor_task_id, 'finish_start');
  end if;
end;
$$;

-- --- RPC: удаление вехи (раньше client.delete) ---
create or replace function public.delete_milestone_by_id(p_milestone_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.milestones where id = p_milestone_id;
end;
$$;

-- --- RPC: удаление комментария (как раньше: любой авторизованный) ---
create or replace function public.delete_comment_by_id(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.comments where id = p_comment_id;
end;
$$;

-- --- RPC: удаление строки вложения (файл в Storage по-прежнему чистит клиент) ---
create or replace function public.delete_attachment_by_id(p_attachment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from public.attachments where id = p_attachment_id;
end;
$$;

grant execute on function public.replace_task_dependency(uuid, uuid) to authenticated;
grant execute on function public.delete_milestone_by_id(uuid) to authenticated;
grant execute on function public.delete_comment_by_id(uuid) to authenticated;
grant execute on function public.delete_attachment_by_id(uuid) to authenticated;
