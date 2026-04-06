-- Текст исполнителя, если нет связи с profiles (или для отображения после загрузки).
alter table public.tasks add column if not exists assignee_name text;
