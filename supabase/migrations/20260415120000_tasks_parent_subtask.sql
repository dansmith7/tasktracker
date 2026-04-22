-- Одноуровневые подзадачи: parent_task_id → tasks(id). Подзадача не может быть родителем.

alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks (id) on delete cascade;

create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;

create or replace function public.tasks_enforce_one_level_subtask()
returns trigger
language plpgsql
as $$
declare
  p_parent uuid;
begin
  if new.parent_task_id is null then
    return new;
  end if;
  select t.parent_task_id into p_parent
  from public.tasks t
  where t.id = new.parent_task_id;
  if p_parent is not null then
    raise exception 'Подзадача не может иметь подзадачу (максимум один уровень)';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_tasks_one_level_subtask on public.tasks;
create trigger tr_tasks_one_level_subtask
  before insert or update of parent_task_id on public.tasks
  for each row
  execute function public.tasks_enforce_one_level_subtask();
