import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

const dayMs = 1000 * 60 * 60 * 24
const GANTT_ROW_H = 52
const GANTT_SIDE_W = 340
const DAY_W = { week: 42, month: 28 }
const ungroupedMilestoneId = 'none'
const ASSIGNEE_COLORS = [
  { start: '#3b82f6', end: '#2563eb', text: '#ffffff' },
  { start: '#8b5cf6', end: '#7c3aed', text: '#ffffff' },
  { start: '#14b8a6', end: '#0d9488', text: '#ffffff' },
  { start: '#f59e0b', end: '#d97706', text: '#ffffff' },
  { start: '#ec4899', end: '#db2777', text: '#ffffff' },
  { start: '#22c55e', end: '#16a34a', text: '#ffffff' },
  { start: '#ef4444', end: '#dc2626', text: '#ffffff' },
]
const UNASSIGNED_COLOR = { start: '#cbd5e1', end: '#94a3b8', text: '#1f2937' }

const toDate = (value) => new Date(`${value}T00:00:00`)
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / dayMs)
const shiftDate = (dateString, days) => {
  const date = toDate(dateString)
  date.setDate(date.getDate() + days)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
const formatDateRu = (value) => toDate(value).toLocaleDateString('ru-RU')
const formatShort = (value) =>
  toDate(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
const normalizeAssignee = (task) => {
  const key = task.assigneeId || (task.assignee || '').trim().toLowerCase() || '__unassigned__'
  const label = task.assignee || 'Без исполнителя'
  return { key, label }
}
const hashString = (value) => {
  let h = 0
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0
  return Math.abs(h)
}

function buildRange(visibleTasks, padding = 4) {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (!visibleTasks.length) {
    return { start: todayStr, days: 21 }
  }
  let minS = visibleTasks[0].startDate
  let maxD = visibleTasks[0].deadline
  for (const t of visibleTasks) {
    if (toDate(t.startDate) < toDate(minS)) minS = t.startDate
    if (toDate(t.deadline) > toDate(maxD)) maxD = t.deadline
  }
  const start = shiftDate(minS, -padding)
  const end = shiftDate(maxD, padding)
  const days = Math.max(14, diffDays(end, start) + 1)
  return { start, days }
}

function monthSegments(rangeStart, totalDays) {
  const segments = []
  let i = 0
  while (i < totalDays) {
    const ds = shiftDate(rangeStart, i)
    const label = toDate(ds).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    let span = 1
    i++
    while (i < totalDays) {
      const next = shiftDate(rangeStart, i)
      if (toDate(next).getMonth() !== toDate(ds).getMonth()) break
      span++
      i++
    }
    segments.push({ label, span, key: `${ds}-${label}` })
  }
  return segments
}

function milestoneAggRange(tasksInMilestone) {
  const active = tasksInMilestone.filter((t) => t.status !== 'Готово')
  const pool = active.length ? active : tasksInMilestone
  if (!pool.length) return null
  let minS = pool[0].startDate
  let maxD = pool[0].deadline
  for (const t of pool) {
    if (toDate(t.startDate) < toDate(minS)) minS = t.startDate
    if (toDate(t.deadline) > toDate(maxD)) maxD = t.deadline
  }
  return { minS, maxD }
}

function milestoneDiamondDate(tasksInMilestone, milestoneDeadlineFn) {
  const d = milestoneDeadlineFn()
  return d
}

export function ProjectGantt({
  milestones,
  tasksByMilestone,
  expandedIds,
  onToggleMilestone,
  visibleTasks,
  milestoneDeadline,
  applyTaskDates,
  autoShift,
  onAutoShiftChange,
  violatingTaskIds,
  todayStr,
  onOpenTask,
}) {
  const arrowMarkerId = `gantt-arr-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [scale, setScale] = useState('week')
  const dayW = DAY_W[scale] ?? DAY_W.week
  const { start: rangeStart, days: totalDays } = useMemo(() => buildRange(visibleTasks), [visibleTasks])
  const segments = useMemo(() => monthSegments(rangeStart, totalDays), [rangeStart, totalDays])

  const expandedSet = useMemo(() => new Set(expandedIds), [expandedIds])
  const violating = useMemo(() => new Set(violatingTaskIds), [violatingTaskIds])
  const taskById = useMemo(() => new Map(visibleTasks.map((t) => [t.id, t])), [visibleTasks])
  const assigneeLegend = useMemo(() => {
    const byKey = new Map()
    for (const t of visibleTasks) {
      const { key, label } = normalizeAssignee(t)
      if (!byKey.has(key)) byKey.set(key, { key, label })
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  }, [visibleTasks])
  const assigneeColor = useCallback((assigneeKey) => {
    if (assigneeKey === '__unassigned__') return UNASSIGNED_COLOR
    return ASSIGNEE_COLORS[hashString(assigneeKey) % ASSIGNEE_COLORS.length]
  }, [])

  const rows = useMemo(() => {
    const list = []
    for (const m of milestones) {
      const tasks = tasksByMilestone[m.id] ?? []
      const agg = milestoneAggRange(tasks)
      const md = milestoneDiamondDate(tasks, () => milestoneDeadline(m.id))
      list.push({ kind: 'milestone', milestone: m, tasks, agg, diamond: md, expanded: expandedSet.has(m.id) })
      if (expandedSet.has(m.id)) {
        for (const task of tasks) {
          list.push({ kind: 'task', milestone: m, task })
        }
      }
    }
    return list
  }, [milestones, tasksByMilestone, expandedSet, milestoneDeadline])

  const rowIndexByTaskId = useMemo(() => {
    const map = new Map()
    rows.forEach((r, i) => {
      if (r.kind === 'task') map.set(r.task.id, i)
    })
    return map
  }, [rows])

  const depEdges = useMemo(() => {
    const edges = []
    const vis = new Set(visibleTasks.map((t) => t.id))
    for (const t of visibleTasks) {
      const pid = t.dependsOnTaskId
      if (!pid || !vis.has(pid)) continue
      edges.push({ from: pid, to: t.id })
    }
    return edges
  }, [visibleTasks])

  const todayIdx = diffDays(todayStr, rangeStart)
  const gridW = totalDays * dayW

  const [drag, setDrag] = useState(null)
  const viewportRef = useRef(null)
  /** Сохраняем скролл внутри ганта при перерисовке (масштаб, данные), чтобы не сбрасывалась позиция. */
  const scrollPreserveRef = useRef({ left: 0, top: 0 })

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      scrollPreserveRef.current = { left: el.scrollLeft, top: el.scrollTop }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const { left, top } = scrollPreserveRef.current
    el.scrollLeft = left
    el.scrollTop = top
  })

  /** Клик по чипам не должен переводить фокус (иначе браузер скроллит страницу к элементу). */
  const chipMouseDown = useCallback((e) => {
    if (e.button === 0) e.preventDefault()
  }, [])

  const barLeftWidth = useCallback(
    (task) => {
      const i0 = diffDays(task.startDate, rangeStart)
      const dur = diffDays(task.deadline, task.startDate) + 1
      const left = Math.max(0, i0) * dayW + 4
      const width = Math.max(dur * dayW - 8, 8)
      return { left, width: Math.min(width, gridW - left + 4) }
    },
    [rangeStart, dayW, gridW],
  )

  const onBarPointerDown = useCallback(
    (e, task, mode) => {
      if (task.status === 'Готово') return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const origStart = task.startDate
      const origDeadline = task.deadline
      const dur = diffDays(origDeadline, origStart) + 1
      setDrag({
        taskId: task.id,
        mode,
        startX,
        origStart,
        origDeadline,
        dur,
        previewStart: origStart,
        previewDeadline: origDeadline,
      })

      const onMove = (ev) => {
        const dx = ev.clientX - startX
        const deltaDays = Math.round(dx / dayW)
        setDrag((prev) => {
          if (!prev) return null
          if (prev.taskId !== task.id) return prev
          if (mode === 'move') {
            const ns = shiftDate(origStart, deltaDays)
            const nd = shiftDate(origDeadline, deltaDays)
            return { ...prev, previewStart: ns, previewDeadline: nd }
          }
          if (mode === 'resize-left') {
            let ns = shiftDate(origStart, deltaDays)
            const nd = origDeadline
            if (diffDays(nd, ns) < 0) ns = nd
            return { ...prev, previewStart: ns, previewDeadline: nd }
          }
          if (mode === 'resize-right') {
            let nd = shiftDate(origDeadline, deltaDays)
            if (diffDays(nd, origStart) < 0) nd = origStart
            return { ...prev, previewStart: origStart, previewDeadline: nd }
          }
          return prev
        })
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setDrag((prev) => {
          if (!prev || prev.taskId !== task.id) return null
          const { previewStart, previewDeadline } = prev
          if (previewStart !== origStart || previewDeadline !== origDeadline) {
            if (diffDays(previewDeadline, previewStart) >= 0) {
              applyTaskDates(task.id, previewStart, previewDeadline)
            }
          }
          return null
        })
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [applyTaskDates, dayW],
  )

  const displayTask = (task) => {
    if (drag && drag.taskId === task.id) {
      return { ...task, startDate: drag.previewStart, deadline: drag.previewDeadline }
    }
    return task
  }

  return (
    <section className="panel gantt-wrap">
      <div className="gantt-panel-head">
        <div className="gantt-panel-head__title">
          <div className="gantt-eyebrow">Планирование</div>
          <h2 className="heading-h2 gantt-panel-head__h2">Гант проекта</h2>
          <p className="gantt-panel-head__desc">
            Здесь не создают задачи — управляют сроками, зависимостями и влиянием изменений на план. Список по вехам
            выше остаётся основным местом работы с задачами.
          </p>
        </div>
        <div className="gantt-head-actions">
          <button
            type="button"
            className={`gantt-chip${autoShift ? ' gantt-chip--active' : ''}`}
            onMouseDown={chipMouseDown}
            onClick={() => onAutoShiftChange(!autoShift)}
          >
            Автосдвиг зависимых задач
          </button>
          <button
            type="button"
            className={`gantt-chip${scale === 'week' ? ' gantt-chip--active' : ''}`}
            onMouseDown={chipMouseDown}
            onClick={() => setScale('week')}
          >
            Неделя
          </button>
          <button
            type="button"
            className={`gantt-chip${scale === 'month' ? ' gantt-chip--active' : ''}`}
            onMouseDown={chipMouseDown}
            onClick={() => setScale('month')}
          >
            Месяц
          </button>
        </div>
      </div>

      <div className="gantt-toolbar gantt-toolbar--meta-only">
        <span className="gantt-meta-line">
          Сегодня: <strong>{formatShort(todayStr)}</strong>
          <span className="gantt-meta-line__sep" aria-hidden>
            ·
          </span>
          Видно на шкале:{' '}
          <strong>
            {totalDays} {totalDays === 1 ? 'день' : totalDays < 5 ? 'дня' : 'дней'}
          </strong>
        </span>
      </div>

      <div
        className="gantt-viewport"
        ref={viewportRef}
        style={{ ['--gantt-day-w']: `${dayW}px` }}
      >
        <div
          className="gantt"
          style={{
            minWidth: GANTT_SIDE_W + gridW,
            gridTemplateColumns: `${GANTT_SIDE_W}px 1fr`,
          }}
        >
          <div className="gantt-left">
            <div className="gantt-head-left">Задачи и вехи</div>
            {rows.map((row) =>
              row.kind === 'milestone' ? (
                <div
                  key={`m-${row.milestone.id}`}
                  className={`gantt-row-label${row.milestone.id === ungroupedMilestoneId ? '' : ' gantt-row-label--milestone'}`}
                  style={{ height: GANTT_ROW_H }}
                >
                  <button
                    type="button"
                    className="gantt-mini-caret"
                    aria-expanded={row.expanded}
                    onMouseDown={chipMouseDown}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleMilestone(row.milestone.id)
                    }}
                  >
                    {row.expanded ? '▾' : '▸'}
                  </button>
                  <span className="gantt-row-label__name">{row.milestone.name}</span>
                  <span className="gantt-row-label__meta">
                    {row.diamond ? formatShort(row.diamond) : '—'}
                  </span>
                </div>
              ) : (
                <div
                  key={`t-${row.task.id}`}
                  className="gantt-row-label"
                  style={{ height: GANTT_ROW_H }}
                >
                  <span className="gantt-drag-hint" aria-hidden>
                    ⋮⋮
                  </span>
                  <button
                    type="button"
                    className="gantt-row-label__name gantt-row-label__name--task"
                    onClick={() => onOpenTask(row.task.id)}
                  >
                    {row.task.title}
                  </button>
                  <span className="gantt-row-label__meta">{formatShort(row.task.deadline)}</span>
                </div>
              ),
            )}
          </div>

          <div className="gantt-right" style={{ minWidth: gridW }}>
            <div className="gantt-head-right" style={{ top: 0 }}>
              <div className="gantt-month-row" style={{ gridTemplateColumns: segments.map((s) => `${s.span}fr`).join(' ') }}>
                {segments.map((s) => (
                  <div key={s.key} className="gantt-month-cell">
                    {s.label}
                  </div>
                ))}
              </div>
              <div
                className="gantt-day-row"
                style={{ gridTemplateColumns: `repeat(${totalDays}, ${dayW}px)` }}
              >
                {Array.from({ length: totalDays }, (_, i) => {
                  const ds = shiftDate(rangeStart, i)
                  const weekend = [0, 6].includes(toDate(ds).getDay())
                  const num = toDate(ds).getDate()
                  return (
                    <div key={ds} className={`gantt-day-cell${weekend ? ' gantt-day-cell--weekend' : ''}`}>
                      {num}
                    </div>
                  )
                })}
              </div>
            </div>

            <div
              className="gantt-grid-area"
              style={{
                position: 'relative',
                marginTop: 0,
                minHeight: rows.length * GANTT_ROW_H,
              }}
            >
              {todayIdx >= 0 && todayIdx < totalDays && (
                <>
                  <div
                    className="gantt-today-line"
                    style={{ left: (todayIdx + 0.5) * dayW }}
                  />
                  <div className="gantt-today-badge" style={{ left: todayIdx * dayW - 8 }}>
                    Сегодня
                  </div>
                </>
              )}

              <svg
                className="gantt-deps-svg"
                width={gridW}
                height={rows.length * GANTT_ROW_H}
                style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 1 }}
              >
                {depEdges.map(({ from, to }) => {
                  const ri = rowIndexByTaskId.get(from)
                  const rj = rowIndexByTaskId.get(to)
                  const ta = taskById.get(from)
                  const tb = taskById.get(to)
                  if (ri == null || rj == null || !ta || !tb) return null
                  const x1 = (diffDays(ta.deadline, rangeStart) + 1) * dayW - 6
                  const x2 = diffDays(tb.startDate, rangeStart) * dayW + 6
                  const y1 = ri * GANTT_ROW_H + GANTT_ROW_H * 0.55
                  const y2 = rj * GANTT_ROW_H + GANTT_ROW_H * 0.55
                  const midY = (y1 + y2) / 2
                  const path = `M ${x1} ${y1} L ${x1 + 12} ${y1} L ${x1 + 12} ${midY} L ${x2 - 12} ${midY} L ${x2 - 12} ${y2} L ${x2} ${y2}`
                  return (
                    <path
                      key={`${from}-${to}`}
                      d={path}
                      fill="none"
                      stroke="#b8c0cc"
                      strokeWidth={2}
                      markerEnd={`url(#${arrowMarkerId})`}
                    />
                  )
                })}
                <defs>
                  <marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="#b8c0cc" />
                  </marker>
                </defs>
              </svg>

              {rows.map((row, rowIdx) => {
                const top = rowIdx * GANTT_ROW_H
                if (row.kind === 'milestone') {
                  const { agg, milestone, diamond } = row
                  if (!agg) {
                    return (
                      <div
                        key={`gr-${milestone.id}`}
                        className="gantt-grid-row gantt-grid-row--milestone"
                        style={{ height: GANTT_ROW_H, top, position: 'absolute', left: 0, right: 0, width: '100%' }}
                      />
                    )
                  }
                  const i0 = diffDays(agg.minS, rangeStart)
                  const i1 = diffDays(agg.maxD, rangeStart)
                  const w = (i1 - i0 + 1) * dayW - 12
                  const left = i0 * dayW + 6
                  const dIdx = diamond ? diffDays(diamond, rangeStart) : null
                  return (
                    <div
                      key={`gr-${milestone.id}`}
                      className="gantt-grid-row gantt-grid-row--milestone"
                      style={{
                        height: GANTT_ROW_H,
                        top,
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        width: '100%',
                      }}
                    >
                      <div className="gantt-milestone-bar" style={{ left, width: Math.max(w, 8) }} />
                      {dIdx != null && dIdx >= 0 && dIdx < totalDays && (
                        <div
                          className={`gantt-milestone-diamond${(() => {
                            const dl = diffDays(diamond, todayStr)
                            if (dl < 0) return ' gantt-milestone-diamond--danger'
                            if (dl <= 7) return ' gantt-milestone-diamond--warn'
                            return ' gantt-milestone-diamond--ok'
                          })()}`}
                          style={{ left: dIdx * dayW + dayW / 2 - 11 }}
                        />
                      )}
                    </div>
                  )
                }

                const task = displayTask(row.task)
                const { left, width } = barLeftWidth(task)
                const { key: assigneeKey } = normalizeAssignee(task)
                const color = assigneeColor(assigneeKey)
                return (
                  <div
                    key={`gr-${task.id}`}
                    className="gantt-grid-row"
                    style={{
                      height: GANTT_ROW_H,
                      top,
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      width: '100%',
                    }}
                  >
                    <div
                      className={`gantt-bar${task.status === 'Готово' ? ' gantt-bar--done-state' : ''}${violating.has(task.id) ? ' gantt-bar--problem-state' : ''}`}
                      style={{
                        left,
                        width,
                        background: `linear-gradient(180deg, ${color.start} 0%, ${color.end} 100%)`,
                        color: color.text,
                      }}
                      title={`${task.title}\n${formatDateRu(task.startDate)} — ${formatDateRu(task.deadline)}\n${task.status}${row.milestone ? `\nВеха: ${row.milestone.name}` : ''}`}
                      onPointerDown={(e) => {
                        if (e.target.closest('.gantt-bar__handle')) return
                        onBarPointerDown(e, row.task, 'move')
                      }}
                    >
                      <span
                        className="gantt-bar__handle"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onBarPointerDown(e, row.task, 'resize-left')
                        }}
                      />
                      <span className="gantt-bar__label">{task.title}</span>
                      <span
                        className="gantt-bar__handle"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onBarPointerDown(e, row.task, 'resize-right')
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="gantt-legend">
        {assigneeLegend.map((a) => {
          const color = assigneeColor(a.key)
          return (
            <span key={a.key} className="gantt-legend-item">
              <span
                className="gantt-legend-dot"
                style={{ background: `linear-gradient(180deg, ${color.start} 0%, ${color.end} 100%)` }}
              />
              {a.label}
            </span>
          )
        })}
        <span className="gantt-legend-item">
          <span className="gantt-legend-line" />
          Связь зависимых задач
        </span>
      </div>
    </section>
  )
}

