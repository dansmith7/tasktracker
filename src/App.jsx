import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoginScreen } from './components/LoginScreen.jsx'
import { ProfileMissingScreen } from './components/ProfileMissingScreen.jsx'
import { useAuth } from './contexts/AuthContext.jsx'
import { useTrackerData } from './hooks/useTrackerData.js'
import {
  createMilestoneRemote,
  createProjectRemote,
  createTopicRemote,
  deleteCommentRemote,
  deleteMilestoneRemote,
  deleteProjectRemote,
  deleteTaskAttachmentRemote,
  deleteTaskRemote,
  deleteTasksBulkRemote,
  deleteTopicRemote,
  formatSupabaseError,
  insertCommentRemote,
  persistProjectTasksDelta,
  updateMilestoneDeadlineRemote,
  updateMilestoneTitleRemote,
  updateProfileNameRemote,
  updateProjectTitleRemote,
  updateProjectTopicRemote,
  updateTaskMilestoneRemote,
  updateTasksStatusBulkRemote,
  updateTopicTitleRemote,
  uploadTaskAttachment,
} from './lib/trackerApi.js'
import { canUseDataApi } from './lib/localDev.js'
import { ProjectGantt } from './ProjectGantt.jsx'
import './App.css'

const statusOptions = ['В работе', 'Готово']
const ungroupedMilestoneId = 'none'
const dayMs = 1000 * 60 * 60 * 24
const taskLinkParam = 'task'
const taskProjectLinkParam = 'project'

/** @param {string} userId */
function mineFilterStorageKey(userId) {
  return `taskFilterMine:${userId}`
}

/** @param {string | null} userId */
function readMineFilterForUser(userId) {
  if (!userId) return false
  try {
    return localStorage.getItem(mineFilterStorageKey(userId)) === 'true'
  } catch {
    return false
  }
}

function normalizeEntityId(raw) {
  const value = (raw || '').trim().toLowerCase()
  return value || null
}

function readTaskLinkFromUrl() {
  if (typeof window === 'undefined') return { taskId: null, projectId: null }
  const p = new URLSearchParams(window.location.search)
  const taskId = normalizeEntityId(p.get(taskLinkParam))
  const projectId = normalizeEntityId(p.get(taskProjectLinkParam))
  return { taskId, projectId }
}

function buildTaskLinkUrl(taskId, projectId = null) {
  if (typeof window === 'undefined') return ''
  const url = new URL(window.location.href)
  if (taskId) url.searchParams.set(taskLinkParam, taskId)
  else url.searchParams.delete(taskLinkParam)
  if (projectId) url.searchParams.set(taskProjectLinkParam, projectId)
  else url.searchParams.delete(taskProjectLinkParam)
  return url.toString()
}

function writeTaskLinkToUrl(taskId, projectId = null) {
  if (typeof window === 'undefined') return
  const url = buildTaskLinkUrl(taskId, projectId)
  window.history.replaceState(null, '', url)
}

function clearTaskLinkFromUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete(taskLinkParam)
  url.searchParams.delete(taskProjectLinkParam)
  window.history.replaceState(null, '', url.toString())
}

/** @param {AppUser[]} users */
function findUserByName(users, rawName) {
  const n = (rawName || '').trim()
  if (!n) return null
  const exact = users.find((u) => u.name === n)
  if (exact) return exact
  const lower = n.toLowerCase()
  return users.find((u) => (u.name || '').trim().toLowerCase() === lower) ?? null
}

/** Значение для select исполнителя: id или подбор по имени (старые задачи). */
function assigneeSelectValue(task, users) {
  if (task.assigneeId) return task.assigneeId
  return findUserByName(users, task.assignee)?.id ?? ''
}

/**
 * Идентификатор исполнителя: явный assigneeId или пользователь по имени assignee.
 * @param {Task} task
 * @param {AppUser[]} users
 */
function resolveTaskAssigneeId(task, users) {
  if (task.assigneeId) return task.assigneeId
  const name = (task.assignee || '').trim()
  if (!name) return null
  return findUserByName(users, name)?.id ?? null
}

/** Для колонки «Проблемные»: исполнитель есть, если в задаче указано имя или id (даже если имя не совпало с profiles). */
function taskHasAssigneeDisplay(task) {
  if (task.assigneeId) return true
  return Boolean((task.assignee || '').trim())
}

const USER_AVATAR_COLORS = ['#60d812', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6']

/** @typedef {{ id: string, name: string, avatarColor?: string, avatarUrl?: string }} AppUser */

const TASK_PRIORITY_OPTIONS = [
  { id: 'high', label: 'Высокий' },
  { id: 'medium', label: 'Средний' },
  { id: 'low', label: 'Низкий' },
]

/** @param {unknown} p @returns {'high' | 'medium' | 'low'} */
function normalizeTaskPriority(p) {
  if (p === 'high' || p === 'medium' || p === 'low') return p
  return 'medium'
}

/** @param {unknown} p */
function priorityLabel(p) {
  const id = normalizeTaskPriority(p)
  return TASK_PRIORITY_OPTIONS.find((o) => o.id === id)?.label ?? 'Средний'
}

/** Суммарный лимит вложений на одну задачу (байты) */
const MAX_TASK_ATTACHMENTS_BYTES = 20 * 1024 * 1024

/** Разрешённые расширения (нижний регистр) */
const ATTACHMENT_ALLOWED_EXT = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'txt',
  'md',
  'csv',
  'rtf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'zip',
  'rar',
])

function getFileNameExtension(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

/**
 * @param {File} file
 * @param {number} currentTotalBytes — уже занято на задаче
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validateTaskAttachment(file, currentTotalBytes) {
  if (file.size > MAX_TASK_ATTACHMENTS_BYTES) {
    return { ok: false, message: 'Файл слишком большой' }
  }
  const ext = getFileNameExtension(file.name)
  if (!ext || !ATTACHMENT_ALLOWED_EXT.has(ext)) {
    return { ok: false, message: 'Тип файла не поддерживается' }
  }
  if (currentTotalBytes + file.size > MAX_TASK_ATTACHMENTS_BYTES) {
    return { ok: false, message: 'Превышен лимит 20 МБ на задачу' }
  }
  return { ok: true }
}

function sumAttachmentBytes(attachments) {
  if (!attachments?.length) return 0
  return attachments.reduce((s, a) => s + (a.size || 0), 0)
}

/** @param {Task} task */
function revokeTaskAttachmentUrls(task) {
  const list = task.attachments
  if (!list?.length) return
  for (const a of list) {
    if (a.fileUrl && a.fileUrl.startsWith('blob:')) URL.revokeObjectURL(a.fileUrl)
  }
}

function readFileForProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((100 * e.loaded) / e.total))
    }
    r.onload = () => resolve()
    r.onerror = () => reject(new Error('Ошибка загрузки'))
    r.readAsArrayBuffer(file)
  })
}

/**
 * Вложение к задаче (контекст задачи, не отдельная сущность).
 * @typedef {Object} TaskAttachment
 * @property {string} id
 * @property {string} taskId
 * @property {string} fileName
 * @property {number} size
 * @property {string} mimeType
 * @property {string} fileUrl — blob URL для открытия в браузере
 * @property {string} [uploadedBy]
 */

/**
 * Задача в проекте. Зависимость (MVP): не более одной родительской задачи в том же проекте.
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} assignee
 * @property {string | null} [assigneeId]
 * @property {string} startDate
 * @property {string} deadline
 * @property {'high' | 'medium' | 'low'} [priority]
 * @property {string | null} milestoneId
 * @property {string | null} dependsOnTaskId — id родительской задачи или null
 * @property {string} [comment] — комментарий при быстром создании
 * @property {TaskAttachment[]} [attachments]
 * @property {string} [createdBy]
 * @property {string} [updatedBy]
 * @property {{ id: string, author: string, authorId?: string, time: string, text: string }[]} [comments]
 */

const toDate = (value) => new Date(`${value}T00:00:00`)
const dateOnly = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const toLocalDateString = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const todayLocalDate = () => toLocalDateString(new Date())
const formatDate = (value) => toDate(value).toLocaleDateString('ru-RU')
/** Короткая дата в строке задачи: «24 апр» */
const formatTaskDateShort = (value) => {
  if (!value) return '—'
  return toDate(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / dayMs)
const shiftDate = (dateString, days) => {
  const date = toDate(dateString)
  date.setDate(date.getDate() + days)
  return toLocalDateString(date)
}

/** Пятница календарной недели, в которой находится дата (неделя с понедельника). */
const fridayEndOfWeekLocal = (dateString) => {
  const d = toDate(dateString)
  const day = d.getDay()
  const daysFromMonday = (day + 6) % 7
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  monday.setDate(monday.getDate() - daysFromMonday)
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  return toLocalDateString(friday)
}

/** Лаг после дедлайна родителя (Finish-to-Start). */
const FS_LAG_DAYS = 1

/**
 * Сохраняет длительность дочерней задачи: duration = deadline − start, затем
 * start = deadline родителя + lag, deadline = start + duration.
 */
const rescheduleChildFromParent = (parentTask, childTask) => {
  const duration = diffDays(childTask.deadline, childTask.startDate)
  const newStart = shiftDate(parentTask.deadline, FS_LAG_DAYS)
  const newDeadline = shiftDate(newStart, duration)
  return { ...childTask, startDate: newStart, deadline: newDeadline }
}

/**
 * После изменения дедлайна задачи пересчитывает всех зависимых по цепочке (A→B→C…)
 * в порядке BFS: сначала прямые потомки, затем их потомки, с актуальными датами родителя.
 */
const cascadeFsShiftFromParent = (tasks, changedTask) => {
  let next = tasks.map((t) => (t.id === changedTask.id ? changedTask : t))
  const queue = [changedTask]
  while (queue.length) {
    const popped = queue.shift()
    const parent = next.find((t) => t.id === popped.id) ?? popped
    const children = next.filter((t) => (t.dependsOnTaskId ?? null) === parent.id)
    for (const child of children) {
      const updated = rescheduleChildFromParent(parent, child)
      next = next.map((t) => (t.id === child.id ? updated : t))
      queue.push(updated)
    }
  }
  return next
}

/**
 * Связь «taskId зависит от newParentId» замкнёт цикл, если от newParentId по цепочке dependsOnTaskId
 * можно дойти обратно до taskId.
 */
const wouldDependencyCreateCycle = (tasks, taskId, newParentId) => {
  if (!newParentId) return false
  if (newParentId === taskId) return true
  let walker = newParentId
  const seen = new Set()
  while (walker) {
    if (walker === taskId) return true
    if (seen.has(walker)) return true
    seen.add(walker)
    const node = tasks.find((t) => t.id === walker)
    if (!node) break
    walker = node.dependsOnTaskId ?? null
  }
  return false
}

const DEPENDENCY_CYCLE_MESSAGE =
  'Нельзя создать зависимость: получится замкнутая цепочка'

/** Есть ли цикл в графе зависимостей (каждая задача → максимум один родитель). */
function hasDependencyCycleInTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const start of tasks) {
    const path = new Set()
    let cur = start.dependsOnTaskId
    while (cur) {
      if (path.has(cur)) return true
      path.add(cur)
      cur = byId.get(cur)?.dependsOnTaskId ?? null
    }
  }
  return false
}

/** Finish-to-start: старт дочерней не раньше дедлайна родителя + лаг. */
function checkFinishToStartDeadlines(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const t of tasks) {
    if (!t.dependsOnTaskId) continue
    const parent = byId.get(t.dependsOnTaskId)
    if (!parent) continue
    const minStart = shiftDate(parent.deadline, FS_LAG_DAYS)
    if (diffDays(t.startDate, minStart) < 0) {
      return {
        ok: false,
        message:
          'Невозможно переместить задачу: нарушается логика зависимостей и сроков',
      }
    }
  }
  return { ok: true }
}

/**
 * Пробует применить новые даты задачи (в т.ч. каскад FS при autoShift).
 * @returns {{ ok: true, tasks: Task[] } | { ok: false, message: string }}
 */
function tryApplyTaskDateChange(project, taskId, newStart, newDeadline, autoShift) {
  const oldTask = project.tasks.find((t) => t.id === taskId)
  if (!oldTask) return { ok: false, message: 'Задача не найдена' }
  if (diffDays(newDeadline, newStart) < 0) {
    return { ok: false, message: 'Недопустимые даты: дедлайн раньше старта' }
  }
  let merged = { ...oldTask, startDate: newStart, deadline: newDeadline }
  let tasks = project.tasks.map((t) => (t.id === taskId ? merged : t))
  if (autoShift && merged.deadline !== oldTask.deadline) {
    tasks = cascadeFsShiftFromParent(tasks, merged)
  }
  const fs = checkFinishToStartDeadlines(tasks)
  if (!fs.ok) return { ok: false, message: fs.message }
  return { ok: true, tasks }
}

/**
 * Валидация переноса задачи между вехами (без изменения графа зависимостей).
 * @returns {{ ok: true } | { ok: false, message: string } | { ok: false, noOp: true }}
 */
function validateTaskMilestoneMove(project, taskId, targetMilestoneKey, ungroupedId) {
  const task = project.tasks.find((t) => t.id === taskId)
  if (!task) return { ok: false, message: 'Веха недоступна' }
  if (task.parentTaskId) {
    return { ok: false, message: 'Подзадачу между вехами не переносят — переместите родительскую задачу' }
  }
  if (task.status === 'Готово') {
    return { ok: false, message: 'Сначала верните задачу в активные' }
  }
  const currentKey = task.milestoneId ?? ungroupedId
  if (currentKey === targetMilestoneKey) return { ok: false, noOp: true }
  if (targetMilestoneKey !== ungroupedId && !project.milestones.some((m) => m.id === targetMilestoneKey)) {
    return { ok: false, message: 'Веха недоступна' }
  }
  const newMilestoneId = targetMilestoneKey === ungroupedId ? null : targetMilestoneKey
  const nextTasks = project.tasks.map((t) => {
    if (t.id === taskId) return { ...t, milestoneId: newMilestoneId }
    if (t.parentTaskId === taskId) return { ...t, milestoneId: newMilestoneId }
    return t
  })
  if (hasDependencyCycleInTasks(nextTasks)) {
    return {
      ok: false,
      message: 'Невозможно переместить задачу: возникнет цикл зависимостей',
    }
  }
  const fs = checkFinishToStartDeadlines(nextTasks)
  if (!fs.ok) return fs
  return { ok: true }
}

const getDeadlineLabel = (deadline) => {
  const today = dateOnly(new Date())
  const days = Math.round((toDate(deadline) - today) / dayMs)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return 'upcoming'
}

const getDeadlineLabelText = (label) => {
  if (label === 'overdue') return 'просрочено'
  if (label === 'today') return 'сегодня'
  return 'скоро'
}

const getStatusClass = (status) => {
  if (status === 'Готово') return 'status-done'
  if (status === 'В работе') return 'status-progress'
  return 'status-todo'
}

const getInitials = (name) => {
  if (!name) return '?'
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

const maxDate = (dates) => {
  if (!dates.length) return null
  return dates.reduce((latest, current) =>
    toDate(current) > toDate(latest) ? current : latest,
  )
}

/** Склонение по числу (им. падеж): «1 задача», «2 задачи», «5 задач», «21 задача» */
const ruTasksCountLabel = (n) => {
  const abs = n % 100
  const d = n % 10
  if (abs > 10 && abs < 20) return `${n} задач`
  if (d === 1) return `${n} задача`
  if (d >= 2 && d <= 4) return `${n} задачи`
  return `${n} задач`
}

const getDependencyMeta = (task, tasks) => {
  const parentId = task.dependsOnTaskId ?? null
  const parent = parentId ? tasks.find((t) => t.id === parentId) : null
  const dependents = tasks.filter((t) => (t.dependsOnTaskId ?? null) === task.id)
  return {
    isBlocked: Boolean(parentId),
    isBlocking: dependents.length > 0,
    blockingCount: dependents.length,
    parentTitle: parent?.title ?? null,
    dependents,
  }
}

function CurrentUserMenu({ currentUser, onSignOut, onSaveDisplayName }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [nameEditOpen, setNameEditOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(currentUser.name)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState(null)
  const rootRef = useRef(null)

  useEffect(() => {
    setNameDraft(currentUser.name)
  }, [currentUser.name])

  useEffect(() => {
    if (!menuOpen) {
      setNameEditOpen(false)
      setNameError(null)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const saveDisplayName = async () => {
    const t = nameDraft.trim()
    if (!t) {
      setNameError('Введите имя')
      return
    }
    setNameSaving(true)
    setNameError(null)
    try {
      await onSaveDisplayName(t)
      setNameEditOpen(false)
      setMenuOpen(false)
    } catch (e) {
      console.error(e)
      setNameError(formatSupabaseError(e))
    } finally {
      setNameSaving(false)
    }
  }

  return (
    <div className="app-header-user" ref={rootRef}>
      <button
        type="button"
        className="app-header-user__trigger"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <span
          className="app-header-user__avatar"
          style={{ background: currentUser.avatarColor ?? '#9ca3af' }}
        >
          {currentUser.avatarUrl ? (
            <img src={currentUser.avatarUrl} alt="" className="app-header-user__avatar-img" />
          ) : (
            getInitials(currentUser.name)
          )}
        </span>
        <span className="app-header-user__name">{currentUser.name}</span>
        <span className="app-header-user__caret" aria-hidden>
          ▾
        </span>
      </button>
      {menuOpen && (
        <div className="app-header-user__menu" role="menu">
          <div className="app-header-user__menu-current">
            <span className="app-header-user__menu-label">Сейчас</span>
            <span className="app-header-user__menu-strong">{currentUser.name}</span>
          </div>
          {nameEditOpen ? (
            <div className="app-header-user__name-edit">
              <label className="app-header-user__name-edit-label" htmlFor="user-display-name-input">
                Имя в системе
              </label>
              <input
                id="user-display-name-input"
                type="text"
                className="app-header-user__name-input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Например, Данил"
                autoComplete="name"
                disabled={nameSaving}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveDisplayName()
                }}
              />
              {nameError ? (
                <p className="app-header-user__name-error" role="alert">
                  {nameError}
                </p>
              ) : null}
              <div className="app-header-user__name-actions">
                <button
                  type="button"
                  className="btn-secondary app-header-user__name-btn"
                  disabled={nameSaving}
                  onClick={() => {
                    setNameEditOpen(false)
                    setNameDraft(currentUser.name)
                    setNameError(null)
                  }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary app-header-user__name-btn"
                  disabled={nameSaving}
                  onClick={() => void saveDisplayName()}
                >
                  {nameSaving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="app-header-user__menu-item app-header-user__menu-item--action"
              onClick={() => {
                setNameEditOpen(true)
                setNameDraft(currentUser.name)
                setNameError(null)
              }}
            >
              Изменить имя
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="app-header-user__menu-item app-header-user__menu-item--danger"
            onClick={() => {
              onSignOut()
              setMenuOpen(false)
            }}
          >
            Выйти
          </button>
        </div>
      )}
    </div>
  )
}

function QuickAddTask({
  projectTasks,
  todayDateString,
  onCreate,
  assigneeUsers,
  addButtonLabel = 'Добавить задачу',
  titlePlaceholder = 'Добавить задачу…',
  submitButtonLabel = 'Создать',
  initialCollapsed = true,
  ariaLabelParams = 'Параметры задачи',
}) {
  const titleInputId = useId()

  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [title, setTitle] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [deadline, setDeadline] = useState(todayDateString)
  const [dependsOnTaskId, setDependsOnTaskId] = useState(null)
  const [dueOpen, setDueOpen] = useState(false)
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [depOpen, setDepOpen] = useState(false)
  const [depSearch, setDepSearch] = useState('')
  /** Пока false — в pill показываем «Срок», дедлайн по умолчанию всё равно сегодня */
  const [dueTouched, setDueTouched] = useState(false)
  const titleRef = useRef(null)
  const dueWrapRef = useRef(null)
  const assigneeWrapRef = useRef(null)
  const depWrapRef = useRef(null)

  const tomorrowDateString = useMemo(() => shiftDate(todayDateString, 1), [todayDateString])
  const fridayThisWeek = useMemo(() => fridayEndOfWeekLocal(todayDateString), [todayDateString])

  useEffect(() => {
    if (!collapsed) titleRef.current?.focus()
  }, [collapsed])

  useEffect(() => {
    const popoverOpen = dueOpen || assigneeOpen || depOpen
    if (!popoverOpen) return
    const onDoc = (e) => {
      if (dueWrapRef.current && !dueWrapRef.current.contains(e.target)) setDueOpen(false)
      if (assigneeWrapRef.current && !assigneeWrapRef.current.contains(e.target))
        setAssigneeOpen(false)
      if (depWrapRef.current && !depWrapRef.current.contains(e.target)) {
        setDepOpen(false)
        setDepSearch('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [dueOpen, assigneeOpen, depOpen])

  const closePopovers = () => {
    setDueOpen(false)
    setAssigneeOpen(false)
    setDepOpen(false)
    setDepSearch('')
  }

  const openDue = () => {
    setDueOpen((o) => !o)
    setAssigneeOpen(false)
    setDepOpen(false)
    setDepSearch('')
  }

  const openAssignee = () => {
    setAssigneeOpen((o) => !o)
    setDueOpen(false)
    setDepOpen(false)
    setDepSearch('')
  }

  const openDep = () => {
    setDepOpen((o) => !o)
    setDueOpen(false)
    setAssigneeOpen(false)
  }

  const clearExtras = () => {
    setAssigneeUserId('')
    setDependsOnTaskId(null)
    setDeadline(todayDateString)
    setDueTouched(false)
    setDepSearch('')
    closePopovers()
  }

  const submit = () => {
    if (!title.trim()) return
    onCreate({
      title: title.trim(),
      assigneeUserId: assigneeUserId || null,
      deadline,
      dependsOnTaskId,
      comment: '',
    })
    setTitle('')
    setAssigneeUserId('')
    setDependsOnTaskId(null)
    setDeadline(todayDateString)
    setDueTouched(false)
    setDepSearch('')
    closePopovers()
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  const onFormEscape = () => {
    if (dueOpen) {
      setDueOpen(false)
      return
    }
    if (assigneeOpen) {
      setAssigneeOpen(false)
      return
    }
    if (depOpen) {
      setDepOpen(false)
      setDepSearch('')
      return
    }
    const hasTitle = Boolean(title.trim())
    const hasExtras =
      Boolean(assigneeUserId) ||
      Boolean(dependsOnTaskId) ||
      dueTouched ||
      deadline !== todayDateString
    if (!hasTitle && !hasExtras) {
      setCollapsed(true)
      return
    }
    if (hasTitle) {
      setTitle('')
      clearExtras()
    } else {
      clearExtras()
    }
  }

  const depFiltered = useMemo(() => {
    const q = depSearch.trim().toLowerCase()
    return projectTasks.filter((t) => !q || t.title.toLowerCase().includes(q))
  }, [projectTasks, depSearch])

  const parentTask = dependsOnTaskId ? projectTasks.find((t) => t.id === dependsOnTaskId) : null

  const duePillLabel = () => {
    if (!dueTouched && deadline === todayDateString) return 'Срок'
    if (deadline === fridayThisWeek) return 'Конец недели'
    if (deadline === todayDateString) return 'Сегодня'
    if (deadline === tomorrowDateString) return 'Завтра'
    return formatDate(deadline)
  }

  if (collapsed) {
    return (
      <div className="quick-add--collapsed">
        <button
          type="button"
          className="quick-add-trigger"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
        >
          <span className="quick-add-plus" aria-hidden>
            +
          </span>
          {addButtonLabel}
        </button>
      </div>
    )
  }

  return (
    <div className="quick-add-card">
      <form
        className="quick-add-card__form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onFormEscape()
          }
        }}
      >
        <div className="quick-add-main">
          <span className="quick-add-plus quick-add-plus--main" aria-hidden>
            +
          </span>
          <input
            id={titleInputId}
            ref={titleRef}
            className="quick-add-main__input"
            value={title}
            placeholder={titlePlaceholder}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Название задачи"
          />
          <button type="submit" className="btn-primary quick-add-main__submit" disabled={!title.trim()}>
            {submitButtonLabel}
          </button>
        </div>

        <div className="quick-add-pills" role="group" aria-label={ariaLabelParams}>
            <div className="quick-add-pill-slot" ref={dueWrapRef}>
              <button
                type="button"
                className={`quick-add-pill quick-add-pill--due ${dueOpen ? 'is-open' : ''}`}
                onClick={openDue}
                aria-expanded={dueOpen}
                aria-haspopup="dialog"
              >
                <span className="quick-add-pill__ico" aria-hidden>
                  📅
                </span>
                <span className="quick-add-pill__text">{duePillLabel()}</span>
              </button>
              {dueOpen && (
                <div className="quick-add-popover quick-add-popover--due" role="dialog" aria-label="Срок">
                  <div className="quick-add-popover__section">
                    <button
                      type="button"
                      className="quick-add-popover__chip"
                      onClick={() => {
                        setDeadline(todayDateString)
                        setDueTouched(true)
                        setDueOpen(false)
                      }}
                    >
                      Сегодня
                    </button>
                    <button
                      type="button"
                      className="quick-add-popover__chip"
                      onClick={() => {
                        setDeadline(tomorrowDateString)
                        setDueTouched(true)
                        setDueOpen(false)
                      }}
                    >
                      Завтра
                    </button>
                    <button
                      type="button"
                      className="quick-add-popover__chip"
                      onClick={() => {
                        setDeadline(fridayThisWeek)
                        setDueTouched(true)
                        setDueOpen(false)
                      }}
                    >
                      Конец недели
                    </button>
                  </div>
                  <label className="quick-add-popover__date-label">
                    <span className="quick-add-popover__muted">Дата</span>
                    <input
                      type="date"
                      className="quick-add-popover__date"
                      value={deadline}
                      onChange={(e) => {
                        setDeadline(e.target.value)
                        setDueTouched(true)
                      }}
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="quick-add-pill-slot" ref={assigneeWrapRef}>
              <button
                type="button"
                className={`quick-add-pill quick-add-pill--assignee ${assigneeOpen ? 'is-open' : ''}`}
                onClick={openAssignee}
                aria-expanded={assigneeOpen}
                aria-haspopup="dialog"
              >
                <span className="quick-add-pill__ico" aria-hidden>
                  👤
                </span>
                <span className="quick-add-pill__text">
                  {assigneeUserId
                    ? assigneeUsers.find((u) => u.id === assigneeUserId)?.name ?? 'Исполнитель'
                    : 'Исполнитель'}
                </span>
              </button>
              {assigneeOpen && (
                <div className="quick-add-popover quick-add-popover--assignee" role="dialog" aria-label="Исполнитель">
                  <select
                    className="quick-add-popover__assignee-input"
                    value={assigneeUserId}
                    onChange={(e) => setAssigneeUserId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setAssigneeOpen(false)
                      }
                    }}
                    aria-label="Исполнитель"
                  >
                    <option value="">Не назначен</option>
                    {assigneeUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="quick-add-pill-slot" ref={depWrapRef}>
              {parentTask ? (
                <span className="quick-add-pill quick-add-pill--dep quick-add-pill--dep-filled">
                  <span className="quick-add-pill__ico" aria-hidden>
                    🔗
                  </span>
                  <span className="quick-add-pill__text quick-add-pill__text--truncate">
                    Зависит от: {parentTask.title}
                  </span>
                  <button
                    type="button"
                    className="quick-add-pill-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDependsOnTaskId(null)
                      setDepSearch('')
                    }}
                    aria-label="Сбросить зависимость"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className={`quick-add-pill quick-add-pill--dep ${depOpen ? 'is-open' : ''}`}
                    onClick={openDep}
                    aria-expanded={depOpen}
                    aria-haspopup="listbox"
                  >
                    <span className="quick-add-pill__ico" aria-hidden>
                      🔗
                    </span>
                    <span className="quick-add-pill__text">Зависимость</span>
                  </button>
                  {depOpen && (
                    <div className="quick-add-popover quick-add-popover--dep" role="listbox" aria-label="Зависимость">
                      <input
                        className="quick-add-dep-search"
                        value={depSearch}
                        placeholder="Поиск задачи"
                        onChange={(e) => setDepSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            setDepOpen(false)
                            setDepSearch('')
                          }
                        }}
                        autoFocus
                      />
                      <ul className="quick-add-dep-list">
                        {depFiltered.length === 0 ? (
                          <li className="quick-add-dep-empty">Нет задач</li>
                        ) : (
                          depFiltered.map((t) => (
                            <li key={t.id}>
                              <button
                                type="button"
                                className="quick-add-dep-item"
                                role="option"
                                onClick={() => {
                                  setDependsOnTaskId(t.id)
                                  setDepOpen(false)
                                  setDepSearch('')
                                }}
                              >
                                <span className="quick-add-dep-item__title">{t.title}</span>
                                <span className="quick-add-dep-item__meta">{formatDate(t.deadline)}</span>
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
      </form>
    </div>
  )
}

/** Рендер в body + position:fixed — избегает наслоений из-за stacking context таблицы, transform на tr и соседних блоков */
function TaskInlinePopoverPortal({ open, popoverRef, coords, className = '', children, ...rest }) {
  if (!open) return null
  return createPortal(
    <div
      ref={popoverRef}
      className={`task-inline__popover task-inline__popover--portal ${className}`.trim()}
      style={{
        top: coords.top,
        left: coords.left,
        minWidth: coords.minWidth,
      }}
      {...rest}
    >
      {children}
    </div>,
    document.body
  )
}

function useInlinePopover(options = {}) {
  const minWidthFloor = options.minWidthFloor ?? 180
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const popoverRef = useRef(null)
  const [coords, setCoords] = useState({ top: 0, left: 0, minWidth: minWidthFloor })

  const measure = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const mw = Math.max(minWidthFloor, Math.round(r.width))
    const vw = window.innerWidth
    const maxLeft = Math.max(8, vw - mw - 8)
    const left = Math.min(Math.round(r.left), maxLeft)
    setCoords({
      top: Math.round(r.bottom + 4),
      left,
      minWidth: mw,
    })
  }, [minWidthFloor])

  useLayoutEffect(() => {
    if (!open) return
    measure()
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onScroll = () => measure()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, measure])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      const t = e.target
      if (anchorRef.current?.contains(t) || popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return { open, setOpen, anchorRef, popoverRef, coords, measure }
}

function statusLozengeClass(status, urgency) {
  if (status === 'В работе') return 'status-lozenge status-progress'
  if (status === 'Готово') return 'status-lozenge status-done'
  return `status-lozenge status-lozenge--urgency-${urgency}`
}

function InlineTaskStatus({ taskId, status, statusOptions, updateTask, urgency = 'upcoming' }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  return (
    <div className="task-inline task-inline--status" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--status"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={statusLozengeClass(status, urgency)}>{status}</span>
      </button>
      <TaskInlinePopoverPortal open={open} popoverRef={popoverRef} coords={coords} role="listbox" aria-label="Статус">
        {statusOptions.map((s) => (
          <button
            key={s}
            type="button"
            role="option"
            className={`task-inline__option${status === s ? ' task-inline__option--active' : ''}`}
            onClick={() => {
              updateTask(taskId, { status: s })
              setOpen(false)
            }}
          >
            {s}
          </button>
        ))}
      </TaskInlinePopoverPortal>
    </div>
  )
}

function InlineTaskAssignee({ taskId, task, users, updateTask }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  const resolved = task.assigneeId ? users.find((u) => u.id === task.assigneeId) : null
  const assigneeTrimmed = (task.assignee || '').trim()
  const displayName = resolved?.name ?? (assigneeTrimmed || 'Не назначен')
  return (
    <div className="task-inline task-inline--assignee" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--assignee"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={displayName}
      >
        <span className="avatar">{getInitials(resolved?.name ?? task.assignee ?? '?')}</span>
        <span className="task-inline__assignee-name">{displayName}</span>
      </button>
      <TaskInlinePopoverPortal
        open={open}
        popoverRef={popoverRef}
        coords={coords}
        className="task-inline__popover--assignee"
        role="listbox"
        aria-label="Исполнитель"
      >
        <button
          type="button"
          className="task-inline__option"
          onClick={() => {
            updateTask(taskId, { assigneeUserId: null })
            setOpen(false)
          }}
        >
          Не назначен
        </button>
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            className="task-inline__option"
            onClick={() => {
              updateTask(taskId, { assigneeUserId: u.id })
              setOpen(false)
            }}
          >
            {u.name}
          </button>
        ))}
      </TaskInlinePopoverPortal>
    </div>
  )
}

function InlineTaskDateField({ taskId, field, value, updateTask, deadlineLabel }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  const inputRef = useRef(null)
  const isDeadline = field === 'deadline'
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  const tagClass = deadlineLabel ?? ''
  const tagText = deadlineLabel ? getDeadlineLabelText(deadlineLabel) : ''
  return (
    <div className="task-inline task-inline--date" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--date"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {isDeadline && <span className={`tag ${tagClass}`}>{tagText}</span>}
        <span className="task-inline__date-text">{formatTaskDateShort(value)}</span>
      </button>
      <TaskInlinePopoverPortal
        open={open}
        popoverRef={popoverRef}
        coords={coords}
        className="task-inline__popover--date"
        role="dialog"
        aria-label={isDeadline ? 'Дедлайн' : 'Дата старта'}
      >
        <input
          ref={inputRef}
          type="date"
          className="task-inline__date-input"
          value={value}
          onChange={(e) => {
            updateTask(taskId, { [field]: e.target.value })
            setOpen(false)
          }}
          aria-label={isDeadline ? 'Дедлайн' : 'Дата старта'}
        />
      </TaskInlinePopoverPortal>
    </div>
  )
}

function InlineTaskPriority({ taskId, priority, updateTask }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  const p = normalizeTaskPriority(priority)
  return (
    <div className="task-inline task-inline--priority" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`task-inline__trigger task-inline__trigger--priority task-inline__trigger--priority-${p}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {priorityLabel(p)}
      </button>
      <TaskInlinePopoverPortal open={open} popoverRef={popoverRef} coords={coords} role="listbox" aria-label="Приоритет">
        {TASK_PRIORITY_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="option"
            className={`task-inline__option${p === opt.id ? ' task-inline__option--active' : ''}`}
            onClick={() => {
              updateTask(taskId, { priority: opt.id })
              setOpen(false)
            }}
          >
            {opt.label}
          </button>
        ))}
      </TaskInlinePopoverPortal>
    </div>
  )
}

function InlineTaskDependency({ taskId, dependsOnTaskId, candidates, tasks, updateTask }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover({ minWidthFloor: 260 })
  const [search, setSearch] = useState('')
  const searchRef = useRef(null)
  const parent = dependsOnTaskId ? tasks.find((t) => t.id === dependsOnTaskId) : null
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return candidates.filter((x) => !q || x.title.toLowerCase().includes(q))
  }, [candidates, search])
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс поиска при закрытии
      setSearch('')
    }
  }, [open])
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])
  return (
    <div className="task-inline task-inline--dependency" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--dependency"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={parent ? parent.title : 'Нет зависимости'}
      >
        <span className="task-inline__dependency-text">{parent ? parent.title : 'Нет зависимости'}</span>
      </button>
      <TaskInlinePopoverPortal
        open={open}
        popoverRef={popoverRef}
        coords={coords}
        className="task-inline__popover--dependency"
        role="dialog"
        aria-label="Зависимость"
      >
        <input
          ref={searchRef}
          type="search"
          className="task-inline__dep-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск задачи"
          aria-label="Поиск задачи"
        />
        <button
          type="button"
          className="task-inline__option"
          onClick={() => {
            updateTask(taskId, { dependsOnTaskId: null })
            setOpen(false)
          }}
        >
          Нет зависимости
        </button>
        <ul className="task-inline__dep-list">
          {filtered.length === 0 ? (
            <li className="task-inline__dep-empty">Нет задач</li>
          ) : (
            filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="task-inline__option"
                  onClick={() => {
                    updateTask(taskId, { dependsOnTaskId: c.id })
                    setOpen(false)
                  }}
                >
                  <span className="task-inline__dep-title">{c.title}</span>
                  <span className="task-inline__dep-meta">{formatTaskDateShort(c.deadline)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </TaskInlinePopoverPortal>
    </div>
  )
}

function DepTagIconWaiting() {
  return (
    <svg className="dep-tag__svg" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.75v3.25l2.25 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function DepTagIconBlocks() {
  return (
    <svg className="dep-tag__svg" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 8h9M9.5 5.25L12 8l-2.5 2.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TaskDependencyPanel({ task, tasks, compact }) {
  const dep = getDependencyMeta(task, tasks)
  if (!dep.isBlocked && !dep.isBlocking) return null
  const blockingTitles =
    dep.dependents.length > 0 ? dep.dependents.map((d) => d.title).join(', ') : null
  return (
    <div
      className={`dep-tag${compact ? ' dep-tag--compact' : ''}`}
      role="group"
      aria-label="Зависимости задачи"
    >
      {dep.isBlocked && (
        <div className="dep-tag__line">
          <span className="dep-tag__icon" aria-hidden>
            <DepTagIconWaiting />
          </span>
          <span className="dep-tag__text">
            Ждёт <span className="dep-tag__emph">{dep.parentTitle ?? '—'}</span>
          </span>
        </div>
      )}
      {dep.isBlocking && (
        <div className="dep-tag__line">
          <span className="dep-tag__icon" aria-hidden>
            <DepTagIconBlocks />
          </span>
          <span className="dep-tag__text">
            Блокирует {ruTasksCountLabel(dep.blockingCount)}
            {blockingTitles ? <span className="dep-tag__names"> — {blockingTitles}</span> : null}
          </span>
        </div>
      )}
    </div>
  )
}

function TaskLightPanel({
  task,
  tasks,
  projectId,
  projectName,
  assigneeUsers,
  currentUser,
  supabase,
  apiConnected,
  onUpdateTask,
  onDeleteTask,
  onCopyTaskLink,
  onClose,
  refresh,
}) {
  const [titleDraft, setTitleDraft] = useState(task.title)
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? '')
  const [depEditOpen, setDepEditOpen] = useState(false)
  const [depSearch, setDepSearch] = useState('')
  const [commentText, setCommentText] = useState('')
  const [attachmentError, setAttachmentError] = useState(null)
  const [uploading, setUploading] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const depRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    setTitleDraft(task.title)
    setDescriptionDraft(task.description ?? '')
    setDepEditOpen(false)
    setDepSearch('')
    setCommentText('')
    setAttachmentError(null)
    setUploading([])
  }, [task.id, task.title, task.description])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useEffect(() => {
    if (!depEditOpen) return
    const onDoc = (e) => {
      if (depRef.current && !depRef.current.contains(e.target)) {
        setDepEditOpen(false)
        setDepSearch('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [depEditOpen])

  const depMeta = getDependencyMeta(task, tasks)
  const comments = task.comments ?? []
  const priorityKey = normalizeTaskPriority(task.priority)

  const saveTitle = () => {
    const title = titleDraft.trim()
    if (!title || title === task.title) {
      setTitleDraft(task.title)
      return
    }
    onUpdateTask(task.id, { title })
  }

  const saveDescription = () => {
    const value = descriptionDraft.trim()
    if (value === (task.description ?? '')) return
    onUpdateTask(task.id, { description: value })
  }

  const submitComment = () => {
    const text = commentText.trim()
    if (!text) return
    if (!apiConnected) {
      setAttachmentError('Комментарии недоступны без подключения к серверу')
      return
    }
    void (async () => {
      try {
        await insertCommentRemote(supabase, {
          id: crypto.randomUUID(),
          taskId: task.id,
          authorId: currentUser.id,
          body: text,
        })
        await refresh()
        setCommentText('')
        setAttachmentError(null)
      } catch (e) {
        console.error(e)
        setAttachmentError(formatSupabaseError(e))
      }
    })()
  }

  const removeComment = (commentId) => {
    if (!apiConnected) return
    void (async () => {
      try {
        await deleteCommentRemote(supabase, commentId)
        await refresh()
      } catch (e) {
        console.error(e)
        setAttachmentError(formatSupabaseError(e))
      }
    })()
  }

  const attachments = task.attachments ?? []

  const removeAttachment = async (attachmentId) => {
    const att = attachments.find((a) => a.id === attachmentId)
    if (!att) return
    const isBlob = att.fileUrl?.startsWith('blob:')
    if (apiConnected && !isBlob) {
      try {
        await deleteTaskAttachmentRemote(supabase, att)
        await refresh()
      } catch (e) {
        console.error(e)
        setAttachmentError('Не удалось удалить файл')
        return
      }
      return
    }
    if (isBlob) URL.revokeObjectURL(att.fileUrl)
    void refresh()
  }

  const addFilesFromList = async (fileList) => {
    const files = [...fileList].filter((f) => f && f.size > 0)
    if (files.length === 0) return
    let total = sumAttachmentBytes(attachments)
    for (const file of files) {
      const v = validateTaskAttachment(file, total)
      if (!v.ok) {
        setAttachmentError(v.message)
        continue
      }
      const uploadId = `up-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setUploading((u) => [...u, { id: uploadId, fileName: file.name, progress: 0 }])
      try {
        await readFileForProgress(file, (p) => {
          setUploading((u) => u.map((x) => (x.id === uploadId ? { ...x, progress: p } : x)))
        })
        if (!apiConnected || !projectId) {
          setAttachmentError('Загрузка файлов недоступна')
          continue
        }
        await uploadTaskAttachment(supabase, task.id, projectId, file, currentUser.id)
        total += file.size
        await refresh()
        setAttachmentError(null)
      } catch (e) {
        console.error(e)
        setAttachmentError('Ошибка загрузки')
      } finally {
        setUploading((u) => u.filter((x) => x.id !== uploadId))
      }
    }
  }

  const onPickFiles = () => fileInputRef.current?.click()

  const onFileInputChange = (e) => {
    const fl = e.target.files
    if (fl?.length) void addFilesFromList(fl)
    e.target.value = ''
  }

  const onPanelDragEnter = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.dataTransfer?.types?.includes('Files')) return
    const prev = e.relatedTarget
    if (prev instanceof Node && e.currentTarget.contains(prev)) return
    setDragOver(true)
  }

  const onPanelDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const next = e.relatedTarget
    if (next instanceof Node && e.currentTarget.contains(next)) return
    setDragOver(false)
  }

  const onPanelDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const onPanelDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const fl = e.dataTransfer?.files
    if (fl?.length) void addFilesFromList(fl)
  }

  const depCandidates = tasks
    .filter((t) => t.id !== task.id && !t.parentTaskId)
    .filter((t) => !depSearch.trim() || t.title.toLowerCase().includes(depSearch.trim().toLowerCase()))

  return (
    <div className="task-overlay" role="presentation" onClick={onClose}>
      <article
        className={`task-panel${dragOver ? ' task-panel--drag-over' : ''}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onDragEnter={onPanelDragEnter}
        onDragLeave={onPanelDragLeave}
        onDragOver={onPanelDragOver}
        onDrop={onPanelDrop}
      >
        <header className="task-panel__head">
          <div className="task-panel__topline">
            <p className="task-panel__eyebrow">
              {task.parentTaskId ? 'Подзадача' : 'Задача'} • {projectName} •{' '}
              <span className={`task-panel__priority-eyebrow task-panel__priority-eyebrow--${priorityKey}`}>
                {priorityLabel(task.priority)}
              </span>
            </p>
            <div className="task-panel__icon-actions">
              <button
                type="button"
                className="task-panel__icon-btn"
                onClick={() => onCopyTaskLink(task.id)}
                aria-label="Скопировать ссылку на задачу"
                title="Скопировать ссылку"
              >
                🔗
              </button>
              <button type="button" className="task-panel__icon-btn" onClick={onClose} aria-label="Закрыть">
                ✕
              </button>
            </div>
          </div>

          <div className="task-panel__title-row">
            <span className={`task-panel__status-dot ${getStatusClass(task.status)}`} aria-hidden />
            <input
              className="task-panel__title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  saveTitle()
                }
              }}
            />
          </div>

          <div className="task-panel__meta-row">
            <span className="task-panel__pill task-panel__pill--status">
              ●
              <select
                value={task.status}
                onChange={(e) => onUpdateTask(task.id, { status: e.target.value })}
              >
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </span>
            <span className="task-panel__pill task-panel__pill--deadline">
              📅
              <input
                type="date"
                value={task.deadline}
                onChange={(e) => onUpdateTask(task.id, { deadline: e.target.value })}
              />
            </span>
            <span className="task-panel__pill task-panel__pill--assignee">
              👤
              <select
                value={assigneeSelectValue(task, assigneeUsers)}
                onChange={(e) =>
                  onUpdateTask(task.id, { assigneeUserId: e.target.value || null })
                }
              >
                <option value="">Не назначен</option>
                {assigneeUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </span>
            <span className={`task-panel__pill task-panel__pill--priority task-panel__pill--priority-${priorityKey}`}>
              <span className={`task-panel__priority-dot task-panel__priority-dot--${priorityKey}`} aria-hidden>
                ●
              </span>
              <select
                value={priorityKey}
                onChange={(e) =>
                  onUpdateTask(task.id, { priority: normalizeTaskPriority(e.target.value) })
                }
                aria-label="Приоритет"
              >
                {TASK_PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </header>

        <div className="task-panel__body">
          <section className="task-panel__section">
            <div className="task-panel__section-head">
              <h3 className="heading-h3">Описание</h3>
            </div>
            <textarea
              className="task-panel__description"
              placeholder="Добавьте краткое описание задачи"
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              onBlur={saveDescription}
            />
          </section>

          <section className="task-panel__section">
            <div className="task-panel__section-head">
              <h3 className="heading-h3">Зависимости</h3>
              <button type="button" className="btn-secondary" onClick={() => setDepEditOpen((v) => !v)}>
                Изменить
              </button>
            </div>
            <div className="task-panel__dependencies">
              {depMeta.isBlocked ? (
                <div className="task-panel__dep-item">
                  <strong>Ждёт: {depMeta.parentTitle}</strong>
                </div>
              ) : (
                <div className="task-panel__dep-item task-panel__dep-item--muted">Нет родительской зависимости</div>
              )}
              {depMeta.dependents.length > 0 && (
                <div className="task-panel__dep-item">
                  <strong>Блокирует:</strong> {depMeta.dependents.map((d) => d.title).join(', ')}
                </div>
              )}
            </div>
            {depEditOpen && (
              <div className="task-panel__dep-editor" ref={depRef}>
                <input
                  value={depSearch}
                  onChange={(e) => setDepSearch(e.target.value)}
                  placeholder="Поиск задачи"
                />
                <button
                  type="button"
                  className="btn-secondary btn-secondary--block"
                  onClick={() => onUpdateTask(task.id, { dependsOnTaskId: null })}
                >
                  Без зависимости
                </button>
                <ul>
                  {depCandidates.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="btn-secondary btn-secondary--block"
                        onClick={() => {
                          onUpdateTask(task.id, { dependsOnTaskId: c.id })
                          setDepEditOpen(false)
                          setDepSearch('')
                        }}
                      >
                        {c.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="task-panel__section">
            <div className="task-panel__section-head">
              <h3 className="heading-h3">Комментарии</h3>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="task-panel__file-input"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={onFileInputChange}
            />
            <div className="task-panel__comments">
              {comments.length === 0 && attachments.length === 0 && uploading.length === 0 ? (
                <div className="task-panel__comment-empty">Пока нет комментариев</div>
              ) : null}
              {comments.map((c) => (
                <div key={c.id} className="task-panel__comment">
                  <span className="task-panel__comment-avatar">{getInitials(c.author)}</span>
                  <div className="task-panel__comment-body">
                    <strong>
                      {c.author} <span>{c.time}</span>
                    </strong>
                    <p>{c.text}</p>
                  </div>
                  <button
                    type="button"
                    className="task-panel__comment-remove"
                    aria-label="Удалить комментарий"
                    onClick={() => removeComment(c.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {attachments.map((a) => (
                <div key={a.id} className="task-panel__attachment-row">
                  <a
                    href={a.fileUrl}
                    download={a.fileName}
                    className="task-panel__attachment-name"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {a.fileName}
                  </a>
                  <button
                    type="button"
                    className="task-panel__attachment-remove"
                    aria-label={`Удалить ${a.fileName}`}
                    onClick={() => removeAttachment(a.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {uploading.map((u) => (
                <div key={u.id} className="task-panel__attachment-row task-panel__attachment-row--loading">
                  <span className="task-panel__attachment-name">{u.fileName}</span>
                  <span className="task-panel__attachment-progress" aria-hidden>
                    <span style={{ width: `${u.progress}%` }} />
                  </span>
                </div>
              ))}
              {attachmentError ? (
                <p className="task-panel__attachment-error" role="alert">
                  {attachmentError}
                </p>
              ) : null}
            </div>
            <div className="task-panel__comment-input">
              <div className="task-panel__comment-field">
                <textarea
                  placeholder="Добавить комментарий..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      submitComment()
                    }
                  }}
                />
                <button
                  type="button"
                  className="task-panel__clip-btn"
                  aria-label="Прикрепить файл"
                  title="Прикрепить файл"
                  onClick={onPickFiles}
                >
                  📎
                </button>
              </div>
              <div className="task-panel__comment-actions">
                <button type="button" className="btn-primary" onClick={submitComment}>
                  Отправить
                </button>
              </div>
            </div>
          </section>
        </div>

        <footer className="task-panel__footer">
          {task.status !== 'Готово' ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => onUpdateTask(task.id, { status: 'Готово' })}
            >
              Завершить
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary btn-secondary--danger"
            onClick={() => onDeleteTask(task.id)}
          >
            Удалить задачу
          </button>
        </footer>
      </article>
    </div>
  )
}

function App() {
  const {
    supabase,
    session,
    profile,
    profileError,
    profileLoading,
    loading: authLoading,
    signIn,
    signOut,
    configured,
    refreshProfile,
    devLoginAny,
  } = useAuth()
  const apiConnected = canUseDataApi(supabase)
  const currentUserId = session?.user?.id ?? null

  const currentUser = useMemo(() => {
    if (!session?.user?.id || !profile) return null
    const id = session.user.id
    const hash = [...id].reduce((a, c) => a + c.charCodeAt(0), 0)
    const displayName = (profile.name || '').trim() || 'Пользователь'
    return {
      id,
      name: displayName,
      avatarUrl: profile.avatar_url || undefined,
      avatarColor: USER_AVATAR_COLORS[Math.abs(hash) % USER_AVATAR_COLORS.length],
    }
  }, [session, profile])

  const dataEnabled = Boolean(configured && currentUserId && profile && !profileError)
  const { topics, projects, users, loading: dataLoading, refresh } = useTrackerData(
    supabase,
    currentUserId,
    dataEnabled,
  )

  const saveUserDisplayName = useCallback(
    async (name) => {
      if (!apiConnected || !currentUserId) throw new Error('Нет подключения')
      await updateProfileNameRemote(supabase, currentUserId, name)
      await refreshProfile()
      await refresh()
    },
    [apiConnected, supabase, currentUserId, refreshProfile, refresh],
  )

  const [mineFilterActive, setMineFilterActive] = useState(false)

  useEffect(() => {
    if (!currentUserId) {
      setMineFilterActive(false)
      return
    }
    setMineFilterActive(readMineFilterForUser(currentUserId))
  }, [currentUserId])

  useEffect(() => {
    if (!currentUserId) return
    try {
      localStorage.setItem(mineFilterStorageKey(currentUserId), mineFilterActive ? 'true' : 'false')
    } catch {
      /* ignore */
    }
  }, [mineFilterActive, currentUserId])

  /** Глобально: автосдвиг зависимых по FS при изменении дедлайна (гант + формы). */
  const [autoShiftDependents, setAutoShiftDependents] = useState(true)

  const [selectedProjectId, setSelectedProjectId] = useState('')
  /** Фильтр проектов по теме: all | none | topicId */
  const [selectedTopicFilter, setSelectedTopicFilter] = useState('all')
  const [selectedTaskIds, setSelectedTaskIds] = useState([])
  /** `${projectId}:${milestoneId}` → развёрнут блок завершённых */
  const [expandedCompletedSections, setExpandedCompletedSections] = useState({})
  const [editingCompletedTaskId, setEditingCompletedTaskId] = useState(null)
  const [editingCompletedDraft, setEditingCompletedDraft] = useState({
    title: '',
    assigneeUserId: '',
    deadline: todayLocalDate(),
  })
  const [expandedMilestonesByProject, setExpandedMilestonesByProject] = useState({})
  const [milestoneAssigneeFilters, setMilestoneAssigneeFilters] = useState({})
  const [milestonePlan, setMilestonePlan] = useState({})
  const [violatingTaskIds, setViolatingTaskIds] = useState([])
  const [dependencyError, setDependencyError] = useState(null)
  const [taskMoveNotice, setTaskMoveNotice] = useState(null)
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  const [dragSourceMilestoneKey, setDragSourceMilestoneKey] = useState(null)
  const [dragOverMilestoneKey, setDragOverMilestoneKey] = useState(null)
  const moveTaskToMilestoneLockRef = useRef(false)
  const [showNewProjectModal, setShowNewProjectModal] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  /** Тема для нового проекта (null — без темы). */
  const [newProjectTopicId, setNewProjectTopicId] = useState(null)
  const [showNewTopicModal, setShowNewTopicModal] = useState(false)
  const [newTopicDraft, setNewTopicDraft] = useState('')
  const [showRenameProjectModal, setShowRenameProjectModal] = useState(false)
  const [renameProjectDraft, setRenameProjectDraft] = useState('')
  const [renameProjectTopicId, setRenameProjectTopicId] = useState(null)
  const [showEditTopicModal, setShowEditTopicModal] = useState(false)
  const [editTopicDraft, setEditTopicDraft] = useState('')
  const [editTopicId, setEditTopicId] = useState(null)
  const [openedTaskId, setOpenedTaskId] = useState(null)
  const [pendingTaskLink, setPendingTaskLink] = useState(() => readTaskLinkFromUrl())
  const [urlSyncEnabled, setUrlSyncEnabled] = useState(() => !readTaskLinkFromUrl().taskId)
  const taskLinkRetryRef = useRef(new Set())
  const [editingMilestoneTitleId, setEditingMilestoneTitleId] = useState(null)
  const [editingMilestoneTitleDraft, setEditingMilestoneTitleDraft] = useState('')
  const [milestoneMenuOpenId, setMilestoneMenuOpenId] = useState(null)
  const [addingMilestoneOpen, setAddingMilestoneOpen] = useState(false)
  const [newMilestoneNameDraft, setNewMilestoneNameDraft] = useState('')
  const addMilestoneInputRef = useRef(null)
  const addMilestoneAnchorRef = useRef(null)
  const newMilestoneFieldId = useId()
  /** Раскрытые блоки подзадач у корневой задачи (только id корня). */
  const [expandedSubtaskParents, setExpandedSubtaskParents] = useState(() => new Set())

  const visibleProjects = useMemo(() => {
    if (selectedTopicFilter === 'all') return projects
    if (selectedTopicFilter === 'none') return projects.filter((p) => !p.topicId)
    return projects.filter((p) => p.topicId === selectedTopicFilter)
  }, [projects, selectedTopicFilter])
  const selectedTopicLabel = useMemo(() => {
    if (selectedTopicFilter === 'all') return 'Все темы'
    if (selectedTopicFilter === 'none') return 'Без темы'
    return topics.find((t) => t.id === selectedTopicFilter)?.name ?? 'Тема'
  }, [selectedTopicFilter, topics])
  const topicProjectCounts = useMemo(() => {
    const byId = new Map()
    let none = 0
    for (const p of projects) {
      if (!p.topicId) {
        none += 1
        continue
      }
      byId.set(p.topicId, (byId.get(p.topicId) ?? 0) + 1)
    }
    return { all: projects.length, none, byId }
  }, [projects])
  const projectsByTopic = useMemo(() => {
    const byTopic = new Map()
    const withoutTopic = []
    for (const p of projects) {
      if (!p.topicId) {
        withoutTopic.push(p)
        continue
      }
      const arr = byTopic.get(p.topicId)
      if (arr) arr.push(p)
      else byTopic.set(p.topicId, [p])
    }
    return { byTopic, withoutTopic }
  }, [projects])
  const groupedVisibleProjects = useMemo(() => {
    if (selectedTopicFilter === 'all') {
      const groups = []
      if (projectsByTopic.withoutTopic.length) {
        groups.push({
          key: 'none',
          label: 'Без темы',
          projects: projectsByTopic.withoutTopic,
        })
      }
      for (const t of topics) {
        const grouped = projectsByTopic.byTopic.get(t.id) ?? []
        if (grouped.length) groups.push({ key: t.id, label: t.name, projects: grouped })
      }
      return groups
    }
    if (selectedTopicFilter === 'none') {
      return [{ key: 'none', label: 'Без темы', projects: projectsByTopic.withoutTopic }]
    }
    return [
      {
        key: selectedTopicFilter,
        label: topics.find((t) => t.id === selectedTopicFilter)?.name ?? 'Тема',
        projects: projectsByTopic.byTopic.get(selectedTopicFilter) ?? [],
      },
    ]
  }, [selectedTopicFilter, topics, projectsByTopic])

  const resolvedSelectedProjectId = useMemo(() => {
    if (!visibleProjects.length) return ''
    if (selectedProjectId && visibleProjects.some((p) => p.id === selectedProjectId)) return selectedProjectId
    return visibleProjects[0].id
  }, [visibleProjects, selectedProjectId])

  const selectedProject = useMemo(
    () =>
      resolvedSelectedProjectId
        ? visibleProjects.find((project) => project.id === resolvedSelectedProjectId) ?? null
        : null,
    [visibleProjects, resolvedSelectedProjectId],
  )
  const openedTask = useMemo(
    () => selectedProject?.tasks.find((t) => t.id === openedTaskId) ?? null,
    [selectedProject, openedTaskId],
  )
  const tasksIndexById = useMemo(() => {
    const byId = new Map()
    for (const project of projects) {
      for (const task of project.tasks ?? []) {
        byId.set(normalizeEntityId(task.id), { task, projectId: project.id, topicId: project.topicId ?? null })
      }
    }
    return byId
  }, [projects])

  /** Все вехи + «Без вехи» — состояние по умолчанию (развернуто). */
  const allExpandedMilestoneIds = useMemo(() => {
    if (!selectedProject) return [ungroupedMilestoneId]
    return [ungroupedMilestoneId, ...selectedProject.milestones.map((m) => m.id)]
  }, [selectedProject])

  const expandedMilestoneIdsResolved =
    expandedMilestonesByProject[resolvedSelectedProjectId] ?? allExpandedMilestoneIds

  useEffect(() => {
    if (visibleProjects.length === 0) return
    const valid = Boolean(selectedProjectId && visibleProjects.some((p) => p.id === selectedProjectId))
    if (!valid) setSelectedProjectId(visibleProjects[0].id)
  }, [visibleProjects, selectedProjectId])

  useEffect(() => {
    if (selectedTopicFilter === 'all' || selectedTopicFilter === 'none') return
    if (!topics.some((t) => t.id === selectedTopicFilter)) {
      setSelectedTopicFilter('all')
    }
  }, [topics, selectedTopicFilter])

  useEffect(() => {
    setEditingMilestoneTitleId(null)
    setMilestoneMenuOpenId(null)
    setAddingMilestoneOpen(false)
    setNewMilestoneNameDraft('')
  }, [selectedProjectId])

  useEffect(() => {
    if (!addingMilestoneOpen) return
    addMilestoneAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const t = window.setTimeout(() => {
      addMilestoneInputRef.current?.focus()
    }, 380)
    return () => window.clearTimeout(t)
  }, [addingMilestoneOpen])

  useEffect(() => {
    if (!milestoneMenuOpenId) return
    const onDoc = (e) => {
      if (e.target.closest(`[data-milestone-menu-root="${milestoneMenuOpenId}"]`)) return
      setMilestoneMenuOpenId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [milestoneMenuOpenId])

  useEffect(() => {
    const onPopState = () => {
      const link = readTaskLinkFromUrl()
      if (!link.taskId) {
        setPendingTaskLink(null)
        setOpenedTaskId(null)
        setUrlSyncEnabled(true)
        return
      }
      setPendingTaskLink(link)
      setUrlSyncEnabled(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!pendingTaskLink?.taskId) return
    if (!dataEnabled) return
    if (dataLoading) return
    const hit = tasksIndexById.get(pendingTaskLink.taskId)
    if (!hit) {
      // На проде дерево может приходить не с первой попытки: даём один авто-retry перед ошибкой.
      if (!taskLinkRetryRef.current.has(pendingTaskLink.taskId)) {
        taskLinkRetryRef.current.add(pendingTaskLink.taskId)
        void refresh()
        return
      }
      setPendingTaskLink(null)
      setUrlSyncEnabled(true)
      setOpenedTaskId(null)
      clearTaskLinkFromUrl()
      setDependencyError('Задача по ссылке не найдена или недоступна')
      return
    }
    taskLinkRetryRef.current.delete(pendingTaskLink.taskId)
    // По ссылке задача должна открыться всегда: снимаем фильтры, которые могут её скрыть.
    if (selectedTopicFilter !== 'all') setSelectedTopicFilter('all')
    if (mineFilterActive && currentUserId) {
      const assigneeId = resolveTaskAssigneeId(hit.task, users)
      if (assigneeId !== currentUserId) {
        setMineFilterActive(false)
      }
    }
    setSelectedProjectId(hit.projectId)
    setOpenedTaskId(hit.task.id)
    writeTaskLinkToUrl(hit.task.id, hit.projectId)
    setPendingTaskLink(null)
    setUrlSyncEnabled(true)
  }, [
    pendingTaskLink,
    dataEnabled,
    dataLoading,
    tasksIndexById,
    selectedTopicFilter,
    mineFilterActive,
    currentUserId,
    users,
    refresh,
  ])

  useEffect(() => {
    if (!urlSyncEnabled) return
    if (openedTaskId && resolvedSelectedProjectId) {
      writeTaskLinkToUrl(openedTaskId, resolvedSelectedProjectId)
      return
    }
    clearTaskLinkFromUrl()
  }, [urlSyncEnabled, openedTaskId, resolvedSelectedProjectId])

  const switchProject = (id) => {
    setSelectedProjectId(id)
    setSelectedTaskIds([])
    setViolatingTaskIds([])
    setDependencyError(null)
    setOpenedTaskId(null)
    setDraggingTaskId(null)
    setDragSourceMilestoneKey(null)
    setDragOverMilestoneKey(null)
    setTaskMoveNotice(null)
  }

  const createProject = async () => {
    const name = newProjectName.trim()
    if (!name || !apiConnected || !currentUserId) return
    try {
      const id = await createProjectRemote(supabase, name, currentUserId, newProjectTopicId)
      await refresh()
      setExpandedMilestonesByProject((prev) => ({
        ...prev,
        [id]: [ungroupedMilestoneId],
      }))
      setSelectedProjectId(id)
      setNewProjectName('')
      setNewProjectTopicId(null)
      setShowNewProjectModal(false)
      setSelectedTaskIds([])
      setViolatingTaskIds([])
      setDependencyError(null)
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось создать проект: ${formatSupabaseError(e)}`)
    }
  }

  const renameProject = async () => {
    const name = renameProjectDraft.trim()
    if (!name || !apiConnected || !resolvedSelectedProjectId) return
    try {
      await Promise.all([
        updateProjectTitleRemote(supabase, resolvedSelectedProjectId, name),
        updateProjectTopicRemote(supabase, resolvedSelectedProjectId, renameProjectTopicId ?? null),
      ])
      await refresh()
      setShowRenameProjectModal(false)
      setRenameProjectDraft('')
      setRenameProjectTopicId(null)
      setDependencyError(null)
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось переименовать проект: ${formatSupabaseError(e)}`)
    }
  }

  const removeProject = async () => {
    if (!apiConnected || !resolvedSelectedProjectId || !currentUserId) return
    if (!window.confirm('Удалить проект и все его задачи? Это действие необратимо.')) return
    try {
      await deleteProjectRemote(supabase, resolvedSelectedProjectId)
      await refresh()
      setShowRenameProjectModal(false)
      setRenameProjectDraft('')
      setRenameProjectTopicId(null)
      setSelectedProjectId('')
      setSelectedTaskIds([])
      setOpenedTaskId(null)
      setDependencyError(null)
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось удалить проект: ${formatSupabaseError(e)}`)
    }
  }

  const handleCreateTopic = async (title) => {
    if (!apiConnected || !currentUserId) return
    try {
      await createTopicRemote(supabase, title, currentUserId)
      await refresh()
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось создать тему: ${formatSupabaseError(e)}`)
    }
  }

  const handleRenameTopic = async (topicId, title) => {
    if (!apiConnected) return
    try {
      await updateTopicTitleRemote(supabase, topicId, title)
      await refresh()
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось переименовать тему: ${formatSupabaseError(e)}`)
    }
  }

  const handleDeleteTopic = async (topicId) => {
    if (!apiConnected) return
    try {
      await deleteTopicRemote(supabase, topicId)
      await refresh()
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось удалить тему: ${formatSupabaseError(e)}`)
    }
  }

  const createTopicFromModal = async () => {
    const title = (newTopicDraft || '').trim()
    if (!title) return
    await handleCreateTopic(title)
    setShowNewTopicModal(false)
    setNewTopicDraft('')
  }

  const openEditTopicModal = () => {
    const topicId =
      selectedTopicFilter !== 'all' && selectedTopicFilter !== 'none'
        ? selectedTopicFilter
        : (selectedProject?.topicId ?? null)
    if (!topicId) {
      setDependencyError('Выберите тему в фильтре или проект внутри темы')
      return
    }
    const topic = topics.find((t) => t.id === topicId)
    if (!topic) return
    setEditTopicId(topic.id)
    setEditTopicDraft(topic.name)
    setShowEditTopicModal(true)
  }

  const saveEditedTopic = async () => {
    const title = (editTopicDraft || '').trim()
    if (!editTopicId || !title) return
    await handleRenameTopic(editTopicId, title)
    setShowEditTopicModal(false)
    setEditTopicId(null)
    setEditTopicDraft('')
  }

  const removeEditedTopic = async () => {
    if (!editTopicId) return
    if (!window.confirm('Удалить тему? Проекты останутся без темы.')) return
    await handleDeleteTopic(editTopicId)
    setShowEditTopicModal(false)
    setEditTopicId(null)
    setEditTopicDraft('')
  }

  const groupedMilestones = useMemo(() => {
    if (!selectedProject) return []
    return [
      { id: ungroupedMilestoneId, name: 'Без вехи' },
      ...selectedProject.milestones,
    ]
  }, [selectedProject])

  /** Корневые задачи (подзадачи — под родителем в таблице). Гант и «ближайшие» — только корни, без подзадач. */
  const visibleTasks = useMemo(() => {
    if (!selectedProject) return []
    const roots = selectedProject.tasks.filter((t) => !t.parentTaskId)
    if (!mineFilterActive || !currentUserId) return roots
    return roots.filter((t) => resolveTaskAssigneeId(t, users) === currentUserId)
  }, [selectedProject, mineFilterActive, currentUserId, users])

  const subtasksByParentId = useMemo(() => {
    if (!selectedProject) return {}
    const map = {}
    for (const t of selectedProject.tasks) {
      if (!t.parentTaskId) continue
      if (!map[t.parentTaskId]) map[t.parentTaskId] = []
      map[t.parentTaskId].push(t)
    }
    for (const k of Object.keys(map)) {
      map[k] = map[k].slice().sort((a, b) => toDate(a.deadline) - toDate(b.deadline))
    }
    return map
  }, [selectedProject])

  const countTasksForProject = useCallback(
    (project) => {
      const roots = project.tasks.filter((t) => !t.parentTaskId && t.status !== 'Готово')
      if (!mineFilterActive || !currentUserId) return roots.length
      return roots.filter((t) => resolveTaskAssigneeId(t, users) === currentUserId).length
    },
    [mineFilterActive, currentUserId, users],
  )

  const matchesMilestoneAssigneeFilter = useCallback(
    (task, filterValue) => {
      if (!filterValue || filterValue === 'all') return true
      const assigneeId = resolveTaskAssigneeId(task, users)
      if (filterValue === 'none') return !assigneeId
      return assigneeId === filterValue
    },
    [users],
  )

  const tasksByMilestone = useMemo(() => {
    if (!selectedProject) return {}
    const map = Object.fromEntries(groupedMilestones.map((m) => [m.id, []]))
    visibleTasks.forEach((task) => {
      const key = task.milestoneId ?? ungroupedMilestoneId
      if (!map[key]) map[key] = []
      map[key].push(task)
    })
    Object.keys(map).forEach((key) => {
      map[key] = map[key].slice().sort((a, b) => toDate(a.deadline) - toDate(b.deadline))
    })
    return map
  }, [selectedProject, groupedMilestones, visibleTasks])

  const milestonesToRender = useMemo(() => {
    if (!mineFilterActive) return groupedMilestones
    return groupedMilestones.filter((m) => (tasksByMilestone[m.id] ?? []).length > 0)
  }, [mineFilterActive, groupedMilestones, tasksByMilestone])

  const projectDeadline = useMemo(() => {
    if (!selectedProject) return null
    return maxDate(visibleTasks.map((task) => task.deadline))
  }, [selectedProject, visibleTasks])

  /** Макс. дедлайн по активным задачам вехи — для сдвига задач и сравнения с целью. */
  const taskDerivedMilestoneDeadline = (milestoneId) => {
    const active = (tasksByMilestone[milestoneId] ?? []).filter((t) => t.status !== 'Готово')
    return maxDate(active.map((task) => task.deadline))
  }

  /** Для UI и диаграммы: дедлайн вехи из БД или по задачам. */
  const milestoneDeadline = (milestoneId) => {
    if (milestoneId === ungroupedMilestoneId) return taskDerivedMilestoneDeadline(milestoneId)
    const m = selectedProject?.milestones.find((x) => x.id === milestoneId)
    if (m?.deadline) return m.deadline
    return taskDerivedMilestoneDeadline(milestoneId)
  }

  const updateTask = (taskId, patch) => {
    const { comments: _pc, attachments: _pa, ...patchRest } = patch
    let patchWithActor =
      currentUserId != null ? { ...patchRest, updatedBy: currentUserId } : patchRest
    if (patch.assigneeUserId !== undefined) {
      const id = patch.assigneeUserId
      const u = id ? users.find((x) => x.id === id) : null
      patchWithActor = { ...patchWithActor, assignee: u?.name ?? '', assigneeId: u?.id ?? null }
    }
    if (patch.assignee !== undefined) {
      const n = (patch.assignee || '').trim()
      const u = n ? findUserByName(users, n) : null
      patchWithActor = { ...patchWithActor, assignee: n, assigneeId: u ? u.id : null }
    }

    void (async () => {
      const project = projects.find((p) => p.id === resolvedSelectedProjectId)
      if (!project || !apiConnected || !currentUserId || !dataEnabled) {
        if (!apiConnected || !currentUserId || !dataEnabled) {
          setDependencyError('Сохранение недоступно: нет подключения или авторизации')
        }
        return
      }
      const oldTask = project.tasks.find((t) => t.id === taskId)
      if (!oldTask) return

      if (patchWithActor.dependsOnTaskId !== undefined) {
        if (
          patchWithActor.dependsOnTaskId &&
          wouldDependencyCreateCycle(project.tasks, taskId, patchWithActor.dependsOnTaskId)
        ) {
          setDependencyError(DEPENDENCY_CYCLE_MESSAGE)
          return
        }
        setDependencyError(null)
      }

      let merged = { ...oldTask, ...patchWithActor }
      let tasks = project.tasks.map((t) => (t.id === taskId ? merged : t))

      // При завершении корневой задачи автоматически переводим её подзадачи в "Готово",
      // чтобы они попадали в блок "Завершённые" вместе с родителем.
      if (patchWithActor.status === 'Готово' && !oldTask.parentTaskId) {
        tasks = tasks.map((t) =>
          t.parentTaskId === taskId && t.status !== 'Готово'
            ? { ...t, status: 'Готово', updatedBy: currentUserId }
            : t,
        )
      }

      if (patchWithActor.dependsOnTaskId !== undefined && merged.dependsOnTaskId) {
        const parent = tasks.find((t) => t.id === merged.dependsOnTaskId)
        if (parent) {
          merged = rescheduleChildFromParent(parent, merged)
          tasks = tasks.map((t) => (t.id === taskId ? merged : t))
        }
      }

      if (merged.deadline !== oldTask.deadline && autoShiftDependents) {
        tasks = cascadeFsShiftFromParent(tasks, merged)
      }

      try {
        await persistProjectTasksDelta(supabase, project.id, currentUserId, project.tasks, tasks)
        await refresh()
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const applyGanttTaskDates = useCallback(
    (taskId, newStart, newDeadline) => {
      if (!selectedProject) return
      const result = tryApplyTaskDateChange(
        selectedProject,
        taskId,
        newStart,
        newDeadline,
        autoShiftDependents,
      )
      if (!result.ok) {
        setDependencyError(result.message)
        return
      }
      setDependencyError(null)
      if (!apiConnected || !currentUserId || !dataEnabled) return
      void (async () => {
        try {
          await persistProjectTasksDelta(
            supabase,
            selectedProject.id,
            currentUserId,
            selectedProject.tasks,
            result.tasks,
          )
          await refresh()
        } catch (e) {
          console.error(e)
          setDependencyError(formatSupabaseError(e))
        }
      })()
    },
    [selectedProject, autoShiftDependents, apiConnected, supabase, currentUserId, dataEnabled, refresh],
  )

  const toggleTaskSelection = (taskId) => {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    )
  }

  const performMoveTaskToMilestone = useCallback(
    async (taskId, targetMilestoneKey) => {
      if (!selectedProject || moveTaskToMilestoneLockRef.current) return
      const v = validateTaskMilestoneMove(
        selectedProject,
        taskId,
        targetMilestoneKey,
        ungroupedMilestoneId,
      )
      if (v.noOp) return
      if (!v.ok) {
        setTaskMoveNotice({ variant: 'error', text: v.message })
        return
      }
      const newMilestoneId = targetMilestoneKey === ungroupedMilestoneId ? null : targetMilestoneKey
      if (!apiConnected || !currentUserId || !dataEnabled) {
        setTaskMoveNotice({ variant: 'error', text: 'Сохранение недоступно' })
        return
      }
      moveTaskToMilestoneLockRef.current = true
      try {
        await updateTaskMilestoneRemote(supabase, taskId, currentUserId, newMilestoneId)
        const childIds = selectedProject.tasks.filter((t) => t.parentTaskId === taskId).map((t) => t.id)
        for (const cid of childIds) {
          await updateTaskMilestoneRemote(supabase, cid, currentUserId, newMilestoneId)
        }
        await refresh()
        setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
        setDependencyError(null)
        setExpandedMilestonesByProject((prev) => ({
          ...prev,
          [resolvedSelectedProjectId]: [
            ...new Set([...(prev[resolvedSelectedProjectId] ?? allExpandedMilestoneIds), targetMilestoneKey]),
          ],
        }))
        setTaskMoveNotice({ variant: 'success', text: 'Задача перемещена' })
      } catch (e) {
        console.error(e)
        setTaskMoveNotice({
          variant: 'error',
          text: formatSupabaseError(e) || 'Не удалось сохранить перемещение',
        })
      } finally {
        moveTaskToMilestoneLockRef.current = false
      }
    },
    [selectedProject, resolvedSelectedProjectId, apiConnected, supabase, currentUserId, dataEnabled, refresh, allExpandedMilestoneIds],
  )

  useEffect(() => {
    if (!taskMoveNotice) return
    const ms = taskMoveNotice.variant === 'error' ? 8000 : 4500
    const t = window.setTimeout(() => setTaskMoveNotice(null), ms)
    return () => clearTimeout(t)
  }, [taskMoveNotice])

  /** Корни, видимые в таблице вех (учёт «Мои»). Подзадачи считаем видимыми, если виден родитель-корень. */
  const selectedActiveCount = useMemo(() => {
    if (!selectedProject) return 0
    const visibleRootIds = new Set(visibleTasks.map((t) => t.id))
    const isSelectableActive = (id) => {
      const t = selectedProject.tasks.find((x) => x.id === id)
      if (!t || t.status === 'Готово') return false
      if (visibleRootIds.has(id)) return true
      if (!t.parentTaskId) return false
      const parent = selectedProject.tasks.find((p) => p.id === t.parentTaskId)
      return Boolean(parent && !parent.parentTaskId && visibleRootIds.has(parent.id))
    }
    return selectedTaskIds.filter(isSelectableActive).length
  }, [selectedProject, selectedTaskIds, visibleTasks])

  useEffect(() => {
    if (!selectedProject) return
    setSelectedTaskIds((prev) => {
      const visibleRootIds = new Set(visibleTasks.map((t) => t.id))
      const stillSelectable = (id) => {
        const t = selectedProject.tasks.find((x) => x.id === id)
        if (!t || t.status === 'Готово') return false
        if (visibleRootIds.has(id)) return true
        if (!t.parentTaskId) return false
        const parent = selectedProject.tasks.find((p) => p.id === t.parentTaskId)
        return Boolean(parent && !parent.parentTaskId && visibleRootIds.has(parent.id))
      }
      let next = prev.filter(stillSelectable)
      return next.length === prev.length ? prev : next
    })
  }, [selectedProject, selectedProject?.tasks, visibleTasks])

  const visibleViolatingTaskIds = useMemo(() => {
    if (!selectedProject) return []
    return violatingTaskIds.filter((id) => {
      const task = selectedProject.tasks.find((t) => t.id === id)
      if (!task) return false
      if (!mineFilterActive || !currentUserId) return true
      return resolveTaskAssigneeId(task, users) === currentUserId
    })
  }, [violatingTaskIds, selectedProject, mineFilterActive, currentUserId, users])

  useEffect(() => {
    if (!openedTaskId || !selectedProject) return
    if (!mineFilterActive || !currentUserId) return
    const t = selectedProject.tasks.find((x) => x.id === openedTaskId)
    if (!t) {
      setOpenedTaskId(null)
      return
    }
    if (!t.parentTaskId) {
      if (!visibleTasks.some((x) => x.id === t.id)) setOpenedTaskId(null)
      return
    }
    const parent = selectedProject.tasks.find((x) => x.id === t.parentTaskId)
    if (!parent || !visibleTasks.some((x) => x.id === parent.id)) setOpenedTaskId(null)
  }, [mineFilterActive, openedTaskId, selectedProject, visibleTasks, currentUserId])

  const bulkCompleteSelected = () => {
    if (!selectedProject || !apiConnected || !currentUserId || !dataEnabled) return
    const ids = selectedTaskIds.filter((id) => {
      const t = selectedProject.tasks.find((x) => x.id === id)
      return t && t.status !== 'Готово'
    })
    if (ids.length === 0) return
    const withChildren = new Set(ids)
    selectedProject.tasks.forEach((t) => {
      if (t.parentTaskId && withChildren.has(t.parentTaskId) && t.status !== 'Готово') {
        withChildren.add(t.id)
      }
    })
    const allIds = [...withChildren]
    void (async () => {
      try {
        await updateTasksStatusBulkRemote(supabase, currentUserId, allIds, 'Готово')
        await refresh()
        setSelectedTaskIds((prev) => prev.filter((id) => !allIds.includes(id)))
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const bulkDeleteSelected = () => {
    if (!selectedProject || !apiConnected || !dataEnabled) return
    const ids = selectedTaskIds.filter((id) => {
      const t = selectedProject.tasks.find((x) => x.id === id)
      return t && t.status !== 'Готово'
    })
    if (ids.length === 0) return
    void (async () => {
      try {
        for (const id of ids) {
          const t = selectedProject.tasks.find((x) => x.id === id)
          if (t) revokeTaskAttachmentUrls(t)
        }
        await deleteTasksBulkRemote(supabase, ids, currentUserId)
        await refresh()
        setSelectedTaskIds([])
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const deleteTaskById = (taskId) => {
    if (!window.confirm('Удалить задачу?')) return
    if (!apiConnected || !dataEnabled) {
      setDependencyError('Сохранение недоступно')
      return
    }
    void (async () => {
      const project = projects.find((p) => p.id === resolvedSelectedProjectId)
      const taskToKill = project?.tasks.find((t) => t.id === taskId)
      if (taskToKill) revokeTaskAttachmentUrls(taskToKill)
      try {
        await deleteTaskRemote(supabase, taskId, currentUserId)
        await refresh()
        setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
        setOpenedTaskId(null)
        if (editingCompletedTaskId === taskId) setEditingCompletedTaskId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const clearTaskSelection = () => setSelectedTaskIds([])

  const toggleCompletedSection = (milestoneId) => {
    const key = `${resolvedSelectedProjectId}:${milestoneId}`
    setExpandedCompletedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const restoreCompletedTask = (taskId) => {
    if (!apiConnected || !currentUserId || !dataEnabled) return
    void (async () => {
      try {
        await updateTasksStatusBulkRemote(supabase, currentUserId, [taskId], 'В работе')
        await refresh()
        if (editingCompletedTaskId === taskId) setEditingCompletedTaskId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const deleteCompletedTask = (taskId) => {
    if (!apiConnected || !dataEnabled) return
    void (async () => {
      const project = projects.find((p) => p.id === resolvedSelectedProjectId)
      const taskToKill = project?.tasks.find((t) => t.id === taskId)
      if (taskToKill) revokeTaskAttachmentUrls(taskToKill)
      try {
        await deleteTaskRemote(supabase, taskId, currentUserId)
        await refresh()
        if (editingCompletedTaskId === taskId) setEditingCompletedTaskId(null)
        if (openedTaskId === taskId) setOpenedTaskId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const beginEditCompletedTask = (task) => {
    setEditingCompletedTaskId(task.id)
    setEditingCompletedDraft({
      title: task.title,
      assigneeUserId: assigneeSelectValue(task, users),
      deadline: task.deadline,
    })
  }

  const saveEditCompletedTask = (taskId) => {
    const title = editingCompletedDraft.title.trim()
    if (!title) return
    const uid = editingCompletedDraft.assigneeUserId
    const assigneeUser = uid ? users.find((u) => u.id === uid) : null
    const project = projects.find((p) => p.id === resolvedSelectedProjectId)
    if (!project || !apiConnected || !currentUserId || !dataEnabled) return
    const newTasks = project.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            title,
            assignee: assigneeUser?.name ?? '',
            assigneeId: assigneeUser?.id,
            deadline: editingCompletedDraft.deadline,
            updatedBy: currentUserId,
          }
        : t,
    )
    void (async () => {
      try {
        await persistProjectTasksDelta(supabase, project.id, currentUserId, project.tasks, newTasks)
        await refresh()
        setEditingCompletedTaskId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const cancelEditCompletedTask = () => {
    setEditingCompletedTaskId(null)
  }

  const toggleMilestoneExpanded = (milestoneId) => {
    setExpandedMilestonesByProject((prev) => {
      const current = new Set(prev[resolvedSelectedProjectId] ?? allExpandedMilestoneIds)
      if (current.has(milestoneId)) current.delete(milestoneId)
      else current.add(milestoneId)
      return { ...prev, [resolvedSelectedProjectId]: [...current] }
    })
  }

  const shiftTasksByIds = (ids, days) => {
    if (!ids.length) return
    const idSet = new Set(ids)
    const project = projects.find((p) => p.id === resolvedSelectedProjectId)
    if (!project || !apiConnected || !currentUserId || !dataEnabled) return
    let tasks = project.tasks.map((task) =>
      idSet.has(task.id)
        ? {
            ...task,
            startDate: shiftDate(task.startDate, days),
            deadline: shiftDate(task.deadline, days),
          }
        : task,
    )
    if (autoShiftDependents) {
      for (const id of ids) {
        const parent = tasks.find((t) => t.id === id)
        if (parent) tasks = cascadeFsShiftFromParent(tasks, parent)
      }
    }
    void (async () => {
      try {
        await persistProjectTasksDelta(supabase, project.id, currentUserId, project.tasks, tasks)
        await refresh()
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const createTaskInMilestone = (milestoneId, { title, assigneeUserId, deadline, dependsOnTaskId, comment }) => {
    if (!title.trim() || !selectedProject) return
    if (!apiConnected || !currentUserId || !dataEnabled) {
      setDependencyError('Сохранение недоступно')
      return
    }
    const id = crypto.randomUUID()
    const milestoneIdResolved = milestoneId === ungroupedMilestoneId ? null : milestoneId

    const assigneeUser = assigneeUserId ? users.find((u) => u.id === assigneeUserId) : null
    const baseTask = {
      id,
      title: title.trim(),
      description: (comment || '').trim(),
      status: 'В работе',
      assignee: assigneeUser?.name ?? '',
      assigneeId: assigneeUser?.id,
      startDate: todayLocalDate(),
      deadline: deadline || todayLocalDate(),
      milestoneId: milestoneIdResolved,
      priority: 'medium',
      dependsOnTaskId: dependsOnTaskId || null,
      comment: '',
      attachments: [],
      comments: [],
      createdBy: currentUserId ?? undefined,
      updatedBy: currentUserId ?? undefined,
    }

    if (baseTask.dependsOnTaskId) {
      if (wouldDependencyCreateCycle(selectedProject.tasks, id, baseTask.dependsOnTaskId)) {
        setDependencyError(DEPENDENCY_CYCLE_MESSAGE)
        return
      }
      setDependencyError(null)
    } else {
      setDependencyError(null)
    }

    let merged = { ...baseTask }
    let tasks = [...selectedProject.tasks]

    if (merged.dependsOnTaskId) {
      const parent = tasks.find((t) => t.id === merged.dependsOnTaskId)
      if (parent) {
        merged = rescheduleChildFromParent(parent, merged)
      }
    }

    tasks = [...tasks, merged]

    void (async () => {
      try {
        await persistProjectTasksDelta(supabase, selectedProject.id, currentUserId, selectedProject.tasks, tasks)
        await refresh()
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const toggleSubtaskExpand = (parentId) => {
    setExpandedSubtaskParents((prev) => {
      const next = new Set(prev)
      if (prev.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }

  const createSubtaskFromQuickAdd = (parentId, { title, assigneeUserId, deadline, dependsOnTaskId, comment }) => {
    if (!title.trim() || !selectedProject) return
    const parent = selectedProject.tasks.find((t) => t.id === parentId)
    if (!parent || parent.parentTaskId) return
    if (!apiConnected || !currentUserId || !dataEnabled) {
      setDependencyError('Сохранение недоступно')
      return
    }
    const id = crypto.randomUUID()
    const assigneeUser = assigneeUserId ? users.find((u) => u.id === assigneeUserId) : null
    let merged = {
      id,
      parentTaskId: parentId,
      title: title.trim(),
      description: (comment || '').trim(),
      status: 'В работе',
      assignee: assigneeUser?.name ?? '',
      assigneeId: assigneeUser?.id,
      startDate: todayLocalDate(),
      deadline: deadline || todayLocalDate(),
      milestoneId: parent.milestoneId ?? null,
      priority: 'medium',
      dependsOnTaskId: dependsOnTaskId || null,
      comment: '',
      attachments: [],
      comments: [],
      createdBy: currentUserId ?? undefined,
      updatedBy: currentUserId ?? undefined,
    }
    if (merged.dependsOnTaskId) {
      if (wouldDependencyCreateCycle(selectedProject.tasks, id, merged.dependsOnTaskId)) {
        setDependencyError(DEPENDENCY_CYCLE_MESSAGE)
        return
      }
      setDependencyError(null)
    } else {
      setDependencyError(null)
    }
    let tasks = [...selectedProject.tasks]
    if (merged.dependsOnTaskId) {
      const depRoot = tasks.find((t) => t.id === merged.dependsOnTaskId)
      if (depRoot) merged = rescheduleChildFromParent(depRoot, merged)
    }
    tasks = [...tasks, merged]
    void (async () => {
      try {
        await persistProjectTasksDelta(supabase, selectedProject.id, currentUserId, selectedProject.tasks, tasks)
        await refresh()
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const applyMilestoneDeadlinePlan = (milestoneId, targetParam) => {
    const plan = milestonePlan[milestoneId]
    const target = targetParam ?? plan?.target
    const current = taskDerivedMilestoneDeadline(milestoneId)
    if (!target || !current) return
    const tasks = (tasksByMilestone[milestoneId] ?? []).filter((t) => t.status !== 'Готово')
    if (!tasks.length) return

    const mode = plan?.mode ?? 'shift'

    if (mode === 'shift') {
      const days = diffDays(target, current)
      shiftTasksByIds(
        tasks.map((task) => task.id),
        days,
      )
      return
    }

    if (mode === 'highlight') {
      const subtasksForRoots =
        selectedProject?.tasks.filter(
          (t) =>
            t.parentTaskId &&
            t.status !== 'Готово' &&
            tasks.some((r) => r.id === t.parentTaskId),
        ) ?? []
      const combined = [...tasks, ...subtasksForRoots]
      setViolatingTaskIds(combined.filter((task) => diffDays(task.deadline, target) > 0).map((t) => t.id))
    }
  }

  const createMilestone = async (rawName) => {
    const name = rawName.trim()
    if (!name || !apiConnected || !currentUserId || !resolvedSelectedProjectId) return
    try {
      const id = await createMilestoneRemote(supabase, resolvedSelectedProjectId, name, currentUserId)
      await refresh()
      setExpandedMilestonesByProject((prev) => ({
        ...prev,
        [resolvedSelectedProjectId]: [...new Set([...(prev[resolvedSelectedProjectId] ?? allExpandedMilestoneIds), id])],
      }))
      setAddingMilestoneOpen(false)
      setNewMilestoneNameDraft('')
    } catch (e) {
      console.error(e)
      setDependencyError(`Не удалось создать веху: ${formatSupabaseError(e)}`)
    }
  }

  const renameMilestone = (milestoneId, name) => {
    const trimmed = name.trim()
    if (!trimmed || milestoneId === ungroupedMilestoneId) return
    if (!apiConnected || !dataEnabled) return
    void (async () => {
      try {
        await updateMilestoneTitleRemote(supabase, milestoneId, trimmed)
        await refresh()
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const deleteMilestone = (milestoneId) => {
    if (milestoneId === ungroupedMilestoneId) return
    if (!window.confirm('Удалить веху? Задачи перейдут в «Без вехи».')) return
    if (!apiConnected || !dataEnabled) return
    void (async () => {
      try {
        await deleteMilestoneRemote(supabase, milestoneId)
        await refresh()
        setMilestonePlan((prev) => {
          const next = { ...prev }
          delete next[milestoneId]
          return next
        })
        setExpandedMilestonesByProject((prev) => ({
          ...prev,
          [resolvedSelectedProjectId]: (prev[resolvedSelectedProjectId] ?? []).filter((id) => id !== milestoneId),
        }))
        setMilestoneMenuOpenId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const completeMilestoneTasks = (milestoneId) => {
    const tasks = tasksByMilestone[milestoneId] ?? []
    const active = tasks.filter((t) => t.status !== 'Готово')
    if (active.length === 0) return
    const ids = active.map((t) => t.id)
    const withChildren = new Set(ids)
    selectedProject?.tasks.forEach((t) => {
      if (t.parentTaskId && withChildren.has(t.parentTaskId) && t.status !== 'Готово') {
        withChildren.add(t.id)
      }
    })
    const allIds = [...withChildren]
    if (!apiConnected || !currentUserId || !dataEnabled) return
    void (async () => {
      try {
        await updateTasksStatusBulkRemote(supabase, currentUserId, allIds, 'Готово')
        await refresh()
        setMilestoneMenuOpenId(null)
      } catch (e) {
        console.error(e)
        setDependencyError(formatSupabaseError(e))
      }
    })()
  }

  const sortedTasks = useMemo(() => {
    if (!selectedProject) return []
    return visibleTasks.slice().sort((a, b) => toDate(a.deadline) - toDate(b.deadline))
  }, [selectedProject, visibleTasks])

  const today = dateOnly(new Date())
  const todayDateString = toLocalDateString(today)
  const overdueTasks = sortedTasks.filter(
    (task) => toDate(task.deadline) < today && task.status !== 'Готово',
  )
  const todayTasks = sortedTasks.filter(
    (task) => diffDays(task.deadline, todayDateString) === 0 && task.status !== 'Готово',
  )
  /** Завтра … +7 дней от сегодня. Дедлайн «сегодня» только в «На сегодня», не дублируем в «Ближайшие». */
  const upcomingTasks = sortedTasks.filter((task) => {
    if (task.status === 'Готово') return false
    const d = diffDays(task.deadline, todayDateString)
    return d >= 1 && d <= 7
  })
  const problematicTasks = sortedTasks.filter((task) => {
    if (task.status === 'Готово') return false
    const noAssignee = !taskHasAssigneeDisplay(task)
    const overdue = toDate(task.deadline) < today
    const tooLongInProgress =
      task.status === 'В работе' && Math.round((today - toDate(task.startDate)) / dayMs) > 10
    const d = diffDays(task.deadline, todayDateString)
    const blocksOthersSoon =
      getDependencyMeta(task, selectedProject?.tasks ?? []).isBlocking && d >= 0 && d <= 7
    return noAssignee || overdue || tooLongInProgress || blocksOthersSoon
  })

  const openTaskFromFeedRow = (e, taskId) => {
    if (e.target.closest('button, a, input, select')) return
    setOpenedTaskId(taskId)
  }

  const copyTaskLink = useCallback(
    async (taskId) => {
      const projectId = tasksIndexById.get(taskId)?.projectId ?? resolvedSelectedProjectId ?? null
      const url = buildTaskLinkUrl(taskId, projectId)
      if (!url) return
      try {
        await navigator.clipboard.writeText(url)
        setTaskMoveNotice({ variant: 'success', text: 'Ссылка на задачу скопирована' })
      } catch {
        setDependencyError('Не удалось скопировать ссылку на задачу')
      }
    },
    [tasksIndexById, resolvedSelectedProjectId],
  )

  if (!configured) {
    const prodHint = import.meta.env.PROD
    return (
      <div className="auth-screen">
        <div className="auth-panel">
          <h1 className="heading-h1 auth-panel__title">Нужен Supabase</h1>
          {prodHint ? (
            <>
              <p className="auth-panel__lede">
                В этой <strong>сборке</strong> не подставлены{' '}
                <code className="auth-inline-code">VITE_SUPABASE_URL</code> и{' '}
                <code className="auth-inline-code">VITE_SUPABASE_ANON_KEY</code>. Для Vite они задаются{' '}
                <strong>при сборке</strong> — только файл <code className="auth-inline-code">.env</code> на сервере не
                читается, нужны переменные в хостинге.
              </p>
              <ol className="auth-steps">
                <li>
                  <strong>Vercel</strong> → ваш проект → <strong>Settings</strong> →{' '}
                  <strong>Environment Variables</strong>
                </li>
                <li>
                  Добавьте <code className="auth-inline-code">VITE_SUPABASE_URL</code> (Project URL) и{' '}
                  <code className="auth-inline-code">VITE_SUPABASE_ANON_KEY</code> (anon public) из Supabase →{' '}
                  <strong>Settings → API</strong>. Имена переменных — без опечаток, без лишних пробелов.
                </li>
                <li>
                  Включите окружение <strong>Production</strong> (и <strong>Preview</strong>, если смотрите превью-деплой).
                </li>
                <li>
                  <strong>Deployments</strong> → последний деплой → <strong>⋯</strong> → <strong>Redeploy</strong> (новая
                  сборка подтянет переменные).
                </li>
              </ol>
              <p className="auth-panel__hint muted">
                Если переменные добавили, но экран не исчез: чаще всего не сделали Redeploy или имя переменной отличается от{' '}
                <code className="auth-inline-code">VITE_…</code>.
              </p>
            </>
          ) : (
            <>
              <p className="auth-panel__lede">
                В корне проекта нет переменных <code className="auth-inline-code">VITE_SUPABASE_*</code>. Без них клиент не
                подключается к бэкенду.
              </p>
              <ol className="auth-steps">
                <li>
                  Скопируйте <code className="auth-inline-code">.env.example</code> →{' '}
                  <code className="auth-inline-code">.env</code>
                </li>
                <li>
                  Вставьте URL и anon key из Supabase: Settings → API
                </li>
                <li>
                  Остановите сервер и снова запустите <code className="auth-inline-code">npm run dev</code> (Vite читает
                  .env только при старте)
                </li>
              </ol>
              <p className="auth-panel__hint muted">
                Если открываете не dev-сервер, а старый <code className="auth-inline-code">dist</code> или другую папку —
                изменений в коде не будет. Внизу справа должна быть метка «DEV · Vite».
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  if (authLoading) {
    return (
      <div className="auth-screen">
        <p className="muted">Загрузка…</p>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onSignIn={signIn} loading={authLoading} devLoginAny={devLoginAny} />
  }

  if (profileLoading) {
    return (
      <div className="auth-screen">
        <p className="muted">Загрузка профиля…</p>
      </div>
    )
  }

  if (profileError === 'missing') {
    return (
      <ProfileMissingScreen
        message="Профиль пользователя не найден. Обратитесь к администратору."
        onSignOut={signOut}
      />
    )
  }

  if (profileError === 'fetch_failed') {
    return (
      <ProfileMissingScreen
        message="Не удалось загрузить профиль. Проверьте соединение или обратитесь к администратору."
        onSignOut={signOut}
      />
    )
  }

  if (dataLoading && projects.length === 0) {
    return (
      <div className="auth-screen">
        <p className="muted">Загрузка проектов…</p>
      </div>
    )
  }

  return (
    <>
      <main
        className={`app-shell${selectedActiveCount > 0 ? ' app-shell--bulk-open' : ''}`}
      >
      <header className="app-header app-header--with-user">
        <div className="app-header__intro">
          <h1 className="heading-h1">Командный центр проекта</h1>
          <p className="app-header__subtitle">
            Центр управления сроками и задачами в режиме приоритета дедлайнов.
          </p>
          {mineFilterActive && currentUser ? (
            <p className="mine-filter-indicator" role="status">
              Показаны только задачи: <span className="mine-filter-indicator__name">{currentUser.name}</span>
              <button
                type="button"
                className="mine-filter-indicator__reset"
                onClick={() => setMineFilterActive(false)}
              >
                Сбросить
              </button>
            </p>
          ) : null}
        </div>
        <div className="app-header__actions">
          {currentUser ? (
            <button
              type="button"
              className={`mine-filter-toggle${mineFilterActive ? ' mine-filter-toggle--active' : ''}`}
              aria-pressed={mineFilterActive}
              onClick={() => setMineFilterActive((v) => !v)}
            >
              Мои задачи
            </button>
          ) : null}
          {currentUser ? (
            <CurrentUserMenu currentUser={currentUser} onSignOut={signOut} onSaveDisplayName={saveUserDisplayName} />
          ) : null}
        </div>
      </header>

      <nav className="project-tabs" aria-label="Проекты">
        <section className="project-workspace" aria-label="Темы и проекты">
          <div className="section-header project-tabs__header">
            <h2 className="heading-h2">Темы</h2>
            <div className="project-tabs__actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setShowNewTopicModal(true)
                }}
              >
                + Новая тема
              </button>
              <button type="button" className="btn-secondary" onClick={openEditTopicModal}>
                Изменить тему
              </button>
            </div>
          </div>
          <div className="project-workspace__filters">
            <div className="topic-toggle-row" role="tablist" aria-label="Быстрые группы тем">
              <button
                type="button"
                role="tab"
                aria-selected={selectedTopicFilter === 'all'}
                className={`topic-toggle-btn ${selectedTopicFilter === 'all' ? 'topic-toggle-btn--active' : ''}`}
                onClick={() => {
                  setSelectedTopicFilter('all')
                  setOpenedTaskId(null)
                }}
              >
                Все темы
                <span className="topic-toggle-btn__count">{topicProjectCounts.all}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedTopicFilter === 'none'}
                className={`topic-toggle-btn ${selectedTopicFilter === 'none' ? 'topic-toggle-btn--active' : ''}`}
                onClick={() => {
                  setSelectedTopicFilter('none')
                  setOpenedTaskId(null)
                }}
              >
                Без темы
                <span className="topic-toggle-btn__count">{topicProjectCounts.none}</span>
              </button>
            </div>
            <div className="topic-chip-row" role="tablist" aria-label="Темы">
              {topics.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedTopicFilter === t.id}
                  className={`topic-chip ${selectedTopicFilter === t.id ? 'topic-chip--active' : ''}`}
                  onClick={() => {
                    setSelectedTopicFilter(t.id)
                    setOpenedTaskId(null)
                  }}
                >
                  {t.name}
                  <span className="topic-chip__count">{topicProjectCounts.byId.get(t.id) ?? 0}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="section-header project-tabs__header project-workspace__projects-head">
            <h2 className="heading-h2">Проекты</h2>
            <div className="project-tabs__actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setNewProjectTopicId(selectedTopicFilter === 'all' || selectedTopicFilter === 'none' ? null : selectedTopicFilter)
                  setShowNewProjectModal(true)
                }}
              >
                <span className="btn-primary__icon" aria-hidden>
                  +
                </span>
                Новый проект
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!resolvedSelectedProjectId}
                onClick={() => {
                  const p = projects.find((x) => x.id === resolvedSelectedProjectId)
                  if (!p) return
                  setRenameProjectDraft(p.name ?? '')
                  setRenameProjectTopicId(p.topicId ?? null)
                  setShowRenameProjectModal(true)
                }}
              >
                Изменить проект
              </button>
            </div>
          </div>
          <div className="project-tabs__context muted" role="status" aria-live="polite">
            {selectedTopicFilter === 'all' ? (
              <>
                Показываем <strong>все темы</strong>. Проекты сгруппированы по темам.
              </>
            ) : (
              <>
                Выбрана тема: <strong>{selectedTopicLabel}</strong>. Проектов в теме: {visibleProjects.length}
              </>
            )}
          </div>
          {groupedVisibleProjects.length > 0 ? (
            <div className="project-groups">
              {groupedVisibleProjects.map((group) => (
                <section key={group.key} className="project-group" aria-label={`Группа проектов ${group.label}`}>
                  <header className="project-group__head">
                    <h3 className="project-group__title">{group.label}</h3>
                    <span className="project-group__count">{group.projects.length}</span>
                  </header>
                  <div className="project-cluster-grid" role="tablist" aria-label={`Проекты группы ${group.label}`}>
                    {group.projects.map((project) => {
                      const taskCount = countTasksForProject(project)
                      return (
                        <button
                          key={project.id}
                          type="button"
                          role="tab"
                          aria-selected={resolvedSelectedProjectId === project.id}
                          className={`project-cluster-card ${resolvedSelectedProjectId === project.id ? 'project-cluster-card--active' : ''}`}
                          onClick={() => switchProject(project.id)}
                        >
                          <span className="project-cluster-card__title">{project.name}</span>
                          <span className="project-cluster-card__meta">Задач: {taskCount}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="project-cluster-empty">В выбранной группе пока нет проектов. Создай первый проект.</div>
          )}
        </section>
      </nav>

      {selectedProject && (
        <div className="project-tabs-meta muted">
          Авто-дедлайн: {projectDeadline ? formatDate(projectDeadline) : 'Нет данных'}
        </div>
      )}

      {dependencyError && (
        <div
          className="dependency-error-banner dependency-error-banner--sticky"
          role="alert"
          aria-live="assertive"
        >
          {dependencyError}
        </div>
      )}

      {taskMoveNotice && (
        <div
          className={`task-move-banner task-move-banner--${taskMoveNotice.variant}`}
          role="status"
          aria-live="polite"
        >
          {taskMoveNotice.text}
        </div>
      )}

      {selectedProject ? (
        <div key={resolvedSelectedProjectId} className="app-shell-content app-shell-content--fade">
      {mineFilterActive && visibleTasks.length === 0 ? (
        <div className="panel mine-filter-empty">
          <p className="mine-filter-empty__text">У вас нет задач по текущему фильтру</p>
          <button type="button" className="btn-primary" onClick={() => setMineFilterActive(false)}>
            Показать все задачи
          </button>
        </div>
      ) : (
        <>
      <section className="panel command-grid">
        <article className="command-card command-card--overdue">
          <h3 className="heading-h3">Просроченные</h3>
          <p>{overdueTasks.length}</p>
        </article>
        <article className="command-card command-card--today">
          <h3 className="heading-h3">На сегодня</h3>
          <p>{todayTasks.length}</p>
        </article>
        <article className="command-card command-card--upcoming">
          <h3 className="heading-h3">Ближайшие</h3>
          <p>{upcomingTasks.length}</p>
        </article>
        <article className="command-card command-card--problematic">
          <h3 className="heading-h3">Проблемные</h3>
          <p>{problematicTasks.length}</p>
        </article>
      </section>

      <section className="panel">
        <div className="section-header">
          <h2 className="heading-h2">Лента командного центра</h2>
        </div>
        <div className="feed-grid">
          <div className="feed-column feed-column--overdue">
            <h3 className="heading-h3 feed-column__head">
              <span className="feed-heading-dot feed-heading-dot--overdue" aria-hidden />
              Просроченные
            </h3>
            {overdueTasks.map((task) => (
              <div
                key={task.id}
                className="feed-row"
                onClick={(e) => openTaskFromFeedRow(e, task.id)}
              >
                <span className="feed-row__title">{task.title}</span>
                <span className="tag tag--feed tag--feed-overdue">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div className="feed-column feed-column--today">
            <h3 className="heading-h3 feed-column__head">
              <span className="feed-heading-dot feed-heading-dot--today" aria-hidden />
              На сегодня
            </h3>
            {todayTasks.map((task) => (
              <div
                key={task.id}
                className="feed-row"
                onClick={(e) => openTaskFromFeedRow(e, task.id)}
              >
                <span className="feed-row__title">{task.title}</span>
                <span className="tag tag--feed tag--feed-today">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div className="feed-column feed-column--upcoming">
            <h3 className="heading-h3 feed-column__head">
              <span className="feed-heading-dot feed-heading-dot--upcoming" aria-hidden />
              Ближайшие
            </h3>
            {upcomingTasks.map((task) => (
              <div
                key={task.id}
                className="feed-row"
                onClick={(e) => openTaskFromFeedRow(e, task.id)}
              >
                <span className="feed-row__title">{task.title}</span>
                <span className="tag tag--feed tag--feed-upcoming">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div className="feed-column feed-column--problematic">
            <h3 className="heading-h3 feed-column__head">
              <span className="feed-heading-dot feed-heading-dot--problematic" aria-hidden />
              Проблемные
            </h3>
            {problematicTasks.map((task) => {
              const d = diffDays(task.deadline, todayDateString)
              const dep = getDependencyMeta(task, selectedProject.tasks)
              const blockingSoon = dep.isBlocking && d >= 0 && d <= 7
              const overdue = toDate(task.deadline) < today
              const longInProgress =
                task.status === 'В работе' &&
                Math.round((today - toDate(task.startDate)) / dayMs) > 10
              let subtitle = 'Требует внимания'
              if (!taskHasAssigneeDisplay(task)) subtitle = 'Нет исполнителя'
              else if (overdue) subtitle = 'Просрочено'
              else if (longInProgress) subtitle = 'Долго в работе'
              else if (blockingSoon) subtitle = 'Блокирует (срок ≤ 7 дн.)'
              return (
                <div
                  key={task.id}
                  className="feed-row"
                  onClick={(e) => openTaskFromFeedRow(e, task.id)}
                >
                  <span className="feed-row__title">{task.title}</span>
                  <span className="feed-problematic-status">{subtitle}</span>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <section className="panel milestones-panel">
        <div className="section-header">
          <h2 className="heading-h2">Задачи по вехам</h2>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setAddingMilestoneOpen(true)
              setNewMilestoneNameDraft('')
            }}
          >
            Новая веха
          </button>
        </div>
        <div className="stack">
          {milestonesToRender.map((milestone) => {
            const tasks = tasksByMilestone[milestone.id] ?? []
            const activeTasks = tasks.filter((t) => t.status !== 'Готово')
            const completedRoots = tasks.filter((t) => t.status === 'Готово')
            const completedSubtasksInMilestone = selectedProject.tasks.filter(
              (t) =>
                t.parentTaskId &&
                t.status === 'Готово' &&
                (t.milestoneId ?? ungroupedMilestoneId) === milestone.id,
            )
            const completedTasks = [...completedRoots, ...completedSubtasksInMilestone].sort(
              (a, b) => toDate(a.deadline) - toDate(b.deadline),
            )
            const milestoneFilterKey = `${resolvedSelectedProjectId}:${milestone.id}`
            const assigneeFilterValue = milestoneAssigneeFilters[milestoneFilterKey] ?? 'all'
            const visibleActiveTasks = activeTasks.filter((t) =>
              matchesMilestoneAssigneeFilter(t, assigneeFilterValue),
            )
            const visibleCompletedTasks = completedTasks.filter((t) =>
              matchesMilestoneAssigneeFilter(t, assigneeFilterValue),
            )
            const expanded = expandedMilestoneIdsResolved.includes(milestone.id)
            const deadline = milestoneDeadline(milestone.id)
            const overdueInMilestone = visibleActiveTasks.filter(
              (t) => getDeadlineLabel(t.deadline) === 'overdue',
            ).length
            const deadlinePillKind = (() => {
              if (!deadline) return 'none'
              const d = diffDays(deadline, todayDateString)
              if (d < 0) return 'past'
              if (d === 0) return 'today'
              if (d >= 1 && d <= 7) return 'soon'
              return 'neutral'
            })()
            const allSelected =
              visibleActiveTasks.length > 0 &&
              visibleActiveTasks.every((t) => selectedTaskIds.includes(t.id))
            const completedKey = `${resolvedSelectedProjectId}:${milestone.id}`
            const completedOpen = Boolean(expandedCompletedSections[completedKey])
            const isUngrouped = milestone.id === ungroupedMilestoneId
            const menuOpen = milestoneMenuOpenId === milestone.id

            const milestoneDropPreview =
              draggingTaskId && selectedProject
                ? validateTaskMilestoneMove(
                    selectedProject,
                    draggingTaskId,
                    milestone.id,
                    ungroupedMilestoneId,
                  )
                : null
            const milestoneCardClass = [
              'milestone-card',
              draggingTaskId &&
                dragSourceMilestoneKey === milestone.id &&
                'milestone-card--drop-source',
              dragOverMilestoneKey === milestone.id &&
                milestoneDropPreview?.ok &&
                'milestone-card--drop-active',
              dragOverMilestoneKey === milestone.id &&
                draggingTaskId &&
                milestoneDropPreview &&
                !milestoneDropPreview.ok &&
                !milestoneDropPreview.noOp &&
                'milestone-card--drop-invalid',
              dragOverMilestoneKey === milestone.id &&
                milestoneDropPreview?.noOp &&
                draggingTaskId &&
                'milestone-card--drop-same',
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <article
                key={milestone.id}
                className={milestoneCardClass}
                onClick={() => {
                  if (editingMilestoneTitleId === milestone.id) return
                  toggleMilestoneExpanded(milestone.id)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!draggingTaskId || !selectedProject) return
                  const check = validateTaskMilestoneMove(
                    selectedProject,
                    draggingTaskId,
                    milestone.id,
                    ungroupedMilestoneId,
                  )
                  setDragOverMilestoneKey(milestone.id)
                  if (check.noOp || !check.ok) {
                    e.dataTransfer.dropEffect = 'none'
                  } else {
                    e.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    setDragOverMilestoneKey((k) => (k === milestone.id ? null : k))
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOverMilestoneKey(null)
                  const taskId = e.dataTransfer.getData('application/task-id')
                  if (!taskId) return
                  void performMoveTaskToMilestone(taskId, milestone.id)
                }}
              >
                <header className="milestone-card__header">
                  <div className="milestone-card__header-left">
                    <button
                      type="button"
                      className="milestone-card__caret"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleMilestoneExpanded(milestone.id)
                      }}
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Свернуть веху' : 'Развернуть веху'}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                    {editingMilestoneTitleId === milestone.id && !isUngrouped ? (
                      <input
                        className="milestone-card__title-input"
                        value={editingMilestoneTitleDraft}
                        onChange={(e) => setEditingMilestoneTitleDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => {
                          const t = editingMilestoneTitleDraft.trim()
                          if (!t) {
                            setEditingMilestoneTitleDraft(milestone.name)
                            setEditingMilestoneTitleId(null)
                            return
                          }
                          if (t !== milestone.name) renameMilestone(milestone.id, editingMilestoneTitleDraft)
                          setEditingMilestoneTitleId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditingMilestoneTitleId(null)
                            setEditingMilestoneTitleDraft(milestone.name)
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            renameMilestone(milestone.id, editingMilestoneTitleDraft)
                            setEditingMilestoneTitleId(null)
                          }
                        }}
                        autoFocus
                        aria-label="Название вехи"
                      />
                    ) : (
                      <h3 className="milestone-card__title heading-h3">
                        <span className="milestone-card__title-text">{milestone.name}</span>
                      </h3>
                    )}
                  </div>
                  <div className="milestone-card__actions" onClick={(e) => e.stopPropagation()}>
                    <div
                      className="milestone-card__menu-root"
                      data-milestone-menu-root={milestone.id}
                    >
                      <button
                        type="button"
                        className="milestone-card__menu-trigger"
                        title="Меню вехи"
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        onClick={() =>
                          setMilestoneMenuOpenId((id) => (id === milestone.id ? null : milestone.id))
                        }
                      >
                        ⋯
                      </button>
                      {menuOpen && (
                        <div
                          className="milestone-card__menu"
                          role="menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!isUngrouped && (
                            <button
                              type="button"
                              role="menuitem"
                              className="milestone-card__menu-item"
                              onClick={() => {
                                setMilestoneMenuOpenId(null)
                                setEditingMilestoneTitleId(milestone.id)
                                setEditingMilestoneTitleDraft(milestone.name)
                              }}
                            >
                              Редактировать веху
                            </button>
                          )}
                          {!isUngrouped && (
                            <button
                              type="button"
                              role="menuitem"
                              className="milestone-card__menu-item milestone-card__menu-item--danger"
                              onClick={() => {
                                setMilestoneMenuOpenId(null)
                                deleteMilestone(milestone.id)
                              }}
                            >
                              Удалить веху
                            </button>
                          )}
                          <div className="milestone-card__menu-deadline">
                            <span className="milestone-card__menu-deadline-label">Изменить дедлайн</span>
                            <input
                              type="date"
                              className="milestone-card__menu-date"
                              value={milestonePlan[milestone.id]?.target ?? (deadline ?? '')}
                              onChange={(event) => {
                                const nextTarget = event.target.value
                                setMilestonePlan((prev) => ({
                                  ...prev,
                                  [milestone.id]: {
                                    target: nextTarget,
                                    mode: prev[milestone.id]?.mode ?? 'shift',
                                  },
                                }))
                                if (!isUngrouped && apiConnected && dataEnabled) {
                                  void (async () => {
                                    try {
                                      await updateMilestoneDeadlineRemote(
                                        supabase,
                                        milestone.id,
                                        nextTarget || null,
                                      )
                                      await refresh()
                                    } catch (e) {
                                      console.error(e)
                                      setDependencyError(formatSupabaseError(e))
                                    }
                                  })()
                                }
                                applyMilestoneDeadlinePlan(milestone.id, nextTarget)
                              }}
                              aria-label="Целевой дедлайн вехи"
                            />
                          </div>
                          {!isUngrouped && activeTasks.length > 0 && (
                            <button
                              type="button"
                              role="menuitem"
                              className="milestone-card__menu-item"
                              onClick={() => completeMilestoneTasks(milestone.id)}
                            >
                              Завершить веху
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </header>

                <div className="milestone-card__meta">
                  <span
                    className={`milestone-meta-pill milestone-meta-pill--deadline milestone-meta-pill--deadline-${deadlinePillKind}`}
                  >
                    {deadline ? `📅 ${formatDate(deadline)}` : '📅 Нет дат'}
                  </span>
                  <span className="milestone-meta-pill milestone-meta-pill--count">
                    {ruTasksCountLabel(visibleActiveTasks.length)}
                  </span>
                  {overdueInMilestone > 0 && (
                    <span className="milestone-meta-pill milestone-meta-pill--overdue-tasks">
                      {overdueInMilestone} просрочено
                    </span>
                  )}
                  <label className="milestone-assignee-filter" onClick={(e) => e.stopPropagation()}>
                    <span>Исполнитель</span>
                    <select
                      value={assigneeFilterValue}
                      onChange={(e) =>
                        setMilestoneAssigneeFilters((prev) => ({
                          ...prev,
                          [milestoneFilterKey]: e.target.value,
                        }))
                      }
                    >
                      <option value="all">Все</option>
                      <option value="none">Без исполнителя</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {expanded && (
                  <div
                    className="milestone-card__body"
                    onClick={(e) => e.stopPropagation()}
                  >
                  <table className="issues-table issues-table--milestone">
                    <colgroup>
                      <col className="issues-table__col issues-table__col--check" />
                      <col className="issues-table__col issues-table__col--title" />
                      <col className="issues-table__col issues-table__col--status" />
                      <col className="issues-table__col issues-table__col--assignee" />
                      <col className="issues-table__col issues-table__col--start" />
                      <col className="issues-table__col issues-table__col--due" />
                      <col className="issues-table__col issues-table__col--priority" />
                      <col className="issues-table__col issues-table__col--dep" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className="issues-table__th issues-table__th--check">
                          <div className="issues-table__check-cell issues-table__check-cell--tile issues-table__check-cell--head">
                            <span className="task-row__drag-head-spacer" aria-hidden />
                            <span className="issues-table__check-cell__tile-slot" aria-hidden />
                            <input
                              type="checkbox"
                              className="issues-table__check-cell__cb-input"
                              checked={allSelected}
                              onChange={() => {
                                if (allSelected) {
                                  const ids = new Set(visibleActiveTasks.map((t) => t.id))
                                  setSelectedTaskIds((prev) => prev.filter((id) => !ids.has(id)))
                                  return
                                }
                                setSelectedTaskIds((prev) => [
                                  ...new Set([...prev, ...visibleActiveTasks.map((t) => t.id)]),
                                ])
                              }}
                              aria-label="Выбрать все активные задачи вехи"
                            />
                            <span className="issues-table__check-cell__tile-slot" aria-hidden />
                          </div>
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--title">
                          Задача
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Статус
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Исполнитель
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Старт
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Дедлайн
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Приоритет
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Зависит от
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleActiveTasks.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="issues-table__empty">
                            {assigneeFilterValue === 'all'
                              ? 'Нет активных задач'
                              : 'Нет активных задач по выбранному исполнителю'}
                          </td>
                        </tr>
                      ) : (
                      visibleActiveTasks.map((task) => {
                        const label = getDeadlineLabel(task.deadline)
                        const isViolation = visibleViolatingTaskIds.includes(task.id)
                        const isSelected = selectedTaskIds.includes(task.id)
                        const depCandidates = selectedProject.tasks.filter(
                          (c) => c.id !== task.id && !c.parentTaskId,
                        )
                        const subRows = (subtasksByParentId[task.id] ?? []).filter(
                          (st) => st.status !== 'Готово' && matchesMilestoneAssigneeFilter(st, assigneeFilterValue),
                        )
                        const activeSubtaskCount = subRows.length
                        const subExpanded = expandedSubtaskParents.has(task.id)
                        return (
                          <Fragment key={task.id}>
                            <tr
                              className={`issues-table__task-row task-row--urgency-${label} ${isViolation ? 'row-violation' : ''} ${isSelected ? 'task-row--selected' : ''} ${draggingTaskId === task.id ? 'issues-table__task-row--dragging' : ''}`}
                              onClick={(e) => {
                                if (
                                  e.target.closest(
                                    'input, select, button, a, .task-inline, .task-row__drag-handle, .subtask-expand-btn, .quick-add-card, .quick-add-trigger',
                                  )
                                )
                                  return
                                setOpenedTaskId(task.id)
                              }}
                            >
                              <td className="issues-table__td issues-table__td--check issues-table__td--check-root">
                                <div className="issues-table__check-cell issues-table__check-cell--tile issues-table__check-cell--tile-root">
                                  <button
                                    type="button"
                                    className="task-row__drag-handle"
                                    aria-label="Переместить задачу в другую веху"
                                    title="Переместить в другую веху"
                                    draggable
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => e.stopPropagation()}
                                    onDragStart={(e) => {
                                      e.stopPropagation()
                                      if (moveTaskToMilestoneLockRef.current) {
                                        e.preventDefault()
                                        return
                                      }
                                      if (task.status === 'Готово') {
                                        e.preventDefault()
                                        setTaskMoveNotice({
                                          variant: 'error',
                                          text: 'Сначала верните задачу в активные',
                                        })
                                        return
                                      }
                                      e.dataTransfer.setData('application/task-id', task.id)
                                      e.dataTransfer.setData('text/plain', task.id)
                                      e.dataTransfer.effectAllowed = 'move'
                                      setDraggingTaskId(task.id)
                                      setDragSourceMilestoneKey(milestone.id)
                                    }}
                                    onDragEnd={() => {
                                      setDraggingTaskId(null)
                                      setDragSourceMilestoneKey(null)
                                      setDragOverMilestoneKey(null)
                                    }}
                                  >
                                    <span className="task-row__drag-grip" aria-hidden>
                                      ⋮⋮
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    className="subtask-expand-btn"
                                    aria-expanded={subExpanded}
                                    aria-label={
                                      subExpanded ? 'Свернуть подзадачи' : 'Показать подзадачи'
                                    }
                                    title={
                                      subExpanded
                                        ? 'Свернуть подзадачи'
                                        : activeSubtaskCount > 0
                                          ? `Подзадачи (${activeSubtaskCount})`
                                          : 'Добавить подзадачу'
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleSubtaskExpand(task.id)
                                    }}
                                  >
                                    <span className="subtask-expand-btn__icon" aria-hidden>
                                      {subExpanded ? '−' : '+'}
                                    </span>
                                    {activeSubtaskCount > 0 ? (
                                      <span className="subtask-expand-btn__badge">{activeSubtaskCount}</span>
                                    ) : null}
                                  </button>
                                  <input
                                    type="checkbox"
                                    className="issues-table__check-cell__cb-input"
                                    checked={selectedTaskIds.includes(task.id)}
                                    onChange={() => toggleTaskSelection(task.id)}
                                  />
                                  <span className="issues-table__check-cell__tile-slot" aria-hidden />
                                </div>
                              </td>
                              <td className="issues-table__td issues-table__td--title">
                                <div className="task-title-cell">
                                  <span className="task-title-cell__title">{task.title}</span>
                                  <TaskDependencyPanel task={task} tasks={selectedProject.tasks} />
                                </div>
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <div className="status-cell status-cell--inline">
                                  <InlineTaskStatus
                                    taskId={task.id}
                                    status={task.status}
                                    statusOptions={statusOptions}
                                    updateTask={updateTask}
                                    urgency={label}
                                  />
                                </div>
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <div className="assignee-cell assignee-cell--inline">
                                  <InlineTaskAssignee
                                    taskId={task.id}
                                    task={task}
                                    users={users}
                                    updateTask={updateTask}
                                  />
                                </div>
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <InlineTaskDateField
                                  taskId={task.id}
                                  field="startDate"
                                  value={task.startDate}
                                  updateTask={updateTask}
                                />
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <div className="due-cell due-cell--inline">
                                  <InlineTaskDateField
                                    taskId={task.id}
                                    field="deadline"
                                    value={task.deadline}
                                    updateTask={updateTask}
                                    deadlineLabel={label}
                                  />
                                </div>
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <InlineTaskPriority taskId={task.id} priority={task.priority} updateTask={updateTask} />
                              </td>
                              <td className="issues-table__td issues-table__td--center">
                                <InlineTaskDependency
                                  taskId={task.id}
                                  dependsOnTaskId={task.dependsOnTaskId}
                                  candidates={depCandidates}
                                  tasks={selectedProject.tasks}
                                  updateTask={updateTask}
                                />
                              </td>
                            </tr>
                            {subExpanded &&
                              subRows.map((st) => {
                                const stLabel = getDeadlineLabel(st.deadline)
                                const stViolation = visibleViolatingTaskIds.includes(st.id)
                                const stSelected = selectedTaskIds.includes(st.id)
                                const stDep = selectedProject.tasks.filter(
                                  (c) => c.id !== st.id && !c.parentTaskId,
                                )
                                const stDone = st.status === 'Готово'
                                return (
                                  <tr
                                    key={st.id}
                                    className={`issues-table__task-row issues-table__task-row--subtask issues-table__task-row--subtask-nested task-row--urgency-${stLabel} ${stViolation ? 'row-violation' : ''} ${stSelected ? 'task-row--selected' : ''} ${stDone ? 'issues-table__task-row--subtask-done' : ''}`}
                                    onClick={(e) => {
                                      if (e.target.closest('input, select, button, a, .task-inline')) return
                                      setOpenedTaskId(st.id)
                                    }}
                                  >
                                    <td className="issues-table__td issues-table__td--check issues-table__td--check-root">
                                      <div className="issues-table__check-cell issues-table__check-cell--tile issues-table__check-cell--tile-subtask">
                                        <span
                                          className="task-row__drag-placeholder"
                                          title="Подзадачи между вехами не переносятся"
                                          aria-hidden
                                        >
                                          ··
                                        </span>
                                        <span className="issues-table__check-cell__tile-slot" aria-hidden />
                                        <input
                                          type="checkbox"
                                          className="issues-table__check-cell__cb-input"
                                          checked={selectedTaskIds.includes(st.id)}
                                          onChange={() => toggleTaskSelection(st.id)}
                                        />
                                        <span className="issues-table__check-cell__tile-slot" aria-hidden />
                                      </div>
                                    </td>
                                    <td className="issues-table__td issues-table__td--title">
                                      <div className="task-title-cell task-title-cell--subtask">
                                        <span className="task-title-cell__title">{st.title}</span>
                                        <TaskDependencyPanel task={st} tasks={selectedProject.tasks} />
                                      </div>
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <div className="status-cell status-cell--inline">
                                        <InlineTaskStatus
                                          taskId={st.id}
                                          status={st.status}
                                          statusOptions={statusOptions}
                                          updateTask={updateTask}
                                          urgency={stLabel}
                                        />
                                      </div>
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <div className="assignee-cell assignee-cell--inline">
                                        <InlineTaskAssignee
                                          taskId={st.id}
                                          task={st}
                                          users={users}
                                          updateTask={updateTask}
                                        />
                                      </div>
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <InlineTaskDateField
                                        taskId={st.id}
                                        field="startDate"
                                        value={st.startDate}
                                        updateTask={updateTask}
                                      />
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <div className="due-cell due-cell--inline">
                                        <InlineTaskDateField
                                          taskId={st.id}
                                          field="deadline"
                                          value={st.deadline}
                                          updateTask={updateTask}
                                          deadlineLabel={stLabel}
                                        />
                                      </div>
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <InlineTaskPriority taskId={st.id} priority={st.priority} updateTask={updateTask} />
                                    </td>
                                    <td className="issues-table__td issues-table__td--center">
                                      <InlineTaskDependency
                                        taskId={st.id}
                                        dependsOnTaskId={st.dependsOnTaskId}
                                        candidates={stDep}
                                        tasks={selectedProject.tasks}
                                        updateTask={updateTask}
                                      />
                                    </td>
                                  </tr>
                                )
                              })}
                            {subExpanded && (
                              <tr
                                key={`${task.id}-subform`}
                                className="issues-table__task-row issues-table__task-row--subtask-form issues-table__task-row--subtask-nested"
                              >
                                <td colSpan={8} className="issues-table__td issues-table__td--subtask-quickadd">
                                  <div
                                    className="milestone-subtask-quickadd"
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => e.stopPropagation()}
                                  >
                                    <QuickAddTask
                                      key={`subtask-qa-${task.id}-${milestone.id}`}
                                      projectTasks={selectedProject.tasks.filter((t) => !t.parentTaskId)}
                                      todayDateString={todayDateString}
                                      assigneeUsers={users}
                                      onCreate={(payload) => createSubtaskFromQuickAdd(task.id, payload)}
                                      initialCollapsed={false}
                                      addButtonLabel="Добавить подзадачу"
                                      titlePlaceholder="Добавить подзадачу…"
                                      submitButtonLabel="Создать"
                                      ariaLabelParams="Параметры подзадачи"
                                    />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })
                      )}
                    </tbody>
                  </table>

                  {visibleCompletedTasks.length > 0 && (
                    <div className="milestone-completed">
                      <button
                        type="button"
                        className="milestone-completed__toggle"
                        onClick={() => toggleCompletedSection(milestone.id)}
                        aria-expanded={completedOpen}
                      >
                        <span className="milestone-completed__toggle-icon" aria-hidden>
                          ✔
                        </span>
                        Завершённые ({visibleCompletedTasks.length}){' '}
                        <span className="milestone-completed__caret" aria-hidden>
                          {completedOpen ? '▲' : '▼'}
                        </span>
                      </button>
                      {completedOpen && (
                        <ul className="milestone-completed__list">
                          {visibleCompletedTasks.map((t) => (
                            <li
                              key={t.id}
                              className={`milestone-completed__item${t.parentTaskId ? ' milestone-completed__item--subtask' : ''}`}
                            >
                              <span className="milestone-completed__check" aria-hidden>
                                ✔
                              </span>
                              {editingCompletedTaskId === t.id ? (
                                <div className="milestone-completed__edit">
                                  <input
                                    value={editingCompletedDraft.title}
                                    onChange={(e) =>
                                      setEditingCompletedDraft((prev) => ({ ...prev, title: e.target.value }))
                                    }
                                    placeholder="Название"
                                  />
                                  <select
                                    value={editingCompletedDraft.assigneeUserId}
                                    onChange={(e) =>
                                      setEditingCompletedDraft((prev) => ({
                                        ...prev,
                                        assigneeUserId: e.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">Не назначен</option>
                                    {users.map((u) => (
                                      <option key={u.id} value={u.id}>
                                        {u.name}
                                      </option>
                                    ))}
                                  </select>
                                  <input
                                    type="date"
                                    value={editingCompletedDraft.deadline}
                                    onChange={(e) =>
                                      setEditingCompletedDraft((prev) => ({ ...prev, deadline: e.target.value }))
                                    }
                                  />
                                  <div className="milestone-completed__actions">
                                    <button type="button" onClick={() => saveEditCompletedTask(t.id)}>
                                      Сохранить
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      onClick={cancelEditCompletedTask}
                                    >
                                      Отмена
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <span className="milestone-completed__title-wrap">
                                    <button
                                      type="button"
                                      className="task-open-btn task-open-btn--completed"
                                      onClick={() => setOpenedTaskId(t.id)}
                                    >
                                      {t.title}
                                    </button>
                                    <span className="milestone-completed__meta">
                                      {t.parentTaskId
                                        ? `К задаче: ${selectedProject.tasks.find((x) => x.id === t.parentTaskId)?.title ?? '—'} · `
                                        : ''}
                                      {t.assignee ? `👤 ${t.assignee}` : '👤 Не назначен'} · 📅{' '}
                                      {formatDate(t.deadline)}
                                    </span>
                                  </span>
                                  <div className="milestone-completed__actions">
                                    <button type="button" onClick={() => restoreCompletedTask(t.id)}>
                                      Вернуть
                                    </button>
                                    <button type="button" onClick={() => beginEditCompletedTask(t)}>
                                      Редактировать
                                    </button>
                                    <button type="button" onClick={() => deleteCompletedTask(t.id)}>
                                      Удалить
                                    </button>
                                  </div>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <QuickAddTask
                    key={`${resolvedSelectedProjectId}-${milestone.id}`}
                    projectTasks={selectedProject.tasks}
                    todayDateString={todayDateString}
                    onCreate={(payload) => createTaskInMilestone(milestone.id, payload)}
                    assigneeUsers={users}
                  />
                  </div>
                )}
              </article>
            )
          })}
          <div className="milestone-add-block" ref={addMilestoneAnchorRef}>
            {!addingMilestoneOpen ? (
              <button
                type="button"
                className="milestone-add-inline-trigger"
                onClick={() => {
                  setAddingMilestoneOpen(true)
                  setNewMilestoneNameDraft('')
                }}
              >
                Добавить веху
              </button>
            ) : (
              <div className="milestone-add-panel">
                <label className="milestone-add-panel__label" htmlFor={newMilestoneFieldId}>
                  Новая веха
                </label>
                <p className="milestone-add-panel__hint">Введите название и нажмите Enter</p>
                <form
                  className="milestone-add-panel__form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    createMilestone(newMilestoneNameDraft)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setAddingMilestoneOpen(false)
                      setNewMilestoneNameDraft('')
                    }
                  }}
                >
                  <input
                    id={newMilestoneFieldId}
                    ref={addMilestoneInputRef}
                    className="milestone-add-panel__input"
                    value={newMilestoneNameDraft}
                    onChange={(e) => setNewMilestoneNameDraft(e.target.value)}
                    placeholder="Например: Подготовка релиза"
                    autoComplete="off"
                    aria-label="Название новой вехи"
                  />
                </form>
              </div>
            )}
          </div>
        </div>
      </section>

      <ProjectGantt
        milestones={milestonesToRender}
        tasksByMilestone={tasksByMilestone}
        expandedIds={expandedMilestoneIdsResolved}
        onToggleMilestone={toggleMilestoneExpanded}
        visibleTasks={visibleTasks}
        milestoneDeadline={milestoneDeadline}
        applyTaskDates={applyGanttTaskDates}
        autoShift={autoShiftDependents}
        onAutoShiftChange={setAutoShiftDependents}
        violatingTaskIds={visibleViolatingTaskIds}
        todayStr={todayDateString}
        onOpenTask={setOpenedTaskId}
      />
        </>
      )}
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="empty-projects">
          <p className="muted">
            {projects.length === 0 ? 'Нет проектов' : 'В этой теме пока нет проектов'}
          </p>
          <button
            type="button"
            className="btn-primary empty-projects__btn"
            onClick={() => {
              setNewProjectTopicId(selectedTopicFilter === 'all' || selectedTopicFilter === 'none' ? null : selectedTopicFilter)
              setShowNewProjectModal(true)
            }}
          >
            <span className="btn-primary__icon" aria-hidden>
              +
            </span>
            Новый проект
          </button>
        </div>
      ) : null}
      {openedTask && selectedProject && currentUser && (
        <TaskLightPanel
          task={openedTask}
          tasks={selectedProject.tasks}
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          assigneeUsers={users}
          currentUser={currentUser}
          supabase={supabase}
          apiConnected={apiConnected}
          onUpdateTask={updateTask}
          onDeleteTask={deleteTaskById}
          onCopyTaskLink={copyTaskLink}
          onClose={() => setOpenedTaskId(null)}
          refresh={refresh}
        />
      )}
      {showNewTopicModal && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => {
            setShowNewTopicModal(false)
            setNewTopicDraft('')
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-topic-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="new-topic-title" className="heading-h3">
              Новая тема
            </h3>
            <label className="project-modal__field">
              <span>Название</span>
              <input
                value={newTopicDraft}
                onChange={(e) => setNewTopicDraft(e.target.value)}
                placeholder="Название темы"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createTopicFromModal()
                }}
              />
            </label>
            <div className="project-modal__actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowNewTopicModal(false)
                  setNewTopicDraft('')
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void createTopicFromModal()}
                disabled={!newTopicDraft.trim()}
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      )}
      {showNewProjectModal && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => {
            setShowNewProjectModal(false)
            setNewProjectTopicId(null)
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="new-project-title" className="heading-h3">
              Новый проект
            </h3>
            <label className="project-modal__field">
              <span>Название</span>
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Название проекта"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createProject()
                }}
              />
            </label>
            <label className="project-modal__field">
              <span>Тема</span>
              <select
                className="project-modal__select"
                value={newProjectTopicId ?? ''}
                onChange={(e) => setNewProjectTopicId(e.target.value || null)}
              >
                <option value="">Без темы</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-modal__actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowNewProjectModal(false)
                  setNewProjectTopicId(null)
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={createProject}
                disabled={!newProjectName.trim()}
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameProjectModal && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => {
            setShowRenameProjectModal(false)
            setRenameProjectTopicId(null)
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="rename-project-title" className="heading-h3">
              Изменить проект
            </h3>
            <label className="project-modal__field">
              <span>Название</span>
              <input
                value={renameProjectDraft}
                onChange={(e) => setRenameProjectDraft(e.target.value)}
                placeholder="Название проекта"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') renameProject()
                }}
              />
            </label>
            <label className="project-modal__field">
              <span>Тема</span>
              <select
                className="project-modal__select"
                value={renameProjectTopicId ?? ''}
                onChange={(e) => setRenameProjectTopicId(e.target.value || null)}
              >
                <option value="">Без темы</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-modal__actions project-modal__actions--stack">
              <div className="project-modal__actions-right">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowRenameProjectModal(false)
                    setRenameProjectTopicId(null)
                  }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={renameProject}
                  disabled={!renameProjectDraft.trim()}
                >
                  Сохранить
                </button>
              </div>
              <button
                type="button"
                className="btn-secondary project-modal__delete"
                onClick={() => void removeProject()}
              >
                Удалить проект
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditTopicModal && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => {
            setShowEditTopicModal(false)
            setEditTopicId(null)
            setEditTopicDraft('')
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-topic-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="edit-topic-title" className="heading-h3">
              Изменить тему
            </h3>
            <label className="project-modal__field">
              <span>Название темы</span>
              <input
                value={editTopicDraft}
                onChange={(e) => setEditTopicDraft(e.target.value)}
                placeholder="Название темы"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveEditedTopic()
                }}
              />
            </label>
            <div className="project-modal__actions project-modal__actions--stack">
              <div className="project-modal__actions-right">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowEditTopicModal(false)
                    setEditTopicId(null)
                    setEditTopicDraft('')
                  }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void saveEditedTopic()}
                  disabled={!editTopicDraft.trim()}
                >
                  Сохранить
                </button>
              </div>
              <button
                type="button"
                className="btn-secondary project-modal__delete"
                onClick={() => void removeEditedTopic()}
              >
                Удалить тему
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProject && selectedActiveCount > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Массовые действия с задачами">
          <span className="bulk-bar__count">Выбрано: {ruTasksCountLabel(selectedActiveCount)}</span>
          <div className="bulk-bar__actions">
            <button type="button" className="btn-primary" onClick={bulkCompleteSelected}>
              Завершить
            </button>
            <button type="button" className="btn-secondary" onClick={bulkDeleteSelected}>
              Удалить
            </button>
            <button
              type="button"
              className="btn-secondary btn-secondary--icon"
              onClick={clearTaskSelection}
              aria-label="Снять выделение"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </main>
    </>
  )
}

export default App
