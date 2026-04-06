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
    (a.milestoneId ?? null) !== (b.milestoneId ?? null)
  )
}

/**
 * Сохраняет дельту списка задач: insert новых, upsert изменённых, синхронизирует зависимости.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
export async function persistProjectTasksDelta(client, projectId, userId, oldTasks, newTasks) {
  const oldMap = new Map(oldTasks.map((t) => [t.id, t]))
  for (const t of newTasks) {
    const o = oldMap.get(t.id)
    if (!o) {
      const row = taskRowFromApp(t, projectId, userId)
      const r = await client.from('tasks').insert(row).select()
      logResult('insertTask', r)
      if (r.error) throw r.error
      if (t.dependsOnTaskId) {
        await setTaskDependencyRemote(client, t.id, t.dependsOnTaskId)
      }
    } else {
      if (taskPersistableFieldsDiffer(o, t)) {
        const row = taskRowFromApp(t, projectId, userId)
        const r = await client.from('tasks').upsert(row, { onConflict: 'id' }).select()
        logResult('upsertTask', r)
        if (r.error) throw r.error
      }
      if ((o.dependsOnTaskId ?? null) !== (t.dependsOnTaskId ?? null)) {
        await setTaskDependencyRemote(client, t.id, t.dependsOnTaskId ?? null)
      }
    }
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function setTaskDependencyRemote(client, successorTaskId, predecessorTaskId) {
  const del = await client.from('task_dependencies').delete().eq('successor_task_id', successorTaskId)
  logResult('deleteTaskDependencies', del)
  if (del.error) throw del.error
  if (predecessorTaskId) {
    const ins = await client.from('task_dependencies').insert({
      predecessor_task_id: predecessorTaskId,
      successor_task_id: successorTaskId,
      dependency_type: 'finish_start',
    })
    logResult('insertTaskDependency', ins)
    if (ins.error) throw ins.error
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateTaskMilestoneRemote(client, taskId, userId, milestoneId) {
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
  const r = await client
    .from('projects')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', projectId)
  logResult('updateProjectTitle', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateMilestoneTitleRemote(client, milestoneId, title) {
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
  const r = await client
    .from('milestones')
    .update({ deadline: deadlineDate, updated_at: new Date().toISOString() })
    .eq('id', milestoneId)
  logResult('updateMilestoneDeadline', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteMilestoneRemote(client, milestoneId) {
  const r = await client.from('milestones').delete().eq('id', milestoneId)
  logResult('deleteMilestone', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function deleteTaskRemote(client, taskId) {
  const r = await client.from('tasks').delete().eq('id', taskId)
  logResult('deleteTask', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function updateTasksStatusBulkRemote(client, userId, taskIds, status) {
  if (!taskIds.length) return
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
export async function deleteTasksBulkRemote(client, taskIds) {
  if (!taskIds.length) return
  const r = await client.from('tasks').delete().in('id', taskIds)
  logResult('deleteTasksBulk', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function insertCommentRemote(client, { id, taskId, authorId, body, createdAt }) {
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
  const r = await client.from('comments').delete().eq('id', commentId)
  logResult('deleteComment', r)
  if (r.error) throw r.error
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function fetchProfiles(client) {
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
 * @returns {Promise<{ id: string, name: string, milestones: { id: string, name: string, deadline: string | null }[], tasks: object[] }[]>}
 */
export async function fetchProjectsTree(client) {
  const {
    data: { user },
    error: userErr,
  } = await client.auth.getUser()
  if (userErr) throw userErr
  if (!user) return []

  const { data: projects, error: e1 } = await client
    .from('projects')
    .select('id, title, created_at')
    .order('created_at')
  if (e1) throw e1
  if (!projects?.length) return []
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
    })
  }

  return (projects ?? []).map((p) => ({
    id: p.id,
    name: p.title,
    milestones: milestoneRowsByProject[p.id] ?? [],
    tasks: tasksByProject[p.id] ?? [],
  }))
}

function taskRowFromApp(task, projectId, userId) {
  return {
    id: task.id,
    project_id: projectId,
    milestone_id: task.milestoneId || null,
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

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function createProjectRemote(client, title, userId) {
  const { data, error } = await client
    .from('projects')
    .insert({ title, created_by: userId })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function createMilestoneRemote(client, projectId, name, userId) {
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
  if (attachment.storagePath) {
    await client.storage.from('task-attachments').remove([attachment.storagePath])
  } else if (attachment.fileUrl?.includes('/task-attachments/')) {
    const i = attachment.fileUrl.indexOf('/task-attachments/')
    const rest = attachment.fileUrl.slice(i + '/task-attachments/'.length)
    const path = rest.split('?')[0]
    if (path) await client.storage.from('task-attachments').remove([path])
  }
  const del = await client.from('attachments').delete().eq('id', attachment.id)
  logResult('deleteAttachment', del)
  if (del.error) throw del.error
}

export { ungrouped as ungroupedMilestoneId }
