const STORAGE_KEY = 'journal-mvp:entries'
const SETTINGS_KEY = 'journal-mvp:settings'
const VIEW_MODE_DAY = 'day'
const VIEW_MODE_TIMELINE = 'timeline'
const DEFAULT_JOURNAL_ID = 'journal-default'

const appEl = document.getElementById('app')
const sidebarEl = document.getElementById('sidebar')
const journalTabsEl = document.getElementById('journal-tabs')
const feedEl = document.getElementById('feed')
const composerEl = document.getElementById('composer')
const inputEl = document.getElementById('entry-input')
const pasteBtnEl = document.getElementById('paste-btn')
const settingsWrapEl = document.getElementById('settings-wrap')
const settingsOpenEl = document.getElementById('settings-open')
const settingsMenuEl = document.getElementById('settings-menu')
const nameSheetEl = document.getElementById('name-sheet')
const nameTitleEl = document.getElementById('name-title')
const nameInputEl = document.getElementById('name-input')
const nameCancelEl = document.getElementById('name-cancel')
const nameConfirmEl = document.getElementById('name-confirm')
const backdateSheetEl = document.getElementById('backdate-sheet')
const backdateTitleEl = document.getElementById('backdate-title')
const backdatePreviewEl = document.getElementById('backdate-preview')
const backdateDatetimeEl = document.getElementById('backdate-datetime')
const backdateCancelEl = document.getElementById('backdate-cancel')
const backdateConfirmEl = document.getElementById('backdate-confirm')
const contextMenuEl = document.getElementById('context-menu')

let settings = loadSettings()
let entries = loadEntries()
let selectedDayKey = null
let editingId = null
let bHeld = false
let backdateSession = null
let nameSession = null
let contextMenuJournalId = null
/** @type {Set<string>} */
const collapsedFolderIds = new Set(settings.collapsedFolderIds ?? [])

// Persist migrated journalIds / default journal settings once.
saveSettings()
saveEntries()

function createDefaultJournal() {
  return { id: DEFAULT_JOURNAL_ID, name: 'Journal', parentId: null }
}

function normalizeParentId(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  return value
}

function normalizeFolder(folder) {
  if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') {
    return null
  }
  const name = folder.name.trim()
  if (!name) return null
  return {
    id: folder.id,
    name,
    parentId: normalizeParentId(folder.parentId),
  }
}

function normalizeJournal(journal) {
  if (!journal || typeof journal.id !== 'string' || typeof journal.name !== 'string') {
    return null
  }
  const name = journal.name.trim()
  if (!name) return null
  return {
    id: journal.id,
    name,
    parentId: normalizeParentId(journal.parentId),
  }
}

function normalizeEntry(entry, fallbackJournalId) {
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

  const journalId =
    typeof entry.journalId === 'string' && entry.journalId
      ? entry.journalId
      : fallbackJournalId

  return {
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt,
    journalId,
  }
}

function loadEntries() {
  const fallbackJournalId = settings.journals[0]?.id ?? DEFAULT_JOURNAL_ID

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => normalizeEntry(entry, fallbackJournalId))
      .filter(Boolean)
  } catch {
    return []
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

function normalizeSettings(value) {
  const mode =
    value?.viewMode === VIEW_MODE_DAY ? VIEW_MODE_DAY : VIEW_MODE_TIMELINE

  let folders = Array.isArray(value?.folders)
    ? value.folders.map(normalizeFolder).filter(Boolean)
    : []

  const folderIds = new Set(folders.map((folder) => folder.id))

  // Drop folders whose parent is missing or creates a cycle later via orphaning.
  folders = folders.map((folder) => ({
    ...folder,
    parentId:
      folder.parentId && folderIds.has(folder.parentId) && folder.parentId !== folder.id
        ? folder.parentId
        : null,
  }))

  let journals = Array.isArray(value?.journals)
    ? value.journals.map(normalizeJournal).filter(Boolean)
    : []

  if (journals.length === 0) {
    journals = [createDefaultJournal()]
  }

  journals = journals.map((journal) => ({
    ...journal,
    parentId:
      journal.parentId && folderIds.has(journal.parentId) ? journal.parentId : null,
  }))

  let selectedJournalId =
    typeof value?.selectedJournalId === 'string'
      ? value.selectedJournalId
      : journals[0].id

  if (!journals.some((journal) => journal.id === selectedJournalId)) {
    selectedJournalId = journals[0].id
  }

  const collapsedFolderIds = Array.isArray(value?.collapsedFolderIds)
    ? value.collapsedFolderIds.filter(
        (id) => typeof id === 'string' && folderIds.has(id),
      )
    : []

  return {
    viewMode: mode,
    folders,
    journals,
    selectedJournalId,
    collapsedFolderIds,
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return normalizeSettings(null)
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(null)
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

function createEntry(text, createdAt = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt,
    journalId: settings.selectedJournalId,
  }
}

function createJournal(name, parentId = null) {
  return {
    id: crypto.randomUUID(),
    name,
    parentId: parentId || null,
  }
}

function createFolder(name, parentId = null) {
  return {
    id: crypto.randomUUID(),
    name,
    parentId: parentId || null,
  }
}

function persistCollapsedFolders() {
  settings.collapsedFolderIds = [...collapsedFolderIds]
  saveSettings()
}

function getChildFolders(parentId) {
  return settings.folders.filter((folder) => folder.parentId === parentId)
}

function getChildJournals(parentId) {
  return settings.journals.filter((journal) => journal.parentId === parentId)
}

function getDescendantFolderIds(folderId) {
  const ids = []
  const stack = [folderId]

  while (stack.length > 0) {
    const currentId = stack.pop()
    for (const folder of settings.folders) {
      if (folder.parentId !== currentId) continue
      ids.push(folder.id)
      stack.push(folder.id)
    }
  }

  return ids
}

function getJournalIdsUnderFolder(folderId) {
  const folderIds = new Set([folderId, ...getDescendantFolderIds(folderId)])
  return settings.journals
    .filter((journal) => journal.parentId && folderIds.has(journal.parentId))
    .map((journal) => journal.id)
}

function canDeleteJournal(journalId) {
  return settings.journals.length > 1
}

function canDeleteFolder(folderId) {
  const journalIds = new Set(getJournalIdsUnderFolder(folderId))
  return settings.journals.some((journal) => !journalIds.has(journal.id))
}

/**
 * Depth-first tree nodes for sidebar rendering.
 * @returns {{ type: 'folder' | 'journal', id: string, name: string, depth: number, expanded?: boolean }[]}
 */
function getTreeNodes() {
  const nodes = []

  function walk(parentId, depth) {
    for (const folder of getChildFolders(parentId)) {
      const expanded = !collapsedFolderIds.has(folder.id)
      nodes.push({
        type: 'folder',
        id: folder.id,
        name: folder.name,
        depth,
        expanded,
      })
      if (expanded) {
        walk(folder.id, depth + 1)
      }
    }

    for (const journal of getChildJournals(parentId)) {
      nodes.push({
        type: 'journal',
        id: journal.id,
        name: journal.name,
        depth,
      })
    }
  }

  walk(null, 0)
  return nodes
}

/** Journals in depth-first folder order (for day tabs). */
function getJournalsDepthFirst() {
  const result = []

  function walk(parentId) {
    for (const folder of getChildFolders(parentId)) {
      walk(folder.id)
    }
    for (const journal of getChildJournals(parentId)) {
      result.push(journal)
    }
  }

  walk(null)
  return result
}

function getFolderPathNames(folderId) {
  const names = []
  let currentId = folderId
  const seen = new Set()

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const folder = settings.folders.find((item) => item.id === currentId)
    if (!folder) break
    names.unshift(folder.name)
    currentId = folder.parentId
  }

  return names
}

function getJournalPathLabel(journal) {
  if (!journal.parentId) return journal.name
  const parts = [...getFolderPathNames(journal.parentId), journal.name]
  return parts.join(' / ')
}

function getFolderPathLabel(folder) {
  return getFolderPathNames(folder.id).join(' / ')
}

/** Folders in depth-first order for menus. */
function getFoldersDepthFirst() {
  const result = []

  function walk(parentId) {
    for (const folder of getChildFolders(parentId)) {
      result.push(folder)
      walk(folder.id)
    }
  }

  walk(null)
  return result
}

function moveJournal(journalId, parentId) {
  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return false

  const nextParentId = parentId || null
  if (journal.parentId === nextParentId) return false

  if (
    nextParentId &&
    !settings.folders.some((folder) => folder.id === nextParentId)
  ) {
    return false
  }

  journal.parentId = nextParentId
  settings.journals = [
    ...settings.journals.filter((item) => item.id !== journalId),
    journal,
  ]

  if (nextParentId) {
    collapsedFolderIds.delete(nextParentId)
    persistCollapsedFolders()
  }

  saveSettings()
  return true
}

function clearSidebarDropState() {
  sidebarEl.classList.remove('is-dragging-journal')
  for (const el of sidebarEl.querySelectorAll('.is-dragging, .is-drop-target')) {
    el.classList.remove('is-dragging', 'is-drop-target')
  }
}

function closeContextMenu() {
  contextMenuJournalId = null
  contextMenuEl.hidden = true
  contextMenuEl.innerHTML = ''
}

function openJournalContextMenu(journalId, clientX, clientY) {
  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  closeSettingsMenu()
  contextMenuJournalId = journalId

  const folders = getFoldersDepthFirst()
  const folderItems = folders
    .map((folder) => {
      const current = journal.parentId === folder.id
      return `
        <button
          type="button"
          class="context-menu-item${current ? ' is-current' : ''}"
          role="menuitem"
          data-action="move-to-folder"
          data-folder-id="${escapeHtml(folder.id)}"
          ${current ? 'aria-current="true"' : ''}
        >${escapeHtml(getFolderPathLabel(folder))}</button>
      `
    })
    .join('')

  const topLevelItem = journal.parentId
    ? `
      <button
        type="button"
        class="context-menu-item"
        role="menuitem"
        data-action="move-to-root"
      >Top level</button>
    `
    : `
      <button
        type="button"
        class="context-menu-item is-current"
        role="menuitem"
        data-action="move-to-root"
        aria-current="true"
      >Top level</button>
    `

  contextMenuEl.innerHTML = `
    <div class="context-menu-section-label">Move to folder</div>
    ${topLevelItem}
    ${folderItems}
    <div class="context-menu-separator" role="separator"></div>
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="new-folder"
    >New folder…</button>
  `

  contextMenuEl.hidden = false

  const menuWidth = contextMenuEl.offsetWidth
  const menuHeight = contextMenuEl.offsetHeight
  const maxX = window.innerWidth - menuWidth - 8
  const maxY = window.innerHeight - menuHeight - 8
  const left = Math.max(8, Math.min(clientX, maxX))
  const top = Math.max(8, Math.min(clientY, maxY))
  contextMenuEl.style.left = `${left}px`
  contextMenuEl.style.top = `${top}px`
}

function handleContextMenuAction(action, folderId) {
  const journalId = contextMenuJournalId
  closeContextMenu()
  if (!journalId) return

  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  if (action === 'move-to-root') {
    if (moveJournal(journalId, null)) {
      render({ preserveScroll: true })
    }
    return
  }

  if (action === 'move-to-folder') {
    if (!folderId) return
    if (moveJournal(journalId, folderId)) {
      render({ preserveScroll: true })
    }
    return
  }

  if (action === 'new-folder') {
    openNameSheet({
      mode: 'create',
      kind: 'folder',
      parentId: journal.parentId,
      moveJournalId: journalId,
      name: '',
    })
  }
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.closest('[contenteditable="true"]') !== null
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

function previewText(text, maxLength = 72) {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength - 1)}…`
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

function getActiveEntries() {
  return entries
    .filter((entry) => entry.journalId === settings.selectedJournalId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
}

function getDayGroups() {
  return groupEntriesByDay(getActiveEntries())
}

function ensureSelectedDay(groups) {
  if (groups.length === 0) {
    selectedDayKey = null
    return
  }

  if (selectedDayKey && groups.some((group) => group.key === selectedDayKey)) {
    return
  }

  selectedDayKey = groups[groups.length - 1].key
}

function ensureSelectedJournal() {
  if (
    settings.journals.some(
      (journal) => journal.id === settings.selectedJournalId,
    )
  ) {
    return
  }

  settings.selectedJournalId = settings.journals[0].id
  saveSettings()
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
  if (backdateSession || nameSession) return false
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
  closeSettingsMenu()

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
    const entry = createEntry(backdateSession.text, createdAt)
    entries.push(entry)
    selectedDayKey = getDayKey(new Date(entry.createdAt))
    saveEntries()
    closeBackdateSheet()
    render()
    return
  }

  const entry = entries.find((item) => item.id === backdateSession.entryId)
  if (entry) {
    entry.createdAt = createdAt
    selectedDayKey = getDayKey(new Date(createdAt))
    saveEntries()
  }

  closeBackdateSheet()
  render({ preserveScroll: true })
}

function openNameSheet(session) {
  nameSession = session
  closeSettingsMenu()
  closeContextMenu()

  const kind = session.kind === 'folder' ? 'folder' : 'journal'
  if (session.mode === 'create') {
    nameTitleEl.textContent = kind === 'folder' ? 'New folder' : 'New journal'
  } else {
    nameTitleEl.textContent = kind === 'folder' ? 'Rename folder' : 'Rename journal'
  }

  nameInputEl.value = session.name ?? ''
  nameConfirmEl.textContent = session.mode === 'create' ? 'Create' : 'Save'
  nameSheetEl.hidden = false
  nameInputEl.focus()
  nameInputEl.select()
}

function closeNameSheet() {
  nameSession = null
  nameSheetEl.hidden = true
  nameInputEl.value = ''
  inputEl.focus()
}

function confirmNameSheet() {
  if (!nameSession) return

  const name = nameInputEl.value.trim()
  if (!name) return

  const kind = nameSession.kind === 'folder' ? 'folder' : 'journal'

  if (nameSession.mode === 'create') {
    if (kind === 'folder') {
      const folder = createFolder(name, nameSession.parentId ?? null)
      settings.folders.push(folder)
      if (folder.parentId) collapsedFolderIds.delete(folder.parentId)

      const moveJournalId = nameSession.moveJournalId
      if (moveJournalId) {
        moveJournal(moveJournalId, folder.id)
      } else {
        persistCollapsedFolders()
        saveSettings()
      }

      closeNameSheet()
      render({ preserveScroll: true })
      return
    }

    const journal = createJournal(name, nameSession.parentId ?? null)
    settings.journals.push(journal)
    settings.selectedJournalId = journal.id
    selectedDayKey = null
    if (journal.parentId) collapsedFolderIds.delete(journal.parentId)
    persistCollapsedFolders()
    saveSettings()
    closeNameSheet()
    render()
    return
  }

  if (kind === 'folder') {
    const folder = settings.folders.find(
      (item) => item.id === nameSession.folderId,
    )
    if (folder) {
      folder.name = name
      saveSettings()
    }
  } else {
    const journal = settings.journals.find(
      (item) => item.id === nameSession.journalId,
    )
    if (journal) {
      journal.name = name
      saveSettings()
    }
  }

  closeNameSheet()
  render({ preserveScroll: true })
}

function deleteJournal(journalId) {
  if (!canDeleteJournal(journalId)) return

  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  const confirmed = window.confirm(
    `Delete “${journal.name}” and all of its entries?`,
  )
  if (!confirmed) return

  settings.journals = settings.journals.filter((item) => item.id !== journalId)
  entries = entries.filter((entry) => entry.journalId !== journalId)

  if (settings.selectedJournalId === journalId) {
    settings.selectedJournalId = settings.journals[0].id
    selectedDayKey = null
  }

  if (editingId && !entries.some((entry) => entry.id === editingId)) {
    editingId = null
    inputEl.value = ''
    resetComposerHeight()
  }

  saveSettings()
  saveEntries()
  render()
}

function deleteFolder(folderId) {
  if (!canDeleteFolder(folderId)) return

  const folder = settings.folders.find((item) => item.id === folderId)
  if (!folder) return

  const journalIds = getJournalIdsUnderFolder(folderId)
  const folderIds = [folderId, ...getDescendantFolderIds(folderId)]
  const journalCount = journalIds.length
  const folderCount = folderIds.length

  const confirmed = window.confirm(
    journalCount > 0
      ? `Delete “${folder.name}”, ${folderCount} folder${folderCount === 1 ? '' : 's'}, ${journalCount} journal${journalCount === 1 ? '' : 's'}, and all of their entries?`
      : folderCount > 1
        ? `Delete “${folder.name}” and ${folderCount - 1} nested folder${folderCount - 1 === 1 ? '' : 's'}?`
        : `Delete folder “${folder.name}”?`,
  )
  if (!confirmed) return

  const journalIdSet = new Set(journalIds)
  const folderIdSet = new Set(folderIds)

  settings.folders = settings.folders.filter((item) => !folderIdSet.has(item.id))
  settings.journals = settings.journals.filter((item) => !journalIdSet.has(item.id))
  entries = entries.filter((entry) => !journalIdSet.has(entry.journalId))

  for (const id of folderIds) {
    collapsedFolderIds.delete(id)
  }

  if (journalIdSet.has(settings.selectedJournalId)) {
    settings.selectedJournalId = settings.journals[0].id
    selectedDayKey = null
  }

  if (editingId && !entries.some((entry) => entry.id === editingId)) {
    editingId = null
    inputEl.value = ''
    resetComposerHeight()
  }

  persistCollapsedFolders()
  saveSettings()
  saveEntries()
  render()
}

function toggleFolder(folderId) {
  if (collapsedFolderIds.has(folderId)) {
    collapsedFolderIds.delete(folderId)
  } else {
    collapsedFolderIds.add(folderId)
  }
  persistCollapsedFolders()
  render({ preserveScroll: true })
}

function selectJournal(journalId) {
  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  let expandedPath = false
  let currentId = journal.parentId
  while (currentId) {
    if (collapsedFolderIds.has(currentId)) {
      collapsedFolderIds.delete(currentId)
      expandedPath = true
    }
    const folder = settings.folders.find((item) => item.id === currentId)
    currentId = folder?.parentId ?? null
  }
  if (expandedPath) persistCollapsedFolders()

  if (settings.selectedJournalId === journalId) {
    if (expandedPath) render({ preserveScroll: true })
    return
  }

  settings.selectedJournalId = journalId
  selectedDayKey = null
  saveSettings()
  render()
}

function renderEntry(entry) {
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
}

function renderDayGroup(group, { showHeader = true } = {}) {
  const header = showHeader
    ? `<h2 class="day-header">${escapeHtml(formatDayHeader(group.date))}</h2>`
    : ''

  return `
    <section class="day-group${showHeader ? '' : ' day-group-plain'}">
      ${header}
      ${group.entries.map(renderEntry).join('')}
    </section>
  `
}

function renderDaySidebar(groups) {
  if (groups.length === 0) {
    sidebarEl.innerHTML = `<p class="sidebar-empty">No days yet</p>`
    return
  }

  // Oldest at top → newest at bottom
  sidebarEl.innerHTML = groups
    .map((group) => {
      const lastEntry = group.entries[group.entries.length - 1]
      const active = group.key === selectedDayKey ? ' is-active' : ''
      return `
        <button
          type="button"
          class="sidebar-item${active}"
          data-day-key="${escapeHtml(group.key)}"
        >
          <span class="sidebar-item-title">${escapeHtml(formatDayHeader(group.date))}</span>
          <span class="sidebar-item-preview">${escapeHtml(previewText(lastEntry.text))}</span>
        </button>
      `
    })
    .join('')
}

function renderDayJournalTabs() {
  journalTabsEl.hidden = false
  journalTabsEl.innerHTML = getJournalsDepthFirst()
    .map((journal) => {
      const active =
        journal.id === settings.selectedJournalId ? ' is-active' : ''
      const path = getJournalPathLabel(journal)
      return `
        <button
          type="button"
          class="journal-tab${active}"
          data-journal-id="${escapeHtml(journal.id)}"
          data-action="select-journal"
          title="${escapeHtml(path)}"
        >${escapeHtml(journal.name)}</button>
      `
    })
    .join('')
}

function hideDayJournalTabs() {
  journalTabsEl.hidden = true
  journalTabsEl.innerHTML = ''
}

const ICON_EDIT = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>`
const ICON_DELETE = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>`
const ICON_CHEVRON = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.41 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.7 6.7a1 1 0 0 0-1.41.01z" /></svg>`

function renderTreeFolder(node) {
  const canDelete = canDeleteFolder(node.id)
  const expandedClass = node.expanded ? ' is-expanded' : ''
  return `
    <div
      class="sidebar-tree-row sidebar-folder${expandedClass}"
      data-folder-id="${escapeHtml(node.id)}"
      style="--depth: ${node.depth}"
    >
      <button
        type="button"
        class="sidebar-tree-toggle"
        data-action="toggle-folder"
        aria-label="${node.expanded ? 'Collapse' : 'Expand'} ${escapeHtml(node.name)}"
        aria-expanded="${node.expanded ? 'true' : 'false'}"
      >${ICON_CHEVRON}</button>
      <button
        type="button"
        class="sidebar-item sidebar-item-tab"
        data-action="toggle-folder"
      >
        <span class="sidebar-item-title">${escapeHtml(node.name)}</span>
      </button>
      <div class="sidebar-row-actions">
        <button
          type="button"
          class="sidebar-row-action"
          data-action="edit-folder"
          data-label="Rename"
          aria-label="Rename ${escapeHtml(node.name)}"
        >${ICON_EDIT}</button>
        <button
          type="button"
          class="sidebar-row-action"
          data-action="delete-folder"
          data-label="Delete"
          aria-label="Delete ${escapeHtml(node.name)}"
          ${canDelete ? '' : 'disabled'}
        >${ICON_DELETE}</button>
      </div>
    </div>
  `
}

function renderTreeJournal(node) {
  const active =
    node.id === settings.selectedJournalId ? ' is-active' : ''
  const canDelete = canDeleteJournal(node.id)
  return `
    <div
      class="sidebar-tree-row sidebar-journal${active}"
      data-journal-id="${escapeHtml(node.id)}"
      style="--depth: ${node.depth}"
      draggable="true"
    >
      <span class="sidebar-tree-spacer" aria-hidden="true"></span>
      <button
        type="button"
        class="sidebar-item sidebar-item-tab"
        data-action="select-journal"
      >
        <span class="sidebar-item-title">${escapeHtml(node.name)}</span>
      </button>
      <div class="sidebar-row-actions">
        <button
          type="button"
          class="sidebar-row-action"
          data-action="edit-journal"
          data-label="Rename"
          aria-label="Rename ${escapeHtml(node.name)}"
        >${ICON_EDIT}</button>
        <button
          type="button"
          class="sidebar-row-action"
          data-action="delete-journal"
          data-label="Delete"
          aria-label="Delete ${escapeHtml(node.name)}"
          ${canDelete ? '' : 'disabled'}
        >${ICON_DELETE}</button>
      </div>
    </div>
  `
}

function renderTimelineSidebar() {
  const nodes = getTreeNodes()

  sidebarEl.innerHTML = `
    <div class="sidebar-list">
      ${nodes
        .map((node) =>
          node.type === 'folder'
            ? renderTreeFolder(node)
            : renderTreeJournal(node),
        )
        .join('')}
    </div>
    <div
      class="sidebar-root-drop"
      data-drop-root
      aria-label="Move journal to top level"
    >
      Move to top level
    </div>
    <button type="button" class="sidebar-add" data-action="add-journal">
      + New journal
    </button>
  `
}

function renderFeedForDay(groups) {
  const group = groups.find((item) => item.key === selectedDayKey)
  if (!group) {
    feedEl.innerHTML = `<p class="feed-empty">No entries for this day</p>`
    return
  }

  feedEl.innerHTML = renderDayGroup(group, { showHeader: false })
}

function renderTimelineFeed(groups) {
  if (groups.length === 0) {
    feedEl.innerHTML = `<p class="feed-empty">No entries yet</p>`
    return
  }

  feedEl.innerHTML = groups
    .map((group) => renderDayGroup(group, { showHeader: true }))
    .join('')
}

function updateSettingsMenu() {
  for (const item of settingsMenuEl.querySelectorAll('[data-view-mode]')) {
    const checked = item.dataset.viewMode === settings.viewMode
    item.classList.toggle('is-active', checked)
    item.setAttribute('aria-checked', checked ? 'true' : 'false')
  }
}

function render({ preserveScroll = false } = {}) {
  const scrollTop = feedEl.scrollTop
  ensureSelectedJournal()
  const groups = getDayGroups()

  appEl.dataset.mode = settings.viewMode
  updateSettingsMenu()

  if (settings.viewMode === VIEW_MODE_DAY) {
    ensureSelectedDay(groups)
    renderDayJournalTabs()
    renderDaySidebar(groups)
    renderFeedForDay(groups)
  } else {
    hideDayJournalTabs()
    renderTimelineSidebar()
    renderTimelineFeed(groups)
  }

  if (settings.viewMode === VIEW_MODE_TIMELINE) {
    feedEl.scrollTop = preserveScroll ? scrollTop : feedEl.scrollHeight
  } else if (!preserveScroll) {
    feedEl.scrollTop = 0
  } else {
    feedEl.scrollTop = scrollTop
  }
}

function openSettingsMenu() {
  settingsMenuEl.hidden = false
  settingsOpenEl.setAttribute('aria-expanded', 'true')
}

function closeSettingsMenu() {
  settingsMenuEl.hidden = true
  settingsOpenEl.setAttribute('aria-expanded', 'false')
}

function toggleSettingsMenu() {
  if (settingsMenuEl.hidden) {
    openSettingsMenu()
  } else {
    closeSettingsMenu()
  }
}

function setViewMode(mode) {
  if (mode !== VIEW_MODE_DAY && mode !== VIEW_MODE_TIMELINE) return
  if (settings.viewMode === mode) {
    closeSettingsMenu()
    return
  }

  settings.viewMode = mode
  saveSettings()
  closeSettingsMenu()
  render()
}

function submitEntry(text = inputEl.value) {
  const trimmed = text.trim()
  if (!trimmed) return

  if (editingId) {
    const entry = entries.find((item) => item.id === editingId)
    if (entry) {
      entry.text = trimmed
      selectedDayKey = getDayKey(new Date(entry.createdAt))
    }
    editingId = null
  } else {
    const entry = createEntry(trimmed)
    entries.push(entry)
    selectedDayKey = getDayKey(new Date(entry.createdAt))
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

  const entry = createEntry(trimmed)
  entries.push(entry)
  selectedDayKey = getDayKey(new Date(entry.createdAt))
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

  if (event.key === 'Escape' && nameSession) {
    event.preventDefault()
    closeNameSheet()
    return
  }

  if (event.key === 'Escape' && !contextMenuEl.hidden) {
    event.preventDefault()
    closeContextMenu()
    return
  }

  if (event.key === 'Escape' && !settingsMenuEl.hidden) {
    event.preventDefault()
    closeSettingsMenu()
    return
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !backdateSession &&
    !nameSession &&
    contextMenuEl.hidden
  ) {
    const typing = isTypingTarget(event.target)
    const composerIdle =
      event.target === inputEl && inputEl.value.trim() === '' && !editingId

    if (!typing || composerIdle) {
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        setViewMode(VIEW_MODE_TIMELINE)
        return
      }
      if (event.key === 'd' || event.key === 'D') {
        event.preventDefault()
        setViewMode(VIEW_MODE_DAY)
        return
      }
    }
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

document.addEventListener('pointerdown', (event) => {
  if (!contextMenuEl.hidden && !contextMenuEl.contains(event.target)) {
    closeContextMenu()
  }

  if (settingsMenuEl.hidden) return
  if (settingsWrapEl.contains(event.target)) return
  closeSettingsMenu()
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

settingsOpenEl.addEventListener('click', (event) => {
  event.stopPropagation()
  toggleSettingsMenu()
})

settingsMenuEl.addEventListener('click', (event) => {
  const item = event.target.closest('[data-view-mode]')
  if (!item || !settingsMenuEl.contains(item)) return
  setViewMode(item.dataset.viewMode)
})

journalTabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-action="select-journal"]')
  if (!tab || !journalTabsEl.contains(tab)) return
  selectJournal(tab.dataset.journalId)
})

contextMenuEl.addEventListener('click', (event) => {
  const item = event.target.closest('[data-action]')
  if (!item || !contextMenuEl.contains(item)) return
  handleContextMenuAction(item.dataset.action, item.dataset.folderId ?? null)
})

sidebarEl.addEventListener('contextmenu', (event) => {
  if (settings.viewMode !== VIEW_MODE_TIMELINE) return

  const journalEl = event.target.closest('.sidebar-journal[data-journal-id]')
  if (!journalEl || !sidebarEl.contains(journalEl)) return

  event.preventDefault()
  openJournalContextMenu(
    journalEl.dataset.journalId,
    event.clientX,
    event.clientY,
  )
})

sidebarEl.addEventListener('click', (event) => {
  const dayButton = event.target.closest('[data-day-key]')
  if (dayButton && sidebarEl.contains(dayButton)) {
    selectedDayKey = dayButton.dataset.dayKey
    render({ preserveScroll: true })
    return
  }

  const actionButton = event.target.closest('[data-action]')
  if (!actionButton || !sidebarEl.contains(actionButton)) return

  const action = actionButton.dataset.action
  const folderEl = actionButton.closest('[data-folder-id]')
  const journalEl = actionButton.closest('[data-journal-id]')
  const folderId = folderEl?.dataset.folderId ?? null
  const journalId = journalEl?.dataset.journalId ?? null

  if (action === 'add-journal') {
    openNameSheet({
      mode: 'create',
      kind: 'journal',
      parentId: null,
      name: '',
    })
    return
  }

  if (action === 'toggle-folder') {
    if (!folderId) return
    toggleFolder(folderId)
    return
  }

  if (action === 'edit-folder') {
    const folder = settings.folders.find((item) => item.id === folderId)
    if (!folder) return
    openNameSheet({
      mode: 'edit',
      kind: 'folder',
      folderId: folder.id,
      name: folder.name,
    })
    return
  }

  if (action === 'delete-folder') {
    if (!folderId) return
    deleteFolder(folderId)
    return
  }

  if (!journalId) return

  if (action === 'select-journal') {
    selectJournal(journalId)
  } else if (action === 'edit-journal') {
    const journal = settings.journals.find((item) => item.id === journalId)
    if (!journal) return
    openNameSheet({
      mode: 'edit',
      kind: 'journal',
      journalId: journal.id,
      name: journal.name,
    })
  } else if (action === 'delete-journal') {
    deleteJournal(journalId)
  }
})

sidebarEl.addEventListener('dragstart', (event) => {
  if (settings.viewMode !== VIEW_MODE_TIMELINE) return

  const row = event.target.closest('.sidebar-journal[data-journal-id]')
  if (!row || !sidebarEl.contains(row)) return

  if (event.target.closest('.sidebar-row-action')) {
    event.preventDefault()
    return
  }

  const journalId = row.dataset.journalId
  event.dataTransfer.setData('text/plain', journalId)
  event.dataTransfer.setData('application/x-journal-id', journalId)
  event.dataTransfer.effectAllowed = 'move'
  row.classList.add('is-dragging')
  sidebarEl.classList.add('is-dragging-journal')
})

sidebarEl.addEventListener('dragend', () => {
  clearSidebarDropState()
})

sidebarEl.addEventListener('dragover', (event) => {
  if (!sidebarEl.classList.contains('is-dragging-journal')) return

  const folderEl = event.target.closest('.sidebar-folder[data-folder-id]')
  const rootEl = event.target.closest('[data-drop-root]')

  for (const el of sidebarEl.querySelectorAll('.is-drop-target')) {
    el.classList.remove('is-drop-target')
  }

  if (folderEl && sidebarEl.contains(folderEl)) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    folderEl.classList.add('is-drop-target')
    return
  }

  if (rootEl && sidebarEl.contains(rootEl)) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    rootEl.classList.add('is-drop-target')
  }
})

sidebarEl.addEventListener('dragleave', (event) => {
  const leaving = event.target.closest('.is-drop-target')
  if (!leaving || !sidebarEl.contains(leaving)) return
  if (leaving.contains(event.relatedTarget)) return
  leaving.classList.remove('is-drop-target')
})

sidebarEl.addEventListener('drop', (event) => {
  if (!sidebarEl.classList.contains('is-dragging-journal')) return

  const folderEl = event.target.closest('.sidebar-folder[data-folder-id]')
  const rootEl = event.target.closest('[data-drop-root]')

  let parentId = undefined
  if (folderEl && sidebarEl.contains(folderEl)) {
    parentId = folderEl.dataset.folderId
  } else if (rootEl && sidebarEl.contains(rootEl)) {
    parentId = null
  } else {
    clearSidebarDropState()
    return
  }

  event.preventDefault()

  const journalId =
    event.dataTransfer.getData('application/x-journal-id') ||
    event.dataTransfer.getData('text/plain')

  clearSidebarDropState()

  if (!journalId) return
  if (!moveJournal(journalId, parentId)) return
  render({ preserveScroll: true })
})

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

nameCancelEl.addEventListener('click', closeNameSheet)

nameConfirmEl.addEventListener('click', confirmNameSheet)

nameSheetEl.addEventListener('click', (event) => {
  if (event.target === nameSheetEl) {
    closeNameSheet()
  }
})

nameInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  confirmNameSheet()
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
