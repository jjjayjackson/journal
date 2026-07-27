const STORAGE_KEY = 'journal-mvp:entries'

const feedEl = document.getElementById('feed')
const composerEl = document.getElementById('composer')
const inputEl = document.getElementById('entry-input')
const pasteBtnEl = document.getElementById('paste-btn')
const backdateSheetEl = document.getElementById('backdate-sheet')
const backdateTitleEl = document.getElementById('backdate-title')
const backdatePreviewEl = document.getElementById('backdate-preview')
const backdateDatetimeEl = document.getElementById('backdate-datetime')
const backdateCancelEl = document.getElementById('backdate-cancel')
const backdateConfirmEl = document.getElementById('backdate-confirm')

let entries = loadEntries()
let editingId = null
let bHeld = false
let backdateSession = null

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

function createEntry(text, createdAt = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt,
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

function toDatetimeLocalValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function fromDatetimeLocalValue(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
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

function shouldArmBackdateKey() {
  if (backdateSession) return false
  if (editingId) return false
  if (inputEl.value.trim() !== '') return false
  return true
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

function openBackdateSheet(session) {
  backdateSession = session
  bHeld = false

  backdateTitleEl.textContent =
    session.mode === 'edit' ? 'Edit time' : 'Backdate'

  if (session.mode === 'create') {
    backdatePreviewEl.hidden = false
    backdatePreviewEl.textContent = session.text
  } else {
    backdatePreviewEl.hidden = true
    backdatePreviewEl.textContent = ''
  }

  backdateDatetimeEl.value = toDatetimeLocalValue(new Date(session.createdAt))
  backdateConfirmEl.textContent = session.mode === 'edit' ? 'Save' : 'Confirm'
  backdateSheetEl.hidden = false
  backdateDatetimeEl.focus()
}

function closeBackdateSheet() {
  backdateSession = null
  backdateSheetEl.hidden = true
  backdatePreviewEl.hidden = true
  backdatePreviewEl.textContent = ''
  backdateDatetimeEl.value = ''
  inputEl.focus()
}

function confirmBackdateSheet() {
  if (!backdateSession) return

  const createdAt = fromDatetimeLocalValue(backdateDatetimeEl.value)
  if (!createdAt) return

  if (backdateSession.mode === 'create') {
    entries.push(createEntry(backdateSession.text, createdAt))
    saveEntries()
    closeBackdateSheet()
    render()
    return
  }

  const entry = entries.find((item) => item.id === backdateSession.entryId)
  if (entry) {
    entry.createdAt = createdAt
    saveEntries()
  }

  closeBackdateSheet()
  render({ preserveScroll: true })
}

function render({ preserveScroll = false } = {}) {
  const scrollTop = feedEl.scrollTop
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
                <div class="entry-actions">
                  <button type="button" class="entry-action" data-action="edit" aria-label="Edit">
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                    </svg>
                  </button>
                  <button type="button" class="entry-action" data-action="delete" aria-label="Delete">
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                    </svg>
                  </button>
                </div>
                <div class="entry-body">
                  <button
                    type="button"
                    class="entry-time"
                    data-action="edit-time"
                    aria-label="Edit time ${escapeHtml(formatEntryTime(date))}"
                  >${escapeHtml(formatEntryTime(date))}</button>
                  <p class="entry-text">${escapeHtml(entry.text)}</p>
                </div>
              </article>
            `
          })
          .join('')}
      </section>
    `,
    )
    .join('')

  feedEl.scrollTop = preserveScroll ? scrollTop : feedEl.scrollHeight
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

  if (bHeld) {
    openBackdateSheet({
      mode: 'create',
      text: trimmed,
      createdAt: new Date().toISOString(),
    })
    return
  }

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

function startEditTime(id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return

  openBackdateSheet({
    mode: 'edit',
    entryId: entry.id,
    createdAt: entry.createdAt,
  })
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && backdateSession) {
    event.preventDefault()
    closeBackdateSheet()
    return
  }

  if (event.key !== 'b' && event.key !== 'B') return
  if (event.repeat) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (!shouldArmBackdateKey()) return

  event.preventDefault()
  bHeld = true
})

document.addEventListener('keyup', (event) => {
  if (event.key === 'b' || event.key === 'B') {
    bHeld = false
  }
})

window.addEventListener('blur', () => {
  bHeld = false
})

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
  } else if (action === 'edit-time') {
    startEditTime(id)
  }
})

backdateCancelEl.addEventListener('click', closeBackdateSheet)

backdateConfirmEl.addEventListener('click', confirmBackdateSheet)

backdateSheetEl.addEventListener('click', (event) => {
  if (event.target === backdateSheetEl) {
    closeBackdateSheet()
  }
})

backdateDatetimeEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  confirmBackdateSheet()
})

composerEl.addEventListener('submit', (event) => {
  event.preventDefault()
  submitEntry()
})

render()
resetComposerHeight()
inputEl.focus()
