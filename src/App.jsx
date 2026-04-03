import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'

const statusOptions = ['В работе', 'Готово']
const assigneeOptions = ['Альберт', 'Данил', 'Алексей', 'Алиса', 'Руслан']
const ungroupedMilestoneId = 'none'
const dayMs = 1000 * 60 * 60 * 24

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
 */

/**
 * Задача в проекте. Зависимость (MVP): не более одной родительской задачи в том же проекте.
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} assignee
 * @property {string} startDate
 * @property {string} deadline
 * @property {string | null} milestoneId
 * @property {string | null} dependsOnTaskId — id родительской задачи или null
 * @property {string} [comment] — комментарий при быстром создании
 * @property {TaskAttachment[]} [attachments]
 * @property {{ id: string, author: string, time: string, text: string }[]} [comments]
 */

const seedProjects = [
  {
    id: 'p1',
    name: 'Перезапуск сайта',
    milestones: [
      { id: 'm1', name: 'Планирование' },
      { id: 'm2', name: 'Разработка' },
      { id: 'm3', name: 'Запуск' },
    ],
    tasks: [
      {
        id: 't1',
        title: 'Определить объем работ',
        status: 'Готово',
        assignee: 'Альберт',
        startDate: '2026-03-20',
        deadline: '2026-03-23',
        milestoneId: 'm1',
        dependsOnTaskId: null,
      },
      {
        id: 't2',
        title: 'Согласование со стейкхолдерами',
        status: 'В работе',
        assignee: 'Данил',
        startDate: '2026-03-25',
        deadline: '2026-04-02',
        milestoneId: 'm1',
        dependsOnTaskId: null,
      },
      /* Тест A→B (ручной сдвиг дедлайна A: должна сдвинуться B). A: 1–3.04, B: 4–6.04.2026 */
      {
        id: 't3',
        title: 'Сверстать лендинг',
        status: 'В работе',
        assignee: 'Алиса',
        startDate: '2026-04-01',
        deadline: '2026-04-03',
        milestoneId: 'm2',
        dependsOnTaskId: null,
      },
      {
        id: 't4',
        title: 'Подключить аналитику',
        status: 'В работе',
        assignee: '',
        startDate: '2026-04-04',
        deadline: '2026-04-06',
        milestoneId: 'm2',
        dependsOnTaskId: 't3',
      },
      /* Цепочка A(t3)→B(t4)→C: сдвиг A на +2 дня тянет B, затем C */
      {
        id: 't4b',
        title: 'Интеграция формы (цепочка C)',
        status: 'В работе',
        assignee: '',
        startDate: '2026-04-07',
        deadline: '2026-04-09',
        milestoneId: 'm2',
        dependsOnTaskId: 't4',
      },
      {
        id: 't5',
        title: 'Финальная проверка текстов',
        status: 'В работе',
        assignee: 'Руслан',
        startDate: '2026-04-05',
        deadline: '2026-04-10',
        milestoneId: null,
        dependsOnTaskId: null,
      },
    ],
  },
  {
    id: 'p2',
    name: 'MVP мобильного приложения',
    milestones: [
      { id: 'm4', name: 'Ключевые сценарии' },
      { id: 'm5', name: 'Подготовка релиза' },
    ],
    tasks: [
      {
        id: 't6',
        title: 'Поток входа',
        status: 'В работе',
        assignee: 'Алиса',
        startDate: '2026-03-28',
        deadline: '2026-04-01',
        milestoneId: 'm4',
        dependsOnTaskId: null,
      },
      {
        id: 't7',
        title: 'Экран списка задач',
        status: 'В работе',
        assignee: 'Алексей',
        startDate: '2026-04-01',
        deadline: '2026-04-05',
        milestoneId: 'm4',
        dependsOnTaskId: null,
      },
      {
        id: 't8',
        title: 'Чеклист QA',
        status: 'В работе',
        assignee: 'Данил',
        startDate: '2026-04-05',
        deadline: '2026-04-10',
        milestoneId: 'm5',
        dependsOnTaskId: null,
      },
    ],
  },
]

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

const nowTimeLabel = () =>
  new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })

const maxDate = (dates) => {
  if (!dates.length) return null
  return dates.reduce((latest, current) =>
    toDate(current) > toDate(latest) ? current : latest,
  )
}

/** Склонение: «1 задачу», «2 задачи», «5 задач» */
const ruTasksCountLabel = (n) => {
  const abs = n % 100
  const d = n % 10
  if (abs > 10 && abs < 20) return `${n} задач`
  if (d === 1) return `${n} задачу`
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


function QuickAddTask({ projectTasks, todayDateString, onCreate, assigneeOptions, onAddAssignee }) {
  const titleInputId = useId()

  const [collapsed, setCollapsed] = useState(true)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [deadline, setDeadline] = useState(todayDateString)
  const [dependsOnTaskId, setDependsOnTaskId] = useState(null)
  const [dueOpen, setDueOpen] = useState(false)
  const [assigneeOpen, setAssigneeOpen] = useState(false)
  const [depOpen, setDepOpen] = useState(false)
  const [depSearch, setDepSearch] = useState('')
  /** Пока false — в pill показываем «Срок», дедлайн по умолчанию всё равно сегодня */
  const [dueTouched, setDueTouched] = useState(false)
  const [newAssigneeName, setNewAssigneeName] = useState('')
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
    setAssignee('')
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
      assignee: assignee.trim(),
      deadline,
      dependsOnTaskId,
      comment: '',
    })
    setTitle('')
    setAssignee('')
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
      Boolean(assignee.trim()) ||
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
          Добавить задачу
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
            placeholder="Добавить задачу…"
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Название задачи"
          />
          <button type="submit" className="btn-primary quick-add-main__submit" disabled={!title.trim()}>
            Создать
          </button>
        </div>

        <div className="quick-add-pills" role="group" aria-label="Параметры задачи">
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
                  {assignee.trim() ? assignee.trim() : 'Исполнитель'}
                </span>
              </button>
              {assigneeOpen && (
                <div className="quick-add-popover quick-add-popover--assignee" role="dialog" aria-label="Исполнитель">
                  <select
                    className="quick-add-popover__assignee-input"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setAssigneeOpen(false)
                      }
                    }}
                    aria-label="Исполнитель"
                  >
                    <option value="">Не назначен</option>
                    {assigneeOptions.map((person) => (
                      <option key={person} value={person}>
                        {person}
                      </option>
                    ))}
                  </select>
                  <div className="quick-add-popover__assignee-add">
                    <input
                      className="quick-add-popover__assignee-new"
                      value={newAssigneeName}
                      placeholder="Добавить исполнителя"
                      onChange={(e) => setNewAssigneeName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const added = onAddAssignee(newAssigneeName)
                          if (added) {
                            setAssignee(added)
                            setNewAssigneeName('')
                          }
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="quick-add-popover__assignee-add-btn"
                      onClick={() => {
                        const added = onAddAssignee(newAssigneeName)
                        if (added) {
                          setAssignee(added)
                          setNewAssigneeName('')
                        }
                      }}
                    >
                      Добавить
                    </button>
                  </div>
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

function InlineTaskAssignee({ taskId, assignee, assigneeOptions, updateTask }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  return (
    <div className="task-inline task-inline--assignee" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--assignee"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={assignee || 'Не назначен'}
      >
        <span className="avatar">{getInitials(assignee)}</span>
        <span className="task-inline__assignee-name">{assignee || 'Не назначен'}</span>
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
            updateTask(taskId, { assignee: '' })
            setOpen(false)
          }}
        >
          Не назначен
        </button>
        {assigneeOptions.map((person) => (
          <button
            key={person}
            type="button"
            className="task-inline__option"
            onClick={() => {
              updateTask(taskId, { assignee: person })
              setOpen(false)
            }}
          >
            {person}
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

function InlineTaskMilestone({ taskId, milestoneId, milestoneLabel, milestoneOptions, ungroupedId, updateTask }) {
  const { open, setOpen, anchorRef, popoverRef, coords } = useInlinePopover()
  return (
    <div className="task-inline task-inline--milestone" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-inline__trigger task-inline__trigger--milestone"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {milestoneLabel}
      </button>
      <TaskInlinePopoverPortal open={open} popoverRef={popoverRef} coords={coords} role="listbox" aria-label="Веха">
        {milestoneOptions.map((m) => (
          <button
            key={m.id}
            type="button"
            role="option"
            className={`task-inline__option${(milestoneId ?? ungroupedId) === m.id ? ' task-inline__option--active' : ''}`}
            onClick={() => {
              updateTask(taskId, {
                milestoneId: m.id === ungroupedId ? null : m.id,
              })
              setOpen(false)
            }}
          >
            {m.name}
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
    if (!open) setSearch('')
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
  projectName,
  milestoneName,
  assigneeOptions,
  onUpdateTask,
  onDeleteTask,
  onClose,
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
    const next = [...comments, { id: `c-${Date.now()}`, author: 'Данил', time: nowTimeLabel(), text }]
    onUpdateTask(task.id, { comments: next })
    setCommentText('')
  }

  const removeComment = (commentId) => {
    onUpdateTask(task.id, { comments: comments.filter((c) => c.id !== commentId) })
  }

  const attachments = task.attachments ?? []

  const removeAttachment = (attachmentId) => {
    const att = attachments.find((a) => a.id === attachmentId)
    if (att?.fileUrl?.startsWith('blob:')) URL.revokeObjectURL(att.fileUrl)
    onUpdateTask(task.id, { attachments: attachments.filter((a) => a.id !== attachmentId) })
  }

  const addFilesFromList = async (fileList) => {
    const files = [...fileList].filter((f) => f && f.size > 0)
    if (files.length === 0) return
    let list = [...attachments]
    let total = sumAttachmentBytes(list)
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
        const fileUrl = URL.createObjectURL(file)
        const newAtt = {
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          taskId: task.id,
          fileName: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          fileUrl,
        }
        list = [...list, newAtt]
        total += file.size
        onUpdateTask(task.id, { attachments: list })
        setAttachmentError(null)
      } catch {
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
    .filter((t) => t.id !== task.id)
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
              Задача • {projectName}
              {milestoneName ? ` / ${milestoneName}` : ''}
            </p>
            <div className="task-panel__icon-actions">
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
                value={task.assignee}
                onChange={(e) => onUpdateTask(task.id, { assignee: e.target.value })}
              >
                <option value="">Не назначен</option>
                {assigneeOptions.map((person) => (
                  <option key={person} value={person}>
                    {person}
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
                <button
                  type="button"
                  className="btn-secondary btn-secondary--danger"
                  onClick={() => onDeleteTask(task.id)}
                >
                  Удалить задачу
                </button>
                <button type="button" className="btn-primary" onClick={submitComment}>
                  Отправить
                </button>
              </div>
            </div>
          </section>
        </div>
      </article>
    </div>
  )
}

function App() {
  const [projects, setProjects] = useState(seedProjects)
  const [assigneeOptionsState, setAssigneeOptionsState] = useState(assigneeOptions)
  const [selectedProjectId, setSelectedProjectId] = useState(seedProjects[0].id)
  const [selectedTaskIds, setSelectedTaskIds] = useState([])
  /** `${projectId}:${milestoneId}` → развёрнут блок завершённых */
  const [expandedCompletedSections, setExpandedCompletedSections] = useState({})
  const [editingCompletedTaskId, setEditingCompletedTaskId] = useState(null)
  const [editingCompletedDraft, setEditingCompletedDraft] = useState({
    title: '',
    assignee: '',
    deadline: todayLocalDate(),
  })
  const [expandedMilestonesByProject, setExpandedMilestonesByProject] = useState(() =>
    Object.fromEntries(
      seedProjects.map((project) => [
        project.id,
        [ungroupedMilestoneId, ...project.milestones.map((m) => m.id)],
      ]),
    ),
  )
  const [milestonePlan, setMilestonePlan] = useState({})
  const [violatingTaskIds, setViolatingTaskIds] = useState([])
  const [dependencyError, setDependencyError] = useState(null)
  const [showNewProjectModal, setShowNewProjectModal] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [openedTaskId, setOpenedTaskId] = useState(null)
  const [editingMilestoneTitleId, setEditingMilestoneTitleId] = useState(null)
  const [editingMilestoneTitleDraft, setEditingMilestoneTitleDraft] = useState('')
  const [milestoneMenuOpenId, setMilestoneMenuOpenId] = useState(null)
  const [addingMilestoneOpen, setAddingMilestoneOpen] = useState(false)
  const [newMilestoneNameDraft, setNewMilestoneNameDraft] = useState('')
  const addMilestoneInputRef = useRef(null)
  const addMilestoneAnchorRef = useRef(null)
  const newMilestoneFieldId = useId()

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )
  const openedTask = useMemo(
    () => selectedProject?.tasks.find((t) => t.id === openedTaskId) ?? null,
    [selectedProject, openedTaskId],
  )

  useEffect(() => {
    if (projects.length === 0) return
    if (!projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id)
    }
  }, [projects, selectedProjectId])

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

  const switchProject = (id) => {
    setSelectedProjectId(id)
    setSelectedTaskIds([])
    setViolatingTaskIds([])
    setDependencyError(null)
    setOpenedTaskId(null)
  }

  const TAB_SHOW_ALL_MAX = 7
  const TAB_OVERFLOW_VISIBLE = 5
  const { primaryTabs, overflowTabs } = useMemo(() => {
    if (projects.length <= TAB_SHOW_ALL_MAX) {
      return { primaryTabs: projects, overflowTabs: [] }
    }
    return {
      primaryTabs: projects.slice(0, TAB_OVERFLOW_VISIBLE),
      overflowTabs: projects.slice(TAB_OVERFLOW_VISIBLE),
    }
  }, [projects])

  const createProject = () => {
    const name = newProjectName.trim()
    if (!name) return
    const id = `p-${Date.now()}`
    setProjects((prev) => [...prev, { id, name, milestones: [], tasks: [] }])
    setExpandedMilestonesByProject((prev) => ({
      ...prev,
      [id]: [ungroupedMilestoneId],
    }))
    setSelectedProjectId(id)
    setNewProjectName('')
    setShowNewProjectModal(false)
    setSelectedTaskIds([])
    setViolatingTaskIds([])
    setDependencyError(null)
  }

  const groupedMilestones = useMemo(() => {
    if (!selectedProject) return []
    return [
      { id: ungroupedMilestoneId, name: 'Без вехи' },
      ...selectedProject.milestones,
    ]
  }, [selectedProject])

  const tasksByMilestone = useMemo(() => {
    if (!selectedProject) return {}
    const map = Object.fromEntries(groupedMilestones.map((m) => [m.id, []]))
    selectedProject.tasks.forEach((task) => {
      const key = task.milestoneId ?? ungroupedMilestoneId
      if (!map[key]) map[key] = []
      map[key].push(task)
    })
    Object.keys(map).forEach((key) => {
      map[key] = map[key].slice().sort((a, b) => toDate(a.deadline) - toDate(b.deadline))
    })
    return map
  }, [selectedProject, groupedMilestones])

  const projectDeadline = useMemo(() => {
    if (!selectedProject) return null
    return maxDate(selectedProject.tasks.map((task) => task.deadline))
  }, [selectedProject])

  const milestoneDeadline = (milestoneId) => {
    const active = (tasksByMilestone[milestoneId] ?? []).filter((t) => t.status !== 'Готово')
    return maxDate(active.map((task) => task.deadline))
  }

  const updateTask = (taskId, patch) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        const oldTask = project.tasks.find((t) => t.id === taskId)
        if (!oldTask) return project

        if (patch.dependsOnTaskId !== undefined) {
          if (
            patch.dependsOnTaskId &&
            wouldDependencyCreateCycle(project.tasks, taskId, patch.dependsOnTaskId)
          ) {
            setDependencyError(DEPENDENCY_CYCLE_MESSAGE)
            return project
          }
          setDependencyError(null)
        }

        let merged = { ...oldTask, ...patch }
        let tasks = project.tasks.map((t) => (t.id === taskId ? merged : t))

        if (patch.dependsOnTaskId !== undefined && merged.dependsOnTaskId) {
          const parent = tasks.find((t) => t.id === merged.dependsOnTaskId)
          if (parent) {
            merged = rescheduleChildFromParent(parent, merged)
            tasks = tasks.map((t) => (t.id === taskId ? merged : t))
          }
        }

        /* Пересчёт зависимых только если реально изменился дедлайн родителя (не привязываемся к patch.deadline). */
        if (merged.deadline !== oldTask.deadline) {
          tasks = cascadeFsShiftFromParent(tasks, merged)
        }

        return { ...project, tasks }
      }),
    )
  }

  const shiftTaskDates = (taskId, days) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        const oldTask = project.tasks.find((t) => t.id === taskId)
        if (!oldTask) return project
        const merged = {
          ...oldTask,
          startDate: shiftDate(oldTask.startDate, days),
          deadline: shiftDate(oldTask.deadline, days),
        }
        let tasks = project.tasks.map((t) => (t.id === taskId ? merged : t))
        if (merged.deadline !== oldTask.deadline) {
          tasks = cascadeFsShiftFromParent(tasks, merged)
        }
        return { ...project, tasks }
      }),
    )
  }

  const changeTaskDuration = (taskId, durationDays) => {
    const safeDuration = Math.max(1, Number(durationDays) || 1)
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        const oldTask = project.tasks.find((t) => t.id === taskId)
        if (!oldTask) return project
        const merged = {
          ...oldTask,
          deadline: shiftDate(oldTask.startDate, safeDuration - 1),
        }
        let tasks = project.tasks.map((t) => (t.id === taskId ? merged : t))
        if (merged.deadline !== oldTask.deadline) {
          tasks = cascadeFsShiftFromParent(tasks, merged)
        }
        return { ...project, tasks }
      }),
    )
  }

  const toggleTaskSelection = (taskId) => {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    )
  }

  const selectedActiveCount = useMemo(() => {
    if (!selectedProject) return 0
    return selectedTaskIds.filter((id) => {
      const t = selectedProject.tasks.find((x) => x.id === id)
      return t && t.status !== 'Готово'
    }).length
  }, [selectedProject, selectedTaskIds])

  useEffect(() => {
    if (!selectedProject) return
    setSelectedTaskIds((prev) => {
      const next = prev.filter((id) => {
        const t = selectedProject.tasks.find((x) => x.id === id)
        return t && t.status !== 'Готово'
      })
      return next.length === prev.length ? prev : next
    })
  }, [selectedProject, selectedProject.tasks])

  const bulkCompleteSelected = () => {
    if (!selectedProject) return
    const ids = new Set(
      selectedTaskIds.filter((id) => {
        const t = selectedProject.tasks.find((x) => x.id === id)
        return t && t.status !== 'Готово'
      }),
    )
    if (ids.size === 0) return
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((t) => (ids.has(t.id) ? { ...t, status: 'Готово' } : t)),
        }
      }),
    )
    setSelectedTaskIds((prev) => prev.filter((id) => !ids.has(id)))
  }

  const bulkDeleteSelected = () => {
    if (!selectedProject) return
    const ids = new Set(
      selectedTaskIds.filter((id) => {
        const t = selectedProject.tasks.find((x) => x.id === id)
        return t && t.status !== 'Готово'
      }),
    )
    if (ids.size === 0) return
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        for (const t of project.tasks) {
          if (ids.has(t.id)) revokeTaskAttachmentUrls(t)
        }
        const remaining = project.tasks.filter((t) => !ids.has(t.id))
        const cleaned = remaining.map((t) => ({
          ...t,
          dependsOnTaskId:
            t.dependsOnTaskId && ids.has(t.dependsOnTaskId) ? null : t.dependsOnTaskId,
        }))
        return { ...project, tasks: cleaned }
      }),
    )
    setSelectedTaskIds([])
  }

  const deleteTaskById = (taskId) => {
    if (!window.confirm('Удалить задачу?')) return
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        const taskToKill = project.tasks.find((t) => t.id === taskId)
        if (taskToKill) revokeTaskAttachmentUrls(taskToKill)
        const remaining = project.tasks.filter((t) => t.id !== taskId)
        const cleaned = remaining.map((t) => ({
          ...t,
          dependsOnTaskId: t.dependsOnTaskId === taskId ? null : t.dependsOnTaskId,
        }))
        return { ...project, tasks: cleaned }
      }),
    )
    setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
    setOpenedTaskId(null)
    if (editingCompletedTaskId === taskId) setEditingCompletedTaskId(null)
  }

  const clearTaskSelection = () => setSelectedTaskIds([])

  const toggleCompletedSection = (milestoneId) => {
    const key = `${selectedProjectId}:${milestoneId}`
    setExpandedCompletedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const addAssigneeOption = (name) => {
    const normalized = name.trim()
    if (!normalized) return null
    const existing = assigneeOptionsState.find((x) => x.toLowerCase() === normalized.toLowerCase())
    if (existing) return existing
    setAssigneeOptionsState((prev) => [...prev, normalized])
    return normalized
  }

  const restoreCompletedTask = (taskId) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((t) => (t.id === taskId ? { ...t, status: 'В работе' } : t)),
        }
      }),
    )
    if (editingCompletedTaskId === taskId) {
      setEditingCompletedTaskId(null)
    }
  }

  const deleteCompletedTask = (taskId) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        const taskToKill = project.tasks.find((t) => t.id === taskId)
        if (taskToKill) revokeTaskAttachmentUrls(taskToKill)
        const remaining = project.tasks.filter((t) => t.id !== taskId)
        const cleaned = remaining.map((t) => ({
          ...t,
          dependsOnTaskId: t.dependsOnTaskId === taskId ? null : t.dependsOnTaskId,
        }))
        return { ...project, tasks: cleaned }
      }),
    )
    if (editingCompletedTaskId === taskId) {
      setEditingCompletedTaskId(null)
    }
    if (openedTaskId === taskId) {
      setOpenedTaskId(null)
    }
  }

  const beginEditCompletedTask = (task) => {
    setEditingCompletedTaskId(task.id)
    setEditingCompletedDraft({
      title: task.title,
      assignee: task.assignee || '',
      deadline: task.deadline,
    })
  }

  const saveEditCompletedTask = (taskId) => {
    const title = editingCompletedDraft.title.trim()
    if (!title) return
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  title,
                  assignee: editingCompletedDraft.assignee.trim(),
                  deadline: editingCompletedDraft.deadline,
                }
              : t,
          ),
        }
      }),
    )
    setEditingCompletedTaskId(null)
  }

  const cancelEditCompletedTask = () => {
    setEditingCompletedTaskId(null)
  }

  const toggleMilestoneExpanded = (milestoneId) => {
    setExpandedMilestonesByProject((prev) => {
      const current = new Set(prev[selectedProjectId] ?? [])
      if (current.has(milestoneId)) current.delete(milestoneId)
      else current.add(milestoneId)
      return { ...prev, [selectedProjectId]: [...current] }
    })
  }

  const shiftTasksByIds = (ids, days) => {
    if (!ids.length) return
    const idSet = new Set(ids)
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        let tasks = project.tasks.map((task) =>
          idSet.has(task.id)
            ? {
                ...task,
                startDate: shiftDate(task.startDate, days),
                deadline: shiftDate(task.deadline, days),
              }
            : task,
        )
        for (const id of ids) {
          const parent = tasks.find((t) => t.id === id)
          if (parent) tasks = cascadeFsShiftFromParent(tasks, parent)
        }
        return { ...project, tasks }
      }),
    )
  }

  const createTaskInMilestone = (milestoneId, { title, assignee, deadline, dependsOnTaskId, comment }) => {
    if (!title.trim() || !selectedProject) return
    const id = `t-${Date.now()}`
    const milestoneIdResolved = milestoneId === ungroupedMilestoneId ? null : milestoneId

    const baseTask = {
      id,
      title: title.trim(),
      status: 'В работе',
      assignee: (assignee || '').trim(),
      startDate: todayLocalDate(),
      deadline: deadline || todayLocalDate(),
      milestoneId: milestoneIdResolved,
      dependsOnTaskId: dependsOnTaskId || null,
      comment: (comment || '').trim(),
      attachments: [],
    }

    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project

        if (baseTask.dependsOnTaskId) {
          if (wouldDependencyCreateCycle(project.tasks, id, baseTask.dependsOnTaskId)) {
            setDependencyError(DEPENDENCY_CYCLE_MESSAGE)
            return project
          }
          setDependencyError(null)
        } else {
          setDependencyError(null)
        }

        let merged = { ...baseTask }
        let tasks = [...project.tasks]

        if (merged.dependsOnTaskId) {
          const parent = tasks.find((t) => t.id === merged.dependsOnTaskId)
          if (parent) {
            merged = rescheduleChildFromParent(parent, merged)
          }
        }

        tasks = [...tasks, merged]
        return { ...project, tasks }
      }),
    )
  }

  const applyMilestoneDeadlinePlan = (milestoneId, targetParam) => {
    const plan = milestonePlan[milestoneId]
    const target = targetParam ?? plan?.target
    const current = milestoneDeadline(milestoneId)
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
      setViolatingTaskIds(tasks.filter((task) => diffDays(task.deadline, target) > 0).map((t) => t.id))
    }
  }

  const createMilestone = (rawName) => {
    const name = rawName.trim()
    if (!name) return
    const id = `m-${Date.now()}`
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== selectedProjectId) return p
        return { ...p, milestones: [...p.milestones, { id, name }] }
      }),
    )
    setExpandedMilestonesByProject((prev) => ({
      ...prev,
      [selectedProjectId]: [...(prev[selectedProjectId] ?? []), id],
    }))
    setAddingMilestoneOpen(false)
    setNewMilestoneNameDraft('')
  }

  const renameMilestone = (milestoneId, name) => {
    const trimmed = name.trim()
    if (!trimmed || milestoneId === ungroupedMilestoneId) return
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== selectedProjectId) return p
        return {
          ...p,
          milestones: p.milestones.map((m) => (m.id === milestoneId ? { ...m, name: trimmed } : m)),
        }
      }),
    )
  }

  const deleteMilestone = (milestoneId) => {
    if (milestoneId === ungroupedMilestoneId) return
    if (!window.confirm('Удалить веху? Задачи перейдут в «Без вехи».')) return
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== selectedProjectId) return p
        return {
          ...p,
          milestones: p.milestones.filter((m) => m.id !== milestoneId),
          tasks: p.tasks.map((t) =>
            t.milestoneId === milestoneId ? { ...t, milestoneId: null } : t,
          ),
        }
      }),
    )
    setMilestonePlan((prev) => {
      const next = { ...prev }
      delete next[milestoneId]
      return next
    })
    setExpandedMilestonesByProject((prev) => ({
      ...prev,
      [selectedProjectId]: (prev[selectedProjectId] ?? []).filter((id) => id !== milestoneId),
    }))
    setMilestoneMenuOpenId(null)
  }

  const completeMilestoneTasks = (milestoneId) => {
    const tasks = tasksByMilestone[milestoneId] ?? []
    const active = tasks.filter((t) => t.status !== 'Готово')
    if (active.length === 0) return
    const ids = new Set(active.map((t) => t.id))
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== selectedProjectId) return p
        return {
          ...p,
          tasks: p.tasks.map((t) => (ids.has(t.id) ? { ...t, status: 'Готово' } : t)),
        }
      }),
    )
    setMilestoneMenuOpenId(null)
  }

  const sortedTasks = selectedProject
    ? selectedProject.tasks.slice().sort((a, b) => toDate(a.deadline) - toDate(b.deadline))
    : []

  const today = dateOnly(new Date())
  const todayDateString = toLocalDateString(today)
  const overdueTasks = sortedTasks.filter(
    (task) => toDate(task.deadline) < today && task.status !== 'Готово',
  )
  const todayTasks = sortedTasks.filter(
    (task) => diffDays(task.deadline, todayDateString) === 0 && task.status !== 'Готово',
  )
  /** Дедлайн в ближайшие 7 дней включительно (0 = сегодня … 7 = через неделю). */
  const upcomingTasks = sortedTasks.filter((task) => {
    if (task.status === 'Готово') return false
    const d = diffDays(task.deadline, todayDateString)
    return d >= 0 && d <= 7
  })
  const problematicTasks = sortedTasks.filter((task) => {
    if (task.status === 'Готово') return false
    const noAssignee = !task.assignee
    const overdue = toDate(task.deadline) < today
    const tooLongInProgress =
      task.status === 'В работе' && Math.round((today - toDate(task.startDate)) / dayMs) > 10
    const d = diffDays(task.deadline, todayDateString)
    const blocksOthersSoon =
      getDependencyMeta(task, selectedProject?.tasks ?? []).isBlocking && d >= 0 && d <= 7
    return noAssignee || overdue || tooLongInProgress || blocksOthersSoon
  })

  const timelineRange = useMemo(() => {
    if (!sortedTasks.length) {
      const value = todayLocalDate()
      return { start: value, end: value, days: 1 }
    }
    const start = sortedTasks.reduce((min, task) =>
      toDate(task.startDate) < toDate(min) ? task.startDate : min,
    sortedTasks[0].startDate)
    const end = sortedTasks.reduce((max, task) =>
      toDate(task.deadline) > toDate(max) ? task.deadline : max,
    sortedTasks[0].deadline)
    return { start, end, days: Math.max(1, diffDays(end, start) + 1) }
  }, [sortedTasks])

  const openTaskFromFeedRow = (e, taskId) => {
    if (e.target.closest('button, a, input, select')) return
    setOpenedTaskId(taskId)
  }

  return (
    <main
      className={`app-shell${selectedActiveCount > 0 ? ' app-shell--bulk-open' : ''}`}
    >
      <header className="app-header">
        <h1 className="heading-h1">Командный центр проекта</h1>
        <p className="app-header__subtitle">
          Центр управления сроками и задачами в режиме приоритета дедлайнов.
        </p>
      </header>

      <nav className="project-tabs" aria-label="Проекты">
        <div className="section-header project-tabs__header">
          <h2 className="heading-h2">Проекты</h2>
          <button type="button" className="btn-primary" onClick={() => setShowNewProjectModal(true)}>
            <span className="btn-primary__icon" aria-hidden>
              +
            </span>
            Новый проект
          </button>
        </div>
        <div className="project-tabs__list">
          {primaryTabs.map((project) => (
            <button
              key={project.id}
              type="button"
              role="tab"
              aria-selected={selectedProjectId === project.id}
              className={`project-tab ${selectedProjectId === project.id ? 'project-tab--active' : ''}`}
              onClick={() => switchProject(project.id)}
            >
              <span className="project-tab__label">{project.name}</span>
              <span className="project-tab__count">({project.tasks.length})</span>
            </button>
          ))}
          {overflowTabs.length > 0 && (
            <details className="project-tabs__overflow">
              <summary className="project-tab project-tab--overflow">ещё {overflowTabs.length}</summary>
              <div className="project-tabs__overflow-menu">
                {overflowTabs.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="project-tabs__overflow-item"
                    onClick={() => switchProject(project.id)}
                  >
                    {project.name}{' '}
                    <span className="project-tab__count">({project.tasks.length})</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
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

      {selectedProject ? (
        <div key={selectedProjectId} className="app-shell-content app-shell-content--fade">
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
              if (!task.assignee) subtitle = 'Нет исполнителя'
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
          {groupedMilestones.map((milestone) => {
            const tasks = tasksByMilestone[milestone.id] ?? []
            const activeTasks = tasks.filter((t) => t.status !== 'Готово')
            const completedTasks = tasks.filter((t) => t.status === 'Готово')
            const expanded = (expandedMilestonesByProject[selectedProjectId] ?? []).includes(
              milestone.id,
            )
            const deadline = milestoneDeadline(milestone.id)
            const overdueInMilestone = activeTasks.filter(
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
              activeTasks.length > 0 && activeTasks.every((t) => selectedTaskIds.includes(t.id))
            const completedKey = `${selectedProjectId}:${milestone.id}`
            const completedOpen = Boolean(expandedCompletedSections[completedKey])
            const isUngrouped = milestone.id === ungroupedMilestoneId
            const menuOpen = milestoneMenuOpenId === milestone.id

            return (
              <article
                key={milestone.id}
                className="milestone-card"
                onClick={() => {
                  if (editingMilestoneTitleId === milestone.id) return
                  toggleMilestoneExpanded(milestone.id)
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
                    {ruTasksCountLabel(activeTasks.length)}
                  </span>
                  {overdueInMilestone > 0 && (
                    <span className="milestone-meta-pill milestone-meta-pill--overdue-tasks">
                      {overdueInMilestone} просрочено
                    </span>
                  )}
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
                      <col className="issues-table__col issues-table__col--milestone" />
                      <col className="issues-table__col issues-table__col--dep" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className="issues-table__th issues-table__th--check">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => {
                              if (allSelected) {
                                const ids = new Set(activeTasks.map((t) => t.id))
                                setSelectedTaskIds((prev) => prev.filter((id) => !ids.has(id)))
                                return
                              }
                              setSelectedTaskIds((prev) => [
                                ...new Set([...prev, ...activeTasks.map((t) => t.id)]),
                              ])
                            }}
                            aria-label="Выбрать все активные задачи вехи"
                          />
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
                          Веха
                        </th>
                        <th scope="col" className="issues-table__th issues-table__th--center">
                          Зависит от
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTasks.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="issues-table__empty">
                            Нет активных задач
                          </td>
                        </tr>
                      ) : (
                      activeTasks.map((task) => {
                        const label = getDeadlineLabel(task.deadline)
                        const isViolation = violatingTaskIds.includes(task.id)
                        const isSelected = selectedTaskIds.includes(task.id)
                        const milestonePickerOptions = [
                          { id: ungroupedMilestoneId, name: 'Без вехи' },
                          ...selectedProject.milestones,
                        ]
                        const milestoneLabel =
                          task.milestoneId == null
                            ? 'Без вехи'
                            : selectedProject.milestones.find((m) => m.id === task.milestoneId)?.name ?? '—'
                        const depCandidates = selectedProject.tasks.filter((c) => c.id !== task.id)
                        return (
                          <tr
                            key={task.id}
                            className={`issues-table__task-row task-row--urgency-${label} ${isViolation ? 'row-violation' : ''} ${isSelected ? 'task-row--selected' : ''}`}
                            onClick={(e) => {
                              if (e.target.closest('input, select, button, a, .task-inline')) return
                              setOpenedTaskId(task.id)
                            }}
                          >
                            <td className="issues-table__td issues-table__td--check">
                              <input
                                type="checkbox"
                                checked={selectedTaskIds.includes(task.id)}
                                onChange={() => toggleTaskSelection(task.id)}
                              />
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
                                  assignee={task.assignee}
                                  assigneeOptions={assigneeOptionsState}
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
                              <InlineTaskMilestone
                                taskId={task.id}
                                milestoneId={task.milestoneId}
                                milestoneLabel={milestoneLabel}
                                milestoneOptions={milestonePickerOptions}
                                ungroupedId={ungroupedMilestoneId}
                                updateTask={updateTask}
                              />
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
                        )
                      })
                      )}
                    </tbody>
                  </table>

                  {completedTasks.length > 0 && (
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
                        Завершённые ({completedTasks.length}){' '}
                        <span className="milestone-completed__caret" aria-hidden>
                          {completedOpen ? '▲' : '▼'}
                        </span>
                      </button>
                      {completedOpen && (
                        <ul className="milestone-completed__list">
                          {completedTasks.map((t) => (
                            <li key={t.id} className="milestone-completed__item">
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
                                    value={editingCompletedDraft.assignee}
                                    onChange={(e) =>
                                      setEditingCompletedDraft((prev) => ({ ...prev, assignee: e.target.value }))
                                    }
                                  >
                                    <option value="">Не назначен</option>
                                    {assigneeOptionsState.map((person) => (
                                      <option key={person} value={person}>
                                        {person}
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
                                      {t.assignee ? `👤 ${t.assignee}` : '👤 Не назначен'} · 📅 {formatDate(t.deadline)}
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
                    key={`${selectedProjectId}-${milestone.id}`}
                    projectTasks={selectedProject.tasks}
                    todayDateString={todayDateString}
                    onCreate={(payload) => createTaskInMilestone(milestone.id, payload)}
                    assigneeOptions={assigneeOptionsState}
                    onAddAssignee={addAssigneeOption}
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

      <section className="panel">
        <div className="section-header">
          <h2 className="heading-h2">Таймлайн (MVP псевдо-гант)</h2>
        </div>
        <div className="timeline-scale">
          <span>{timelineRange.start}</span>
          <span>{timelineRange.end}</span>
        </div>
        <div className="timeline-list">
          {sortedTasks.map((task) => {
            const left = (Math.max(0, diffDays(task.startDate, timelineRange.start)) / timelineRange.days) * 100
            const durationDays = Math.max(1, diffDays(task.deadline, task.startDate) + 1)
            const width = (durationDays / timelineRange.days) * 100
            const deadlineLabel = getDeadlineLabel(task.deadline)
            const isViolation = violatingTaskIds.includes(task.id)
            const timelineBarClass = isViolation
              ? 'timeline-bar--problem'
              : `timeline-bar--${deadlineLabel}`
            return (
              <div key={task.id} className={`timeline-row timeline-row--urgency-${deadlineLabel}`}>
                <div className="timeline-meta">
                  <button type="button" className="task-open-btn" onClick={() => setOpenedTaskId(task.id)}>
                    {task.title}
                  </button>
                  <TaskDependencyPanel task={task} tasks={selectedProject.tasks} compact />
                  <span className="muted">
                    {task.startDate} {'->'} {task.deadline}
                  </span>
                </div>
                <div className="timeline-track">
                  <div
                    className={`timeline-bar ${timelineBarClass}`}
                    style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }}
                  />
                </div>
                <div className="timeline-actions">
                  <button type="button" onClick={() => shiftTaskDates(task.id, -1)}>
                    -1 д
                  </button>
                  <button type="button" onClick={() => shiftTaskDates(task.id, 1)}>
                    +1 д
                  </button>
                  <label className="inline-control">
                    Длительность
                    <input
                      type="number"
                      min="1"
                      value={durationDays}
                      onChange={(event) => changeTaskDuration(task.id, event.target.value)}
                    />
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </section>
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-projects">
          <p className="muted">Нет проектов</p>
          <button type="button" className="btn-primary empty-projects__btn" onClick={() => setShowNewProjectModal(true)}>
            <span className="btn-primary__icon" aria-hidden>
              +
            </span>
            Новый проект
          </button>
        </div>
      ) : null}
      {openedTask && selectedProject && (
        <TaskLightPanel
          task={openedTask}
          tasks={selectedProject.tasks}
          projectName={selectedProject.name}
          milestoneName={
            openedTask.milestoneId
              ? selectedProject.milestones.find((m) => m.id === openedTask.milestoneId)?.name ?? null
              : 'Без вехи'
          }
          assigneeOptions={assigneeOptionsState}
          onUpdateTask={updateTask}
          onDeleteTask={deleteTaskById}
          onClose={() => setOpenedTaskId(null)}
        />
      )}
      {showNewProjectModal && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={() => setShowNewProjectModal(false)}
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
            <div className="project-modal__actions">
              <button type="button" className="btn-secondary" onClick={() => setShowNewProjectModal(false)}>
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

      {selectedProject && selectedActiveCount > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Массовые действия с задачами">
          <span className="bulk-bar__count">
            Выбрано задач: {selectedActiveCount}
          </span>
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
  )
}

export default App
