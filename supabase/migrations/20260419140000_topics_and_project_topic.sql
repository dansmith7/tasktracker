-- Темы (топики): группировка проектов + RPC удаления проекта (прямой DELETE для projects отключён RLS).

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.projects add column if not exists topic_id uuid references public.topics (id) on delete set null;

create index if not exists projects_topic_id_idx on public.projects (topic_id);

alter table public.topics enable row level security;

drop policy if exists "topics_select" on public.topics;
drop policy if exists "topics_insert" on public.topics;
drop policy if exists "topics_update" on public.topics;

create policy "topics_select" on public.topics for select to authenticated using (true);
create policy "topics_insert" on public.topics for insert to authenticated with check (true);
create policy "topics_update" on public.topics for update to authenticated using (true) with check (true);

create or replace function public.delete_topic_by_id(p_topic_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.topics where id = p_topic_id;
end;
$$;

create or replace function public.delete_project_by_id(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.projects where id = p_project_id;
end;
$$;

grant execute on function public.delete_topic_by_id(uuid) to authenticated;
grant execute on function public.delete_project_by_id(uuid) to authenticated;
