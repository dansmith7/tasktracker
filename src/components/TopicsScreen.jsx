import { useCallback, useState } from 'react'

const UNSORTED_ID = '__unsorted__'

/**
 * @param {{
 *   topics: { id: string, name: string }[],
 *   projects: { id: string, name: string, topicId: string | null }[],
 *   onOpenProject: (id: string) => void,
 *   onMoveProject: (projectId: string, topicId: string | null) => void | Promise<void>,
 *   onCreateTopic: (title: string) => void | Promise<void>,
 *   onRenameTopic: (topicId: string, title: string) => void | Promise<void>,
 *   onDeleteTopic: (topicId: string) => void | Promise<void>,
 *   onRequestNewProject: (topicId: string | null) => void,
 * }} props
 */
export function TopicsScreen({
  topics,
  projects,
  onOpenProject,
  onMoveProject,
  onCreateTopic,
  onRenameTopic,
  onDeleteTopic,
  onRequestNewProject,
}) {
  const [newTopicOpen, setNewTopicOpen] = useState(false)
  const [newTopicTitle, setNewTopicTitle] = useState('')
  const [editingTopicId, setEditingTopicId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')

  const handleDrop = useCallback(
    async (e, topicId) => {
      e.preventDefault()
      const projectId = e.dataTransfer.getData('application/project-id')
      if (!projectId) return
      await onMoveProject(projectId, topicId === UNSORTED_ID ? null : topicId)
    },
    [onMoveProject],
  )

  const columns = [
    { id: UNSORTED_ID, name: 'Без темы', isUnsorted: true },
    ...topics.map((t) => ({ id: t.id, name: t.name, isUnsorted: false })),
  ]

  return (
    <div className="topics-screen">
      <div className="topics-screen__toolbar">
        <div className="topics-screen__toolbar-block">
          <div className="topics-screen__toolbar-label">Темы</div>
          <button type="button" className="btn-primary" onClick={() => setNewTopicOpen(true)}>
            <span className="btn-primary__icon" aria-hidden>
              +
            </span>
            Новая тема
          </button>
        </div>
      </div>

      {newTopicOpen && (
        <div className="topics-screen__new-topic">
          <input
            className="topics-screen__new-topic-input"
            placeholder="Название темы"
            value={newTopicTitle}
            onChange={(e) => setNewTopicTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const t = newTopicTitle.trim()
                if (t) {
                  void onCreateTopic(t)
                  setNewTopicTitle('')
                  setNewTopicOpen(false)
                }
              }
              if (e.key === 'Escape') {
                setNewTopicOpen(false)
                setNewTopicTitle('')
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!newTopicTitle.trim()}
            onClick={() => {
              const t = newTopicTitle.trim()
              if (!t) return
              void onCreateTopic(t)
              setNewTopicTitle('')
              setNewTopicOpen(false)
            }}
          >
            Создать
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setNewTopicOpen(false)
              setNewTopicTitle('')
            }}
          >
            Отмена
          </button>
        </div>
      )}

      <div className="topics-board">
        {columns.map((col) => {
          const colProjects = projects.filter((p) =>
            col.isUnsorted ? p.topicId == null : p.topicId === col.id,
          )
          return (
            <section
              key={col.id}
              className="topic-column"
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => handleDrop(e, col.id)}
            >
              <header className="topic-column__head">
                <div className="topic-column__title-group">
                  <span className={`topic-column__kind ${col.isUnsorted ? 'topic-column__kind--muted' : ''}`}>
                    {col.isUnsorted ? 'Системная группа' : 'Тема'}
                  </span>
                  {editingTopicId === col.id && !col.isUnsorted ? (
                    <input
                      className="topic-column__title-input"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      autoFocus
                      onBlur={() => {
                        const t = editingTitle.trim()
                        if (t && t !== col.name) void onRenameTopic(col.id, t)
                        setEditingTopicId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const t = editingTitle.trim()
                          if (t) void onRenameTopic(col.id, t)
                          setEditingTopicId(null)
                        }
                        if (e.key === 'Escape') {
                          setEditingTopicId(null)
                        }
                      }}
                    />
                  ) : (
                    <h3 className="topic-column__title heading-h3">{col.name}</h3>
                  )}
                </div>
                {!col.isUnsorted && (
                  <div className="topic-column__topic-actions">
                    <button
                      type="button"
                      className="btn-secondary topic-column__action-btn"
                      onClick={() => {
                        setEditingTopicId(col.id)
                        setEditingTitle(col.name)
                      }}
                    >
                      Изменить тему
                    </button>
                    <button
                      type="button"
                      className="btn-secondary topic-column__action-btn topic-column__action-btn--danger"
                      onClick={() => {
                        if (window.confirm('Удалить тему? Проекты останутся без темы.')) {
                          void onDeleteTopic(col.id)
                        }
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </header>
              <div className="topic-column__projects-head">
                <span className="topic-column__projects-label">Проекты</span>
                <span className="topic-column__projects-count">{colProjects.length}</span>
              </div>
              <div className="topic-column__projects">
                {colProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="topic-project-chip"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/project-id', p.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onOpenProject(p.id)}
                  >
                    <span className="topic-project-chip__drag" aria-hidden>
                      ⋮⋮
                    </span>
                    <span className="topic-project-chip__name">{p.name}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="topic-column__add-project btn-secondary"
                onClick={() => onRequestNewProject(col.isUnsorted ? null : col.id)}
              >
                {col.isUnsorted ? '+ Новый проект без темы' : '+ Новый проект'}
              </button>
            </section>
          )
        })}
      </div>
    </div>
  )
}
