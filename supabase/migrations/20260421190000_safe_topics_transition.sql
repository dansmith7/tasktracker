-- Безопасный переход на темы в проде:
-- 1) Не удаляет проекты/задачи.
-- 2) Старые проекты остаются с topic_id = NULL ("Без темы").
-- 3) При удалении темы проекты отвязываются от темы (ON DELETE SET NULL), а не удаляются.

-- На случай, если миграция с темами не применялась.
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- Колонка темы у проекта должна быть опциональной.
alter table public.projects add column if not exists topic_id uuid;
alter table public.projects alter column topic_id drop not null;

-- Гарантируем корректную FK-связь: удаление темы не трогает проекты.
alter table public.projects drop constraint if exists projects_topic_id_fkey;
alter table public.projects
  add constraint projects_topic_id_fkey
  foreign key (topic_id)
  references public.topics (id)
  on delete set null;

create index if not exists projects_topic_id_idx on public.projects (topic_id);

-- Подстраховка для баз, где FK ранее отсутствовал:
-- если topic_id указывает на несуществующую тему, принудительно переводим в NULL ("Без темы").
update public.projects p
set topic_id = null
where p.topic_id is not null
  and not exists (
    select 1
    from public.topics t
    where t.id = p.topic_id
  );

