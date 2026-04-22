import { isOfflineDevMode } from './localDev.js'
import * as localMock from './localMockTrackerApi.js'

const ungrouped = 'none'

/** Сообщение об ошибке PostgREST / Supabase для UI */
export function formatSupabaseError(err) {
  if (!err) return 'Неизвестная ошибка'
  const parts = [err.message, err.details, err.hint].filter(Boolean)
  if (parts.length) return parts.join(' — ')
  return String(err)
}

function normalizePriority(p) {
  if (p === 'high' || p === 'medium' || p === 'low') return p
  return 'medium'
}

/** Логирование ответов Supabase в dev (по требованию отладки persistence). */
function logResult(op, result) {
  if (!import.meta.env.DEV) return
  const { data, error } = result ?? {}
  console.log(`[trackerApi] ${op}`, { data, error })
  if (error) console.error(`[trackerApi] ${op} failed`, error)
}

export function taskPersistableFieldsDiffer(a, b) {
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

function isMissingRelationError(error, relationName) {
  if (!error) return false
  const code = String(error.code || '').toUpperCase()
  const msg = String(error.message || '').toLowerCase()
  const rel = String(relationName || '').toLowerCase()
  if (code === '42P01') return true
  if (code === 'PGRST205') return true
  if (msg.includes('does not exist') && (!rel || msg.includes(rel))) return true
  if (msg.includes('could not find') && msg.includes('relation')) return true
  return false
}

function isMissingColumnError(error, columnName) {
  if (!error) return false
  const code = String(error.code || '').toUpperCase()
  const msg = String(error.message || '').toLowerCase()
  const col = String(columnName || '').toLowerCase()
  if (code === '42703') return true
  if (code === 'PGRST204') return true
  if (msg.includes('does not exist') && msg.includes('column') && (!col || msg.includes(col))) return true
  if (msg.includes('could not find') && msg.includes('column') && (!col || msg.includes(col))) return true
  return false
}

function isMissingFunctionError(error, functionName) {
  if (!error) return false
  const code = String(error.code || '').toUpperCase()
  const msg = String(error.message || '').toLowerCase()
  const fn = String(functionName || '').toLowerCase()
  if (code === 'PGRST202') return true
  if (msg.includes('could not find the function')) return true
  if (fn && msg.includes(fn) && msg.includes('no matches were found')) return true
  return false
}

function removeTaskOptionalFieldsForLegacySchema(row, missingColumn) {
  const next = { ...row }
  if (missingColumn === 'parent_task_id') delete next.parent_task_id
  return next
}

function isSubtaskRow(row) {
  return Boolean(row?.parent_task_id)
}

let hasParentTaskIdColumn = null

/**
 * Проверяет наличие колонки подзадач в подключенной БД и кэширует результат.
 * Это нужно для совместимости со старыми схемами, где parent_task_id ещё не применён.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
async function supportsParentTaskColumn(client) {
  if (hasParentTaskIdColumn !== null) return hasParentTaskIdColumn
  const probe = await client.from('tasks').select('parent_task_id').limit(1)
  if (probe.error && isMissingColumnError(probe.error, 'parent_task_id')) {
    hasParentTaskIdColumn = false
    return false
  }
  if (probe.error) throw probe.error
  hasParentTaskIdColumn = true
  return true
}

/**
 * Сохраняет дельту списка задач: insert новых, upsert изменённых, синхронизирует зависимости.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
export async function persistProjectTasksDelta(client, projectId, userId, oldTasks, newTasks) {
  if (isOfflineDevMode()) return localMock.persistProjectTasksDelta(client, projectId, userId, oldTasks, newTasks)
  const oldMap = new Map(oldTasks.map((t) => [t.id, t]))
  for (const t of newTasks) {
    const o = oldMap.get(t.id)
    if (!o) {
      const row = taskRowFromApp(t, projectId, userId)
      let r = await client.from('tasks').insert(row).select()
      if (r.error && isMissingColumnError(r.error, 'parent_task_id')) {
        // Для подзадач нельзя молча "понижать" запись до обычной задачи.
        if (!isSubtaskRow(row)) {
          const legacyRow = removeTaskOptionalFieldsForLegacySchema(row, 'parent_task_id')
          r = await client.from('tasks').insert(legacyRow).select()
        }
      }
      logResult('insertTask', r)
      if (r.error) throw r.error
      if (t.dependsOnTaskId) {
        await setTaskDependencyRemote(client, t.id, t.dependsOnTaskId)
      }
    } else {
      if (taskPersistableFieldsDiffer(o, t)) {
        const row = taskRowFromApp(t, projectId, userId)
        let r = await client.from('tasks').upsert(row, { onConflict: 'id' }).select()
        if (r.error && isMissingColumnError(r.error, 'parent_task_id')) {
          // Для подзадач нельзя молча "понижать" запись до обычной задачи.
          if (!isSubtaskRow(row)) {
            const legacyRow = removeTaskOptionalFieldsForLegacySchema(row, 'parent_task_id')
            r = await client.from('tasks').upsert(legacyRow, { onConflict: 'id' }).select()
          }
        }
        logResult('upsertTask', r)
        if (r.error) throw r.error
      }
      if ((o.dependsOnTaskId ?? null) !== (t.dependsOnTaskId ?? null)) {
        await setTaskDependencyRemote(client, t.id, t.dependsOnTaskId ?? null)
      }
    }
  }
  const parentIds = new Set()
  for (const t of newTasks) {
    if (t.parentTaskId) parentIds.add(t.parentTaskId)
  }
  for (const pid of parentIds) {
    await syncParentDeadlineFromChildren(client, pid, userId)
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function setTaskDependencyRemote(client, successorTaskId, predecessorTaskId) {
  if (isOfflineDevMode()) return localMock.setTaskDependencyRemote(client, successorTaskId, predecessorTaskId)
  const r = await client.rpc('replace_task_dependency', {
    p_successor_task_id: successorTaskId,
    p_predecessor_task_id: predecessorTaskId ?? null,
  })
  logResult('replaceTaskDependency', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateTaskMilestoneRemote(client, taskId, userId, milestoneId) {
  if (isOfflineDevMode()) return localMock.updateTaskMilestoneRemote(client, taskId, userId, milestoneId)
  const r = await client
    .from('tasks')
    .update({
      milestone_id: milestoneId,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
  logResult('updateTaskMilestone', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateProjectTitleRemote(client, projectId, title) {
  if (isOfflineDevMode()) return localMock.updateProjectTitleRemote(client, projectId, title)
  const r = await client
    .from('projects')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  logResult('updateProjectTitle', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string | null} topicId */
export async function updateProjectTopicRemote(client, projectId, topicId) {
  if (isOfflineDevMode()) return localMock.updateProjectTopicRemote(client, projectId, topicId)
  const r = await client.from('projects').update({ topic_id: topicId }).eq('id', projectId)
  logResult('updateProjectTopic', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteProjectRemote(client, projectId) {
  if (isOfflineDevMode()) return localMock.deleteProjectRemote(client, projectId)
  let r = await client.rpc('delete_project_by_id', { p_project_id: projectId })
  if (r.error && isMissingFunctionError(r.error, 'delete_project_by_id')) {
    // Совместимость со схемой без RPC: используем прямой DELETE.
    r = await client.from('projects').delete().eq('id', projectId)
  }
  logResult('deleteProject', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function createTopicRemote(client, title, userId) {
  if (isOfflineDevMode()) return localMock.createTopicRemote(client, title, userId)
  const { count } = await client.from('topics').select('*', { count: 'exact', head: true })
  const position = (count ?? 0) + 1
  const { data, error } = await client
    .from('topics')
    .insert({ title, position })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateTopicTitleRemote(client, topicId, title) {
  if (isOfflineDevMode()) return localMock.updateTopicTitleRemote(client, topicId, title)
  const r = await client.from('topics').update({ title }).eq('id', topicId)
  logResult('updateTopicTitle', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteTopicRemote(client, topicId) {
  if (isOfflineDevMode()) return localMock.deleteTopicRemote(client, topicId)
  const r = await client.rpc('delete_topic_by_id', { p_topic_id: topicId })
  logResult('deleteTopic', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateMilestoneTitleRemote(client, milestoneId, title) {
  if (isOfflineDevMode()) return localMock.updateMilestoneTitleRemote(client, milestoneId, title)
  const r = await client
    .from('milestones')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', milestoneId)
  logResult('updateMilestoneTitle', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string | null} deadlineDate ISO date `YYYY-MM-DD` или null */
export async function updateMilestoneDeadlineRemote(client, milestoneId, deadlineDate) {
  if (isOfflineDevMode()) return localMock.updateMilestoneDeadlineRemote(client, milestoneId, deadlineDate)
  const r = await client
    .from('milestones')
    .update({ deadline: deadlineDate, updated_at: new Date().toISOString() })
    .eq('id', milestoneId)
  logResult('updateMilestoneDeadline', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteMilestoneRemote(client, milestoneId) {
  if (isOfflineDevMode()) return localMock.deleteMilestoneRemote(client, milestoneId)
  const r = await client.rpc('delete_milestone_by_id', { p_milestone_id: milestoneId })
  logResult('deleteMilestone', r)
  if (r.error) throw r.error
}

/**
 * Продлевает дедлайн родителя, если максимальный дедлайн детей больше (подзадачи один уровень).
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
export async function syncParentDeadlineFromChildren(client, parentTaskId, userId) {
  if (!parentTaskId) return
  if (isOfflineDevMode()) return localMock.syncParentDeadlineFromChildren(client, parentTaskId, userId)
  if (!(await supportsParentTaskColumn(client))) return
  const { data: parent, error: e1 } = await client.from('tasks').select('id, due_date').eq('id', parentTaskId).maybeSingle()
  if (e1 || !parent) return
  const { data: children, error: e2 } = await client.from('tasks').select('due_date').eq('parent_task_id', parentTaskId)
  if (e2) throw e2
  if (!children?.length) return
  const maxDue = children.reduce((m, c) => (String(c.due_date) > String(m) ? c.due_date : m), children[0].due_date)
  if (String(maxDue) > String(parent.due_date)) {
    const r = await client
      .from('tasks')
      .update({
        due_date: maxDue,
        updated_by: userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', parentTaskId)
    logResult('syncParentDeadline', r)
    if (r.error) throw r.error
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteTaskRemote(client, taskId, userId) {
  if (isOfflineDevMode()) return localMock.deleteTaskRemote(client, taskId, userId)
  let parentId = null
  if (await supportsParentTaskColumn(client)) {
    const { data: row, error } = await client.from('tasks').select('parent_task_id').eq('id', taskId).maybeSingle()
    if (error && !isMissingColumnError(error, 'parent_task_id')) throw error
    if (error && isMissingColumnError(error, 'parent_task_id')) hasParentTaskIdColumn = false
    parentId = row?.parent_task_id ?? null
  }
  const r = await client.from('tasks').delete().eq('id', taskId)
  logResult('deleteTask', r)
  if (r.error) throw r.error
  if (parentId) await syncParentDeadlineFromChildren(client, parentId, userId)
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateTasksStatusBulkRemote(client, userId, taskIds, status) {
  if (!taskIds.length) return
  if (isOfflineDevMode()) return localMock.updateTasksStatusBulkRemote(client, userId, taskIds, status)
  const r = await client
    .from('tasks')
    .update({
      status,
      is_completed: status === 'Готово',
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .in('id', taskIds)
  logResult('updateTasksStatusBulk', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteTasksBulkRemote(client, taskIds, userId) {
  if (!taskIds.length) return
  if (isOfflineDevMode()) return localMock.deleteTasksBulkRemote(client, taskIds, userId)
  const parentIds = new Set()
  if (await supportsParentTaskColumn(client)) {
    const { data: rows, error } = await client.from('tasks').select('parent_task_id').in('id', taskIds)
    if (error && !isMissingColumnError(error, 'parent_task_id')) throw error
    if (error && isMissingColumnError(error, 'parent_task_id')) hasParentTaskIdColumn = false
    for (const row of rows ?? []) {
      if (row.parent_task_id) parentIds.add(row.parent_task_id)
    }
  }
  const r = await client.from('tasks').delete().in('id', taskIds)
  logResult('deleteTasksBulk', r)
  if (r.error) throw r.error
  for (const pid of parentIds) {
    await syncParentDeadlineFromChildren(client, pid, userId)
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function insertCommentRemote(client, { id, taskId, authorId, body, createdAt }) {
  if (isOfflineDevMode()) return localMock.insertCommentRemote(client, { id, taskId, authorId, body, createdAt })
  const r = await client.from('comments').insert({
    id,
    task_id: taskId,
    author_id: authorId,
    body,
    created_at: createdAt ?? new Date().toISOString(),
  })
  logResult('insertComment', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteCommentRemote(client, commentId) {
  if (isOfflineDevMode()) return localMock.deleteCommentRemote(client, commentId)
  const r = await client.rpc('delete_comment_by_id', { p_comment_id: commentId })
  logResult('deleteComment', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function fetchProfiles(client) {
  if (isOfflineDevMode()) return localMock.fetchProfiles(client)
  const { data, error } = await client.from('profiles').select('id, name, avatar_url').order('name')
  if (error) throw error
  return data ?? []
}

/**
 * Отображаемое имя пользователя (`public.profiles.name`).
 * По умолчанию при регистрации подставляется часть email; здесь пользователь задаёт своё имя (видно всем в трекере).
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
export async function updateProfileNameRemote(client, userId, name) {
  if (isOfflineDevMode()) return localMock.updateProfileNameRemote(client, userId, name)
  const trimmed = (name || '').trim()
  if (!trimmed) {
    const err = new Error('Имя не может быть пустым')
    throw err
  }
  const r = await client.from('profiles').update({ name: trimmed }).eq('id', userId)
  logResult('updateProfileName', r)
  if (r.error) throw r.error
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @returns {Promise<{ topics: { id: string, name: string, position: number }[], projects: { id: string, name: string, topicId: string | null, milestones: { id: string, name: string, deadline: string | null }[], tasks: object[] }[] }>}
 */
export async function fetchProjectsTree(client) {
  if (isOfflineDevMode()) return localMock.fetchProjectsTree(client)
  const {
    data: { user },
    error: userErr,
  } = await client.auth.getUser()
  if (userErr) throw userErr
  if (!user) return { topics: [], projects: [] }

  // Обратная совместимость: если topics/topic_id ещё не применены в подключенной БД,
  // всё равно загружаем проекты и задачи (проекты будут считаться "Без темы").
  let topics = []
  {
    const { data: topicRows, error: et } = await client
      .from('topics')
      .select('id, title, position')
      .order('position')
    if (et && !isMissingRelationError(et, 'public.topics')) throw et
    if (!et) {
      topics = (topicRows ?? []).map((t) => ({
        id: t.id,
        name: t.title,
        position: t.position,
      }))
    }
  }

  let projects = []
  {
    const withTopic = await client
      .from('projects')
      .select('id, title, created_at, topic_id')
      .order('created_at')
    if (!withTopic.error) {
      projects = withTopic.data ?? []
    } else if (isMissingColumnError(withTopic.error, 'topic_id')) {
      const legacy = await client
        .from('projects')
        .select('id, title, created_at')
        .order('created_at')
      if (legacy.error) throw legacy.error
      projects = (legacy.data ?? []).map((p) => ({ ...p, topic_id: null }))
    } else {
      throw withTopic.error
    }
  }
  if (!projects?.length) return { topics, projects: [] }
  const projectIds = projects.map((p) => p.id)

  const { data: milestones, error: e2 } = await client
    .from('milestones')
    .select('id, project_id, title, position, deadline')
    .in('project_id', projectIds)
    .order('position')
  if (e2) throw e2

  const { data: tasks, error: e3 } = await client.from('tasks').select('*').in('project_id', projectIds)
  if (e3) throw e3

  const taskIds = (tasks ?? []).map((t) => t.id)
  let deps = []
  let comments = []
  let attachments = []
  if (taskIds.length) {
    const r1 = await client.from('task_dependencies').select('*').in('successor_task_id', taskIds)
    if (r1.error) throw r1.error
    deps = r1.data ?? []
    const r2 = await client.from('comments').select('*').in('task_id', taskIds).order('created_at')
    if (r2.error) throw r2.error
    comments = r2.data ?? []
    const r3 = await client.from('attachments').select('*').in('task_id', taskIds).order('created_at')
    if (r3.error) throw r3.error
    attachments = r3.data ?? []
  }

  const profileById = Object.fromEntries((await fetchProfiles(client)).map((p) => [p.id, p]))
  const depBySucc = Object.fromEntries(deps.map((d) => [d.successor_task_id, d.predecessor_task_id]))
  const commentsByTask = {}
  for (const c of comments) {
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
  for (const a of attachments) {
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
  for (const m of milestones ?? []) {
    if (!milestoneRowsByProject[m.project_id]) milestoneRowsByProject[m.project_id] = []
    milestoneRowsByProject[m.project_id].push({
      id: m.id,
      name: m.title,
      deadline: m.deadline ?? null,
    })
  }

  const tasksByProject = {}
  for (const row of tasks ?? []) {
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

  const projectTrees = (projects ?? []).map((p) => ({
    id: p.id,
    name: p.title,
    topicId: p.topic_id ?? null,
    milestones: milestoneRowsByProject[p.id] ?? [],
    tasks: tasksByProject[p.id] ?? [],
  }))
  return { topics, projects: projectTrees }
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
    start_date: task.startDate,
    due_date: task.deadline,
    is_completed: task.status === 'Готово',
    created_by: task.createdBy || userId,
    updated_by: userId,
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string | null} [topicId] */
export async function createProjectRemote(client, title, userId, topicId = null) {
  if (isOfflineDevMode()) return localMock.createProjectRemote(client, title, userId, topicId)
  const row = { title, created_by: userId }
  if (topicId) row.topic_id = topicId
  const { data, error } = await client.from('projects').insert(row).select('id').single()
  if (error) throw error
  return data.id
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function createMilestoneRemote(client, projectId, name, userId) {
  if (isOfflineDevMode()) return localMock.createMilestoneRemote(client, projectId, name, userId)
  const { count } = await client
    .from('milestones')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
  const position = (count ?? 0) + 1
  const { data, error } = await client
    .from('milestones')
    .insert({ project_id: projectId, title: name, position, created_by: userId })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

/** Upload file to Storage; returns public URL and path. */
export async function uploadTaskAttachment(client, taskId, projectId, file, userId) {
  if (isOfflineDevMode()) return localMock.uploadTaskAttachment(client, taskId, projectId, file, userId)
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
  const attId = crypto.randomUUID()
  const path = `${projectId}/${taskId}/${attId}${ext}`
  const { error: upErr } = await client.storage.from('task-attachments').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (upErr) throw upErr
  const { data: pub } = client.storage.from('task-attachments').getPublicUrl(path)
  const ins = await client.from('attachments').insert({
    id: attId,
    task_id: taskId,
    file_name: file.name,
    file_path: path,
    file_url: pub.publicUrl,
    mime_type: file.type || 'application/octet-stream',
    size: file.size,
    uploaded_by: userId,
  })
  logResult('insertAttachment', ins)
  if (ins.error) throw ins.error
  return {
    id: attId,
    fileUrl: pub.publicUrl,
    storagePath: path,
    fileName: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    uploadedBy: userId,
  }
}

/** Remove attachment row and storage object. */
export async function deleteTaskAttachmentRemote(client, attachment) {
  if (isOfflineDevMode()) return localMock.deleteTaskAttachmentRemote(client, attachment)
  if (attachment.storagePath) {
    await client.storage.from('task-attachments').remove([attachment.storagePath])
  } else if (attachment.fileUrl?.includes('/task-attachments/')) {
    const i = attachment.fileUrl.indexOf('/task-attachments/')
    const rest = attachment.fileUrl.slice(i + '/task-attachments/'.length)
    const path = rest.split('?')[0]
    if (path) await client.storage.from('task-attachments').remove([path])
  }
  const del = await client.rpc('delete_attachment_by_id', { p_attachment_id: attachment.id })
  logResult('deleteAttachment', del)
  if (del.error) throw del.error
}

export { ungrouped as ungroupedMilestoneId }
