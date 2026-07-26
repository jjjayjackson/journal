const STORAGE_KEY = 'journal-mvp:entries'

const feedEl = document.getElementById('feed')
const composerEl = document.getElementById('composer')
const inputEl = document.getElementById('entry-input')
const pasteBtnEl = document.getElementById('paste-btn')

let entries = loadEntries()
let editingId = null

function normalizeEntry(entry) {
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    typeof entry.text !== 'string' ||
    typeof entry.createdAt !== 'string'
  ) {
    return null
  }

  const date = new Date(entry.createdAt)
  if (Number.isNaN(date.getTime())) return null

  return {
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt,
  }
}

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeEntry).filter(Boolean)
  } catch {
    return []
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

function createEntry(text) {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getDayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDayHeader(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = String(date.getFullYear()).slice(-2)
  return `${month}.${day}.${year}`
}

function formatEntryTime(date) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}${minutes}`
}

function groupEntriesByDay(list) {
  const groups = []
  const indexByKey = new Map()

  for (const entry of list) {
    const date = new Date(entry.createdAt)
    const key = getDayKey(date)

    if (!indexByKey.has(key)) {
      indexByKey.set(key, groups.length)
      groups.push({ key, date, entries: [] })
    }

    groups[indexByKey.get(key)].entries.push(entry)
  }

  return groups
}

function resizeComposer() {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${inputEl.scrollHeight}px`
}

function resetComposerHeight() {
  inputEl.style.height = ''
  resizeComposer()
}

function startEdit(id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return

  editingId = id
  inputEl.value = entry.text
  resizeComposer()
  inputEl.focus()
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
}

function deleteEntry(id) {
  entries = entries.filter((item) => item.id !== id)
  if (editingId === id) {
    editingId = null
    inputEl.value = ''
    resetComposerHeight()
  }
  saveEntries()
  render()
}

function render() {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  )
  const groups = groupEntriesByDay(sorted)

  feedEl.innerHTML = groups
    .map(
      (group) => `
      <section class="day-group">
        <h2 class="day-header">${escapeHtml(formatDayHeader(group.date))}</h2>
        ${group.entries
          .map((entry) => {
            const date = new Date(entry.createdAt)
            return `
              <article class="entry" data-id="${escapeHtml(entry.id)}">
                <time class="entry-time" datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(formatEntryTime(date))}</time>
                <p class="entry-text">${escapeHtml(entry.text)}</p>
                <div class="entry-actions">
                  <button type="button" class="entry-action" data-action="edit">Edit</button>
                  <button type="button" class="entry-action" data-action="delete">Delete</button>
                </div>
              </article>
            `
          })
          .join('')}
      </section>
    `,
    )
    .join('')

  feedEl.scrollTop = feedEl.scrollHeight
}

function submitEntry(text = inputEl.value) {
  const trimmed = text.trim()
  if (!trimmed) return

  if (editingId) {
    const entry = entries.find((item) => item.id === editingId)
    if (entry) {
      entry.text = trimmed
    }
    editingId = null
  } else {
    entries.push(createEntry(trimmed))
  }

  saveEntries()
  inputEl.value = ''
  resetComposerHeight()
  render()
  inputEl.focus()
}

function submitPastedText(text) {
  const trimmed = text.trim()
  if (!trimmed) return

  entries.push(createEntry(trimmed))
  saveEntries()
  render()
  inputEl.focus()
}

async function pasteAndSubmit() {
  try {
    const text = await navigator.clipboard.readText()
    submitPastedText(text)
  } catch {
    // Clipboard access denied or unavailable (e.g. file://)
  }
}

inputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submitEntry()
})

inputEl.addEventListener('paste', (event) => {
  if (editingId) return
  if (inputEl.value.trim() !== '') return

  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim()) return

  event.preventDefault()
  submitPastedText(text)
})

inputEl.addEventListener('input', resizeComposer)

pasteBtnEl.addEventListener('click', pasteAndSubmit)

feedEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]')
  if (!button) return

  const entryEl = button.closest('.entry')
  if (!entryEl || !feedEl.contains(entryEl)) return

  const id = entryEl.dataset.id
  const action = button.dataset.action

  if (action === 'edit') {
    startEdit(id)
  } else if (action === 'delete') {
    deleteEntry(id)
  }
})

composerEl.addEventListener('submit', (event) => {
  event.preventDefault()
  submitEntry()
})

render()
resetComposerHeight()
inputEl.focus()
