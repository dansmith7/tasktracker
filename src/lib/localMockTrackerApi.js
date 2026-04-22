/**
 * Реализация trackerApi поверх localMockStore (без Supabase).
 * @see trackerApi.js — сигнатуры совпадают, первый аргумент client не используется.
 */
import { DEV_LOCAL_USER_ID } from './localDev.js'
import { loadState, saveState } from './localMockStore.js'

function normalizePriority(p) {
  if (p === 'high' || p === 'medium' || p === 'low') return p
  return 'medium'
}

function taskRowFromApp(task, projectId, userId) {
  return {
    id: task.id,
    project_id: projectId,
    parent_task_id: task.parentTaskId ?? null,
    milestone_id: task.milestoneId && task.milestoneId !== 'none' ? task.milestoneId : null,
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: normalizePriority(task.priority),
    assignee_id: task.assigneeId || null,
    assignee_name: null,
    start_date: task.startDate,
    due_date: task.deadline,
    is_completed: task.status === 'Готово',
    created_by: task.createdBy || userId,
    updated_by: userId,
  }
}

function taskPersistableFieldsDiffer(a, b) {
  return (
    a.title !== b.title ||
    (a.description ?? '') !== (b.description ?? '') ||
    a.status !== b.status ||
    (a.assigneeId ?? null) !== (b.assigneeId ?? null) ||
    (a.assignee || '').trim() !== (b.assignee || '').trim() ||
    a.startDate !== b.startDate ||
    a.deadline !== b.deadline ||
    a.priority !== b.priority ||
    (a.milestoneId ?? null) !== (b.milestoneId ?? null) ||
    (a.parentTaskId ?? null) !== (b.parentTaskId ?? null)
  )
}

export async function persistProjectTasksDelta(_client, projectId, userId, oldTasks, newTasks) {
  let state = loadState()
  const oldMap = new Map(oldTasks.map((t) => [t.id, t]))
  for (const t of newTasks) {
    const o = oldMap.get(t.id)
    if (!o) {
      const row = taskRowFromApp(t, projectId, userId)
      state.tasks.push({ ...row, parent_task_id: row.parent_task_id ?? null })
      saveState(state)
      if (t.dependsOnTaskId) {
        await setTaskDependencyRemote(_client, t.id, t.dependsOnTaskId)
      }
    } else {
      if (taskPersistableFieldsDiffer(o, t)) {
        const row = taskRowFromApp(t, projectId, userId)
        const i = state.tasks.findIndex((x) => x.id === row.id)
        if (i >= 0) {
          state.tasks[i] = {
            ...state.tasks[i],
            ...row,
            parent_task_id: row.parent_task_id,
            updated_at: new Date().toISOString(),
          }
          saveState(state)
        }
      }
      if ((o.dependsOnTaskId ?? null) !== (t.dependsOnTaskId ?? null)) {
        await setTaskDependencyRemote(_client, t.id, t.dependsOnTaskId ?? null)
      }
    }
  }
  const parentIds = new Set()
  for (const t of newTasks) {
    if (t.parentTaskId) parentIds.add(t.parentTaskId)
  }
  for (const pid of parentIds) {
    await syncParentDeadlineFromChildren(_client, pid, userId)
  }
}

export async function syncParentDeadlineFromChildren(_client, parentTaskId, userId) {
  void _client
  if (!parentTaskId) return
  const state = loadState()
  const parent = state.tasks.find((t) => t.id === parentTaskId)
  if (!parent) return
  const children = state.tasks.filter((t) => t.parent_task_id === parentTaskId)
  if (!children.length) return
  const maxDue = children.reduce((m, c) => (String(c.due_date) > String(m) ? c.due_date : m), children[0].due_date)
  if (String(maxDue) > String(parent.due_date)) {
    parent.due_date = maxDue
    parent.updated_by = userId
    parent.updated_at = new Date().toISOString()
    saveState(state)
  }
}

export async function setTaskDependencyRemote(_client, successorTaskId, predecessorTaskId) {
  const state = loadState()
  state.task_dependencies = state.task_dependencies.filter((d) => d.successor_task_id !== successorTaskId)
  if (predecessorTaskId) {
    state.task_dependencies.push({
      predecessor_task_id: predecessorTaskId,
      successor_task_id: successorTaskId,
      dependency_type: 'finish_start',
    })
  }
  saveState(state)
}

export async function updateTaskMilestoneRemote(_client, taskId, userId, milestoneId) {
  const state = loadState()
  const i = state.tasks.findIndex((t) => t.id === taskId)
  if (i >= 0) {
    state.tasks[i] = {
      ...state.tasks[i],
      milestone_id: milestoneId && milestoneId !== 'none' ? milestoneId : null,
      updated_by: userId,
    }
    saveState(state)
  }
}

export async function updateProjectTitleRemote(_client, projectId, title) {
  const state = loadState()
  const p = state.projects.find((x) => x.id === projectId)
  if (p) {
    p.title = title
    p.updated_at = new Date().toISOString()
    saveState(state)
  }
}

export async function updateMilestoneTitleRemote(_client, milestoneId, title) {
  const state = loadState()
  const m = state.milestones.find((x) => x.id === milestoneId)
  if (m) {
    m.title = title
    m.updated_at = new Date().toISOString()
    saveState(state)
  }
}

export async function updateMilestoneDeadlineRemote(_client, milestoneId, deadlineDate) {
  const state = loadState()
  const m = state.milestones.find((x) => x.id === milestoneId)
  if (m) {
    m.deadline = deadlineDate
    m.updated_at = new Date().toISOString()
    saveState(state)
  }
}

export async function deleteMilestoneRemote(_client, milestoneId) {
  const state = loadState()
  state.milestones = state.milestones.filter((m) => m.id !== milestoneId)
  for (const t of state.tasks) {
    if (t.milestone_id === milestoneId) t.milestone_id = null
  }
  saveState(state)
}

export async function deleteTaskRemote(_client, taskId, userId) {
  void userId
  const state = loadState()
  const victim = state.tasks.find((t) => t.id === taskId)
  const parentId = victim?.parent_task_id ?? null
  const childIds = state.tasks.filter((t) => t.parent_task_id === taskId).map((t) => t.id)
  const remove = new Set([taskId, ...childIds])
  state.tasks = state.tasks.filter((t) => !remove.has(t.id))
  state.task_dependencies = state.task_dependencies.filter(
    (d) => !remove.has(d.successor_task_id) && !remove.has(d.predecessor_task_id),
  )
  state.comments = state.comments.filter((c) => !remove.has(c.task_id))
  state.attachments = state.attachments.filter((a) => !remove.has(a.task_id))
  saveState(state)
  if (parentId) await syncParentDeadlineFromChildren(_client, parentId, userId)
}

export async function updateTasksStatusBulkRemote(_client, userId, taskIds, status) {
  if (!taskIds.length) return
  const state = loadState()
  const set = new Set(taskIds)
  for (const t of state.tasks) {
    if (set.has(t.id)) {
      t.status = status
      t.is_completed = status === 'Готово'
      t.updated_by = userId
    }
  }
  saveState(state)
}

export async function deleteTasksBulkRemote(_client, taskIds, userId) {
  if (!taskIds.length) return
  const state = loadState()
  const parentIds = new Set()
  const remove = new Set(taskIds)
  for (const id of taskIds) {
    const v = state.tasks.find((t) => t.id === id)
    if (v?.parent_task_id) parentIds.add(v.parent_task_id)
    state.tasks.filter((t) => t.parent_task_id === id).forEach((c) => remove.add(c.id))
  }
  state.tasks = state.tasks.filter((t) => !remove.has(t.id))
  state.task_dependencies = state.task_dependencies.filter(
    (d) => !remove.has(d.successor_task_id) && !remove.has(d.predecessor_task_id),
  )
  state.comments = state.comments.filter((c) => !remove.has(c.task_id))
  state.attachments = state.attachments.filter((a) => !remove.has(a.task_id))
  saveState(state)
  for (const pid of parentIds) {
    await syncParentDeadlineFromChildren(_client, pid, userId)
  }
}

export async function insertCommentRemote(_client, { id, taskId, authorId, body, createdAt }) {
  const state = loadState()
  state.comments.push({
    id,
    task_id: taskId,
    author_id: authorId,
    body,
    created_at: createdAt ?? new Date().toISOString(),
  })
  saveState(state)
}

export async function deleteCommentRemote(_client, commentId) {
  const state = loadState()
  state.comments = state.comments.filter((c) => c.id !== commentId)
  saveState(state)
}

export async function fetchProfiles(client) {
  void client
  const state = loadState()
  return state.profiles.map((p) => ({ id: p.id, name: p.name, avatar_url: p.avatar_url }))
}

export async function updateProfileNameRemote(_client, userId, name) {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Имя не может быть пустым')
  const state = loadState()
  const p = state.profiles.find((x) => x.id === userId)
  if (p) {
    p.name = trimmed
    saveState(state)
  }
}

function buildTree(state) {
  const topics = (state.topics ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((t) => ({
      id: t.id,
      name: t.title,
      position: t.position,
    }))

  const projects = state.projects
  if (!projects.length) return { topics, projects: [] }

  const profileById = Object.fromEntries(state.profiles.map((p) => [p.id, p]))
  const projectIds = projects.map((p) => p.id)
  const milestones = state.milestones.filter((m) => projectIds.includes(m.project_id))
  const tasks = state.tasks.filter((t) => projectIds.includes(t.project_id))

  const taskIds = tasks.map((t) => t.id)
  const deps = state.task_dependencies.filter((d) => taskIds.includes(d.successor_task_id))
  const depBySucc = Object.fromEntries(deps.map((d) => [d.successor_task_id, d.predecessor_task_id]))

  const commentsByTask = {}
  for (const c of state.comments) {
    if (!taskIds.includes(c.task_id)) continue
    if (!commentsByTask[c.task_id]) commentsByTask[c.task_id] = []
    const author = profileById[c.author_id]
    commentsByTask[c.task_id].push({
      id: c.id,
      author: author?.name ?? '—',
      authorId: c.author_id,
      time: new Date(c.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      text: c.body,
    })
  }

  const attByTask = {}
  for (const a of state.attachments) {
    if (!taskIds.includes(a.task_id)) continue
    if (!attByTask[a.task_id]) attByTask[a.task_id] = []
    attByTask[a.task_id].push({
      id: a.id,
      taskId: a.task_id,
      fileName: a.file_name,
      size: Number(a.size) || 0,
      mimeType: a.mime_type || 'application/octet-stream',
      fileUrl: a.file_url || '',
      storagePath: a.file_path || undefined,
      uploadedBy: a.uploaded_by,
    })
  }

  const milestoneRowsByProject = {}
  for (const m of milestones) {
    if (!milestoneRowsByProject[m.project_id]) milestoneRowsByProject[m.project_id] = []
    milestoneRowsByProject[m.project_id].push({
      id: m.id,
      name: m.title,
      deadline: m.deadline ?? null,
    })
  }

  const tasksByProject = {}
  for (const row of tasks) {
    if (!tasksByProject[row.project_id]) tasksByProject[row.project_id] = []
    const assignee = row.assignee_id ? profileById[row.assignee_id] : null
    const assigneeDisplay = assignee?.name ?? row.assignee_name ?? ''
    tasksByProject[row.project_id].push({
      id: row.id,
      title: row.title,
      description: row.description ?? '',
      status: row.status,
      assignee: assigneeDisplay,
      assigneeId: row.assignee_id,
      startDate: row.start_date,
      deadline: row.due_date,
      priority: normalizePriority(row.priority),
      milestoneId: row.milestone_id,
      dependsOnTaskId: depBySucc[row.id] ?? null,
      comment: '',
      attachments: attByTask[row.id] ?? [],
      comments: commentsByTask[row.id] ?? [],
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      parentTaskId: row.parent_task_id ?? null,
    })
  }

  const projectTrees = projects.map((p) => ({
    id: p.id,
    name: p.title,
    topicId: p.topic_id ?? null,
    milestones: milestoneRowsByProject[p.id] ?? [],
    tasks: tasksByProject[p.id] ?? [],
  }))
  return { topics, projects: projectTrees }
}

export async function fetchProjectsTree(client) {
  void client
  const state = loadState()
  return buildTree(state)
}

export async function createProjectRemote(_client, title, userId, topicId = null) {
  const state = loadState()
  const id = crypto.randomUUID()
  state.projects.push({
    id,
    title,
    topic_id: topicId || null,
    created_at: new Date().toISOString(),
    created_by: userId,
  })
  saveState(state)
  return id
}

export async function updateProjectTopicRemote(_client, projectId, topicId) {
  const state = loadState()
  const p = state.projects.find((x) => x.id === projectId)
  if (p) {
    p.topic_id = topicId
    saveState(state)
  }
}

export async function deleteProjectRemote(_client, projectId) {
  const state = loadState()
  const p = state.projects.find((x) => x.id === projectId)
  if (!p) return
  const taskIds = new Set(state.tasks.filter((t) => t.project_id === projectId).map((t) => t.id))
  state.projects = state.projects.filter((x) => x.id !== projectId)
  state.milestones = state.milestones.filter((m) => m.project_id !== projectId)
  state.tasks = state.tasks.filter((t) => t.project_id !== projectId)
  state.task_dependencies = state.task_dependencies.filter(
    (d) => !taskIds.has(d.successor_task_id) && !taskIds.has(d.predecessor_task_id),
  )
  state.comments = state.comments.filter((c) => !taskIds.has(c.task_id))
  state.attachments = state.attachments.filter((a) => !taskIds.has(a.task_id))
  saveState(state)
}

export async function createTopicRemote(_client, title, _userId) {
  void _userId
  const state = loadState()
  const position = (state.topics?.length ?? 0) + 1
  const id = crypto.randomUUID()
  if (!state.topics) state.topics = []
  state.topics.push({
    id,
    title: title.trim(),
    position,
    created_at: new Date().toISOString(),
  })
  saveState(state)
  return id
}

export async function updateTopicTitleRemote(_client, topicId, title) {
  const state = loadState()
  const t = state.topics?.find((x) => x.id === topicId)
  if (t) {
    t.title = title.trim()
    saveState(state)
  }
}

export async function deleteTopicRemote(_client, topicId) {
  const state = loadState()
  if (!state.topics) state.topics = []
  state.topics = state.topics.filter((t) => t.id !== topicId)
  for (const p of state.projects) {
    if (p.topic_id === topicId) p.topic_id = null
  }
  saveState(state)
}

export async function createMilestoneRemote(_client, projectId, name, userId) {
  const state = loadState()
  const count = state.milestones.filter((m) => m.project_id === projectId).length
  const id = crypto.randomUUID()
  state.milestones.push({
    id,
    project_id: projectId,
    title: name,
    position: count + 1,
    created_by: userId,
  })
  saveState(state)
  return id
}

export async function uploadTaskAttachment(_client, taskId, projectId, file, userId) {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
  const attId = crypto.randomUUID()
  const fileUrl = URL.createObjectURL(file)
  const path = `${projectId}/${taskId}/${attId}${ext}`
  const state = loadState()
  state.attachments.push({
    id: attId,
    task_id: taskId,
    file_name: file.name,
    file_path: path,
    file_url: fileUrl,
    mime_type: file.type || 'application/octet-stream',
    size: file.size,
    uploaded_by: userId,
    created_at: new Date().toISOString(),
  })
  saveState(state)
  return {
    id: attId,
    fileUrl,
    storagePath: path,
    fileName: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    uploadedBy: userId,
  }
}

export async function deleteTaskAttachmentRemote(_client, attachment) {
  if (attachment.fileUrl?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(attachment.fileUrl)
    } catch {
      /* ignore */
    }
  }
  const state = loadState()
  state.attachments = state.attachments.filter((a) => a.id !== attachment.id)
  saveState(state)
}
