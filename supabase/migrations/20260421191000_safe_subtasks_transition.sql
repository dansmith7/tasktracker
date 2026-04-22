-- Безопасный переход на подзадачи:
-- 1) Не удаляет существующие задачи при миграции.
-- 2) Включает parent_task_id как опциональное поле.
-- 3) Оставляет рабочую логику подзадач (удаление родителя удаляет подзадачи через ON DELETE CASCADE).

-- Колонка подзадачи должна быть опциональной.
alter table public.tasks add column if not exists parent_task_id uuid;
alter table public.tasks alter column parent_task_id drop not null;

-- Санируем потенциально некорректные ссылки (на случай "грязной" базы):
-- - ссылка на себя
-- - ссылка на отсутствующую задачу
-- - ссылка на задачу из другого проекта
update public.tasks t
set parent_task_id = null
where t.parent_task_id is not null
  and (
    t.parent_task_id = t.id
    or not exists (
      select 1
      from public.tasks p
      where p.id = t.parent_task_id
    )
    or exists (
      select 1
      from public.tasks p
      where p.id = t.parent_task_id
        and p.project_id <> t.project_id
    )
  );

-- Гарантируем FK-связь с каскадным удалением подзадач вместе с родителем
-- (совместимо с текущей логикой приложения).
alter table public.tasks drop constraint if exists tasks_parent_task_id_fkey;
alter table public.tasks
  add constraint tasks_parent_task_id_fkey
  foreign key (parent_task_id)
  references public.tasks (id)
  on delete cascade;

create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;

-- Ограничение: только один уровень подзадач + родитель в том же проекте.
create or replace function public.tasks_enforce_one_level_subtask()
returns trigger
language plpgsql
as $$
declare
  p_parent uuid;
  p_project uuid;
begin
  if new.parent_task_id is null then
    return new;
  end if;

  if new.parent_task_id = new.id then
    raise exception 'Задача не может быть подзадачей самой себя';
  end if;

  select t.parent_task_id, t.project_id
    into p_parent, p_project
  from public.tasks t
  where t.id = new.parent_task_id;

  if p_project is null then
    raise exception 'Родительская задача не найдена';
  end if;

  if p_project <> new.project_id then
    raise exception 'Подзадача должна принадлежать тому же проекту, что и родитель';
  end if;

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

