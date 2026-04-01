import { useMemo, useState } from 'react'
import './App.css'

const statusOptions = ['К выполнению', 'В работе', 'Готово']
const ungroupedMilestoneId = 'none'
const dayMs = 1000 * 60 * 60 * 24

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
        assignee: 'Ira',
        startDate: '2026-03-20',
        deadline: '2026-03-23',
        milestoneId: 'm1',
      },
      {
        id: 't2',
        title: 'Согласование со стейкхолдерами',
        status: 'В работе',
        assignee: 'Nikita',
        startDate: '2026-03-25',
        deadline: '2026-04-02',
        milestoneId: 'm1',
      },
      {
        id: 't3',
        title: 'Сверстать лендинг',
        status: 'К выполнению',
        assignee: 'Maya',
        startDate: '2026-04-01',
        deadline: '2026-04-06',
        milestoneId: 'm2',
      },
      {
        id: 't4',
        title: 'Подключить аналитику',
        status: 'К выполнению',
        assignee: '',
        startDate: '2026-04-02',
        deadline: '2026-04-08',
        milestoneId: 'm2',
      },
      {
        id: 't5',
        title: 'Финальная проверка текстов',
        status: 'К выполнению',
        assignee: 'Oleg',
        startDate: '2026-04-05',
        deadline: '2026-04-10',
        milestoneId: null,
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
        assignee: 'Anna',
        startDate: '2026-03-28',
        deadline: '2026-04-01',
        milestoneId: 'm4',
      },
      {
        id: 't7',
        title: 'Экран списка задач',
        status: 'К выполнению',
        assignee: 'Leo',
        startDate: '2026-04-01',
        deadline: '2026-04-05',
        milestoneId: 'm4',
      },
      {
        id: 't8',
        title: 'Чеклист QA',
        status: 'К выполнению',
        assignee: 'Dmitry',
        startDate: '2026-04-05',
        deadline: '2026-04-10',
        milestoneId: 'm5',
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
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / dayMs)
const shiftDate = (dateString, days) => {
  const date = toDate(dateString)
  date.setDate(date.getDate() + days)
  return toLocalDateString(date)
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

const getProjectCode = (name) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 4)

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

function App() {
  const [projects, setProjects] = useState(seedProjects)
  const [selectedProjectId, setSelectedProjectId] = useState(seedProjects[0].id)
  const [selectedTaskIds, setSelectedTaskIds] = useState([])
  const [bulkMoveTargetMilestoneId, setBulkMoveTargetMilestoneId] = useState('')
  const [bulkShiftDays, setBulkShiftDays] = useState(1)
  const [newTask, setNewTask] = useState({
    title: '',
    assignee: '',
    status: 'К выполнению',
    deadline: shiftDate(todayLocalDate(), 3),
    milestoneId: ungroupedMilestoneId,
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

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

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

  const milestoneDeadline = (milestoneId) =>
    maxDate((tasksByMilestone[milestoneId] ?? []).map((task) => task.deadline))

  const updateTask = (taskId, patch) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
        }
      }),
    )
  }

  const shiftTaskDates = (taskId, days) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  startDate: shiftDate(task.startDate, days),
                  deadline: shiftDate(task.deadline, days),
                }
              : task,
          ),
        }
      }),
    )
  }

  const changeTaskDuration = (taskId, durationDays) => {
    const safeDuration = Math.max(1, Number(durationDays) || 1)
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((task) =>
            task.id === taskId
              ? { ...task, deadline: shiftDate(task.startDate, safeDuration - 1) }
              : task,
          ),
        }
      }),
    )
  }

  const toggleTaskSelection = (taskId) => {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    )
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
        return {
          ...project,
          tasks: project.tasks.map((task) =>
            idSet.has(task.id)
              ? {
                  ...task,
                  startDate: shiftDate(task.startDate, days),
                  deadline: shiftDate(task.deadline, days),
                }
              : task,
          ),
        }
      }),
    )
  }

  const moveSelectedTasks = () => {
    if (!bulkMoveTargetMilestoneId || !selectedTaskIds.length) return
    const idSet = new Set(selectedTaskIds)
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProjectId) return project
        return {
          ...project,
          tasks: project.tasks.map((task) =>
            idSet.has(task.id)
              ? {
                  ...task,
                  milestoneId:
                    bulkMoveTargetMilestoneId === ungroupedMilestoneId
                      ? null
                      : bulkMoveTargetMilestoneId,
                }
              : task,
          ),
        }
      }),
    )
  }

  const createTask = () => {
    if (!newTask.title.trim() || !selectedProject) return
    const task = {
      id: `t-${Date.now()}`,
      title: newTask.title.trim(),
      status: newTask.status,
      assignee: newTask.assignee.trim(),
      startDate: todayLocalDate(),
      deadline: newTask.deadline,
      milestoneId: newTask.milestoneId === ungroupedMilestoneId ? null : newTask.milestoneId,
    }
    setProjects((prev) =>
      prev.map((project) =>
        project.id === selectedProjectId
          ? { ...project, tasks: [...project.tasks, task] }
          : project,
      ),
    )
    setNewTask((prev) => ({ ...prev, title: '', assignee: '' }))
  }

  const applyMilestoneDeadlinePlan = (milestoneId) => {
    const plan = milestonePlan[milestoneId]
    const current = milestoneDeadline(milestoneId)
    if (!plan?.target || !current) return
    const tasks = tasksByMilestone[milestoneId] ?? []
    if (!tasks.length) return

    if (plan.mode === 'shift') {
      const days = diffDays(plan.target, current)
      shiftTasksByIds(
        tasks.map((task) => task.id),
        days,
      )
      return
    }

    if (plan.mode === 'highlight') {
      setViolatingTaskIds(tasks.filter((task) => diffDays(task.deadline, plan.target) > 0).map((t) => t.id))
    }
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
  const upcomingTasks = sortedTasks.filter((task) => {
    const days = Math.round((toDate(task.deadline) - today) / dayMs)
    return days > 0 && days <= 7 && task.status !== 'Готово'
  })
  const problematicTasks = sortedTasks.filter((task) => {
    const noAssignee = !task.assignee
    const overdue = toDate(task.deadline) < today && task.status !== 'Готово'
    const tooLongInProgress =
      task.status === 'В работе' && Math.round((today - toDate(task.startDate)) / dayMs) > 10
    return noAssignee || overdue || tooLongInProgress
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

  if (!selectedProject) return null

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Командный центр проекта</h1>
        <p>Центр управления сроками и задачами в режиме приоритета дедлайнов.</p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Проект</h2>
          <select
            value={selectedProjectId}
            onChange={(event) => {
              setSelectedProjectId(event.target.value)
              setSelectedTaskIds([])
              setBulkMoveTargetMilestoneId('')
              setViolatingTaskIds([])
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="muted">
            Авто-дедлайн: {projectDeadline ? formatDate(projectDeadline) : 'Нет данных'}
          </span>
        </div>
      </section>

      <section className="panel command-grid">
        <article className="command-card danger">
          <h3>Просроченные</h3>
          <p>{overdueTasks.length}</p>
        </article>
        <article className="command-card warning">
          <h3>На сегодня</h3>
          <p>{todayTasks.length}</p>
        </article>
        <article className="command-card ok">
          <h3>Ближайшие (7 дн.)</h3>
          <p>{upcomingTasks.length}</p>
        </article>
        <article className="command-card neutral">
          <h3>Проблемные</h3>
          <p>{problematicTasks.length}</p>
        </article>
      </section>

      <section className="panel">
        <h2>Лента командного центра</h2>
        <div className="feed-grid">
          <div>
            <h4>Просроченные</h4>
            {overdueTasks.map((task) => (
              <div key={task.id} className="feed-row">
                <span>{task.title}</span>
                <span className="tag overdue">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div>
            <h4>На сегодня</h4>
            {todayTasks.map((task) => (
              <div key={task.id} className="feed-row">
                <span>{task.title}</span>
                <span className="tag today">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div>
            <h4>Ближайшие</h4>
            {upcomingTasks.map((task) => (
              <div key={task.id} className="feed-row">
                <span>{task.title}</span>
                <span className="tag upcoming">{formatDate(task.deadline)}</span>
              </div>
            ))}
          </div>
          <div>
            <h4>Проблемные</h4>
            {problematicTasks.map((task) => (
              <div key={task.id} className="feed-row">
                <span>{task.title}</span>
                <span className="muted">
                  {!task.assignee ? 'Нет исполнителя' : 'Требует внимания'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Быстрое создание задачи</h2>
        <div className="create-row">
          <label className="create-field">
            <span>Название задачи</span>
            <input
              value={newTask.title}
              placeholder="Название задачи"
              onChange={(event) => setNewTask((prev) => ({ ...prev, title: event.target.value }))}
            />
          </label>
          <label className="create-field">
            <span>Исполнитель</span>
            <input
              value={newTask.assignee}
              placeholder="Исполнитель"
              onChange={(event) => setNewTask((prev) => ({ ...prev, assignee: event.target.value }))}
            />
          </label>
          <label className="create-field">
            <span>Статус</span>
            <select
              value={newTask.status}
              onChange={(event) => setNewTask((prev) => ({ ...prev, status: event.target.value }))}
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="create-field">
            <span>Дедлайн</span>
            <input
              type="date"
              value={newTask.deadline}
              onChange={(event) => setNewTask((prev) => ({ ...prev, deadline: event.target.value }))}
            />
          </label>
          <label className="create-field">
            <span>Веха</span>
            <select
              value={newTask.milestoneId}
              onChange={(event) => setNewTask((prev) => ({ ...prev, milestoneId: event.target.value }))}
            >
              <option value={ungroupedMilestoneId}>Без вехи</option>
              {selectedProject.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={createTask}>
            Добавить
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Массовые действия</h2>
        <div className="toolbar">
          <span className="muted">Выбрано: {selectedTaskIds.length}</span>
          <label className="inline-control">
            Переместить выбранные в
            <select
              value={bulkMoveTargetMilestoneId}
              onChange={(event) => setBulkMoveTargetMilestoneId(event.target.value)}
            >
              <option value="">Выбрать</option>
              <option value={ungroupedMilestoneId}>Без вехи</option>
              {selectedProject.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={moveSelectedTasks}
            disabled={!bulkMoveTargetMilestoneId || selectedTaskIds.length === 0}
          >
            Переместить
          </button>
          <label className="inline-control">
            Сдвиг выбранных на
            <select
              value={bulkShiftDays}
              onChange={(event) => setBulkShiftDays(Number(event.target.value))}
            >
              <option value={1}>+1 день</option>
              <option value={3}>+3 дня</option>
              <option value={7}>+7 дней</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => shiftTasksByIds(selectedTaskIds, bulkShiftDays)}
            disabled={selectedTaskIds.length === 0}
          >
            Сдвинуть выбранные
          </button>
          <button
            type="button"
            onClick={() => shiftTasksByIds(overdueTasks.map((t) => t.id), 1)}
            disabled={overdueTasks.length === 0}
          >
            Сдвинуть просроченные +1
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Задачи по вехам (всегда в контексте проекта)</h2>
        <div className="stack">
          {groupedMilestones.map((milestone) => {
            const tasks = tasksByMilestone[milestone.id] ?? []
            const expanded = (expandedMilestonesByProject[selectedProjectId] ?? []).includes(
              milestone.id,
            )
            const deadline = milestoneDeadline(milestone.id)
            const issuePrefix = getProjectCode(selectedProject.name)
            const allSelected = tasks.length > 0 && tasks.every((t) => selectedTaskIds.includes(t.id))

            return (
              <article key={milestone.id} className="list-card static">
                <div className="milestone-head">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => toggleMilestoneExpanded(milestone.id)}
                  >
                    {expanded ? 'Скрыть' : 'Показать'}
                  </button>
                  <h3>{milestone.name}</h3>
                  <span className="muted">
                    Дедлайн (авто): {deadline ? formatDate(deadline) : 'Нет данных'}
                  </span>
                </div>

                {milestone.id !== ungroupedMilestoneId && (
                  <div className="toolbar compact">
                    <label className="inline-control">
                      План дедлайна вехи
                      <input
                        type="date"
                        value={milestonePlan[milestone.id]?.target ?? (deadline ?? '')}
                        onChange={(event) =>
                          setMilestonePlan((prev) => ({
                            ...prev,
                            [milestone.id]: {
                              target: event.target.value,
                              mode: prev[milestone.id]?.mode ?? 'shift',
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="inline-control">
                      Стратегия
                      <select
                        value={milestonePlan[milestone.id]?.mode ?? 'shift'}
                        onChange={(event) =>
                          setMilestonePlan((prev) => ({
                            ...prev,
                            [milestone.id]: {
                              target: prev[milestone.id]?.target ?? (deadline ?? ''),
                              mode: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="shift">Сдвинуть все задачи</option>
                        <option value="highlight">Только подсветить нарушения</option>
                      </select>
                    </label>
                    <button type="button" onClick={() => applyMilestoneDeadlinePlan(milestone.id)}>
                      Применить
                    </button>
                  </div>
                )}

                {expanded && (
                  <table className="issues-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => {
                              if (allSelected) {
                                const ids = new Set(tasks.map((t) => t.id))
                                setSelectedTaskIds((prev) => prev.filter((id) => !ids.has(id)))
                                return
                              }
                              setSelectedTaskIds((prev) => [...new Set([...prev, ...tasks.map((t) => t.id)])])
                            }}
                          />
                        </th>
                        <th>Ключ</th>
                        <th>Задача</th>
                        <th>Статус</th>
                        <th>Исполнитель</th>
                        <th>Старт</th>
                        <th>Дедлайн</th>
                        <th>Веха</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task, index) => {
                        const label = getDeadlineLabel(task.deadline)
                        const isViolation = violatingTaskIds.includes(task.id)
                        return (
                          <tr
                            key={task.id}
                            className={
                              `${label === 'overdue' ? 'row-overdue' : ''} ${isViolation ? 'row-violation' : ''}`
                            }
                          >
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedTaskIds.includes(task.id)}
                                onChange={() => toggleTaskSelection(task.id)}
                              />
                            </td>
                            <td>
                              <span className="issue-key">{`${issuePrefix}-${index + 1}`}</span>
                            </td>
                            <td>
                              <strong>{task.title}</strong>
                            </td>
                            <td>
                              <div className="status-cell">
                                <span className={`status-lozenge ${getStatusClass(task.status)}`}>
                                  {task.status}
                                </span>
                                <select
                                  value={task.status}
                                  onChange={(event) => updateTask(task.id, { status: event.target.value })}
                                >
                                  {statusOptions.map((status) => (
                                    <option key={status} value={status}>
                                      {status}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </td>
                            <td>
                              <div className="assignee-cell">
                                <span className="avatar">{getInitials(task.assignee)}</span>
                                <input
                                  value={task.assignee}
                                  placeholder="Не назначен"
                                  onChange={(event) => updateTask(task.id, { assignee: event.target.value })}
                                />
                              </div>
                            </td>
                            <td>
                              <input
                                type="date"
                                value={task.startDate}
                                onChange={(event) => updateTask(task.id, { startDate: event.target.value })}
                              />
                            </td>
                            <td>
                              <div className="due-cell">
                                <input
                                  type="date"
                                  value={task.deadline}
                                  onChange={(event) => updateTask(task.id, { deadline: event.target.value })}
                                />
                                  <span className={`tag ${label}`}>
                                    {getDeadlineLabelText(label)}
                                  </span>
                              </div>
                            </td>
                            <td>
                              <select
                                value={task.milestoneId ?? ungroupedMilestoneId}
                                onChange={(event) =>
                                  updateTask(task.id, {
                                    milestoneId:
                                      event.target.value === ungroupedMilestoneId
                                        ? null
                                        : event.target.value,
                                  })
                                }
                              >
                                <option value={ungroupedMilestoneId}>Без вехи</option>
                                {selectedProject.milestones.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </article>
            )
          })}
        </div>
      </section>

      <section className="panel">
        <h2>Таймлайн (MVP псевдо-гант)</h2>
        <div className="timeline-scale">
          <span>{timelineRange.start}</span>
          <span>{timelineRange.end}</span>
        </div>
        <div className="timeline-list">
          {sortedTasks.map((task) => {
            const left = (Math.max(0, diffDays(task.startDate, timelineRange.start)) / timelineRange.days) * 100
            const durationDays = Math.max(1, diffDays(task.deadline, task.startDate) + 1)
            const width = (durationDays / timelineRange.days) * 100
            return (
              <div key={task.id} className="timeline-row">
                <div className="timeline-meta">
                  <strong>{task.title}</strong>
                  <span className="muted">
                    {task.startDate} {'->'} {task.deadline}
                  </span>
                </div>
                <div className="timeline-track">
                  <div className="timeline-bar" style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }} />
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
    </main>
  )
}

export default App
