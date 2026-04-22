# Таск-трекер (React + Vite + Supabase)

## Локально

1. Скопируйте `.env.example` в `.env` и укажите `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
2. В Supabase → **SQL Editor** откройте и выполните **целиком** файл `supabase/migrations/20260203120000_initial_tracker.sql` (создаёт таблицы и политики). Ошибка `relation "public.projects" does not exist` значит, что этот скрипт ещё не запускали. Если база уже есть, дополнительно выполните новые миграции по дате: `20260208120000_tasks_assignee_name.sql`, `20260406120000_auth_user_delete_fk.sql` (удаление пользователей из Auth без ошибки БД).
3. `npm install` → `npm run dev`.

### Закрытая модель пользователей (MVP)

- В приложении **только вход** (email + пароль). Самостоятельной регистрации в UI нет.
- В Supabase Dashboard → **Authentication** → **Providers** → **Email**: отключите **Allow new users to sign up** (саморегистрация), при необходимости отключите **Confirm email** для внутреннего MVP.
- Пользователей создаёт **администратор вручную**: **Authentication → Users → Add user** (email + пароль), затем в таблице `public.profiles` должна быть строка с `id = auth user id` и полем `name`. Триггер `handle_new_user` в миграции создаёт профиль при добавлении пользователя через Auth API; при ручном создании только в SQL убедитесь, что профиль добавлен.
- Если пользователь есть в Auth, но **нет строки в `profiles`**, приложение покажет ошибку и не откроет интерфейс — добавьте профиль вручную.

**Не входит / «неверный пароль»:** проверьте email без опечаток; в **Authentication → Users** откройте пользователя и задайте пароль заново (**Send password recovery** / сброс) или создайте тестового пользователя с известным паролем. Убедитесь, что в `.env` указан актуальный URL и anon key этого проекта.

**Не удаляется пользователь (`Database error deleting user`):** в первой миграции у `projects.created_by` стояло `ON DELETE RESTRICT`. Выполните `supabase/migrations/20260406120000_auth_user_delete_fk.sql`, затем снова удалите пользователя в Dashboard (или сначала удалите его проекты вручную).

### Данные «с сервера» / перенос

Таблицы живут в **PostgreSQL** вашего проекта Supabase. «Админка» здесь — это **Table Editor** или **SQL Editor** в Dashboard.

- **Новые задачи и проекты** создаются из приложения после входа — отдельного «импорта из админки» в коде нет.
- Перенести старые строки можно вручную: экспорт CSV из редактора / другой БД и импорт, либо `INSERT` в **SQL Editor** с реальными `uuid` пользователей из **Authentication → Users**.
- Полная схема — в `supabase/migrations/`.

### Резервная копия всей БД (Supabase → файл)

Чтобы **сохранить копию** таблиц и данных до крупных изменений:

1. Установите клиент PostgreSQL (`pg_dump` / `pg_restore`), на macOS: `brew install libpq` и при необходимости `brew link --force libpq`.
2. Скопируйте [`.env.backup.example`](.env.backup.example) → **`.env.backup`** (файл в `.gitignore`, в репозиторий не попадает).
3. В Supabase: **Project Settings → Database** — возьмите **Database password** и **Connection string** (URI, **Direct connection**), подставьте в `DATABASE_URL` внутри `.env.backup`.
4. Из корня проекта выполните: **`npm run backup:db`** (или `./scripts/backup-supabase-db.sh`).
5. В папке **`backups/`** появятся файлы `supabase-full-*.sql` и `*.dump`. **Скопируйте их на диск / облако** — папка `backups/` не коммитится.

Восстановление в **другой** проект Supabase (копия для экспериментов): создайте новый проект, затем `TARGET_DATABASE_URL='postgresql://...' ./scripts/restore-supabase-db.sh backups/ваш-файл.dump`. Для **локальной разработки** можно указать в `.env` URL и ключи **того же** проекта или **staging-копии** — приложение (`npm run dev`) будет ходить в выбранный инстанс.

Ограничение: дамп через `pg_dump` отражает то, что доступно роли `postgres` к вашей БД; служебные части `auth` при переносе на другой проект могут потребовать отдельной настройки пользователей в Dashboard. Для продакшена дополнительно используйте **автобэкапы** Supabase на платном плане.

## Vercel

В настройках проекта добавьте те же переменные (`VITE_SUPABASE_*`). Сборка: `npm run build`, выходная папка: `dist` (по умолчанию для Vite).

---

# React + Vite (шаблон)

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
