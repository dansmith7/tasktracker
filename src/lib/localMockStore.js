import { DEV_LOCAL_USER_ID } from './localDev.js'

const STORAGE_KEY = 'tasktracker-local-mock-v1'

export function getDefaultState() {
  return {
    profiles: [{ id: DEV_LOCAL_USER_ID, name: 'Локальная разработка', avatar_url: null }],
    topics: [],
    projects: [],
    milestones: [],
    tasks: [],
    task_dependencies: [],
    comments: [],
    attachments: [],
  }
}

function mergeWithDefaults(parsed) {
  const d = getDefaultState()
  return {
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : d.profiles,
    topics: Array.isArray(parsed.topics) ? parsed.topics : d.topics,
    projects: Array.isArray(parsed.projects) ? parsed.projects : d.projects,
    milestones: Array.isArray(parsed.milestones) ? parsed.milestones : d.milestones,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : d.tasks,
    task_dependencies: Array.isArray(parsed.task_dependencies) ? parsed.task_dependencies : d.task_dependencies,
    comments: Array.isArray(parsed.comments) ? parsed.comments : d.comments,
    attachments: Array.isArray(parsed.attachments) ? parsed.attachments : d.attachments,
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ensureSeed(getDefaultState())
    const parsed = JSON.parse(raw)
    return ensureSeed(mergeWithDefaults(parsed))
  } catch {
    return ensureSeed(getDefaultState())
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function ensureSeed(state) {
  if (state.projects.length > 0) return state
  const pid = crypto.randomUUID()
  const mid = crypto.randomUUID()
  const tid = crypto.randomUUID()
  const today = new Date().toISOString().slice(0, 10)
  const next = {
    ...state,
    projects: [
      {
        id: pid,
        title: 'Демо-проект',
        topic_id: null,
        created_at: new Date().toISOString(),
        created_by: DEV_LOCAL_USER_ID,
      },
    ],
    milestones: [
      {
        id: mid,
        project_id: pid,
        title: 'Общая веха',
        position: 1,
        deadline: null,
        created_by: DEV_LOCAL_USER_ID,
      },
    ],
    tasks: [
      {
        id: tid,
        project_id: pid,
        milestone_id: mid,
        title: 'Пример задачи',
        description: '',
        status: 'В работе',
        priority: 'medium',
        assignee_id: DEV_LOCAL_USER_ID,
        assignee_name: null,
        start_date: today,
        due_date: today,
        is_completed: false,
        created_by: DEV_LOCAL_USER_ID,
        updated_by: DEV_LOCAL_USER_ID,
        parent_task_id: null,
      },
    ],
  }
  saveState(next)
  return next
}

export function resetLocalMockStore() {
  localStorage.removeItem(STORAGE_KEY)
}

/** Имя профиля dev-пользователя в моке (после «входа» с любым email). */
export function setDevProfileDisplayName(name) {
  const trimmed = (name || '').trim()
  if (!trimmed) return
  const state = loadState()
  const p = state.profiles.find((x) => x.id === DEV_LOCAL_USER_ID)
  if (p) {
    p.name = trimmed
    saveState(state)
  }
}
