const STORAGE_KEY = 'journal-mvp:entries'
const ENTRY_KIND_ENTRY = 'entry'
const ENTRY_KIND_ANNOUNCEMENT = 'announcement'
const SETTINGS_KEY = 'journal-mvp:settings'
const VIEW_MODE_TIMELINE = 'timeline'
const DEFAULT_JOURNAL_ID = 'journal-default'
const PERSIST_DEBOUNCE_MS = 400
const TRANSFER_POLL_MS = 2500

const supabase = window.supabase.createClient(
  window.JOURNAL_SUPABASE.url,
  window.JOURNAL_SUPABASE.anonKey,
  {
    // No auth in this MVP — skip session storage so Tracking Prevention
    // (Safari/Edge) can't block the client when the library is third-party.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  },
)

let journalPersistTimer = null
let journalPersistChain = Promise.resolve()
/** Explicit remote deletes only — never wipe unknown remote rows (e.g. Draft transfers). */
/** @type {Set<string>} */
const pendingRemoteDeletes = new Set()
/** Entry ids that should slide in from the left on next paint. */
/** @type {Set<string>} */
const pendingTransferEnterIds = new Set()
let transferPollTimer = null

const appEl = document.getElementById('app')
const sidebarEl = document.getElementById('sidebar')
const journalViewEl = document.getElementById('journal-view')
const feedEl = document.getElementById('feed')
const composerEl = document.getElementById('composer')
const inputEl = document.getElementById('entry-input')
const pasteBtnEl = document.getElementById('paste-btn')
const composerQuoteEl = document.getElementById('composer-quote')
const composerQuoteMetaEl = document.getElementById('composer-quote-meta')
const composerQuoteClampEl = document.getElementById('composer-quote-clamp')
const composerQuoteTextEl = document.getElementById('composer-quote-text')
const composerQuoteToggleEl = document.getElementById('composer-quote-toggle')
const composerQuoteDismissEl = document.getElementById('composer-quote-dismiss')
const settingsOpenEl = document.getElementById('settings-open')
const settingsCloseEl = document.getElementById('settings-close')
const settingsViewEl = document.getElementById('settings-view')
const showWeekdayEl = document.getElementById('show-weekday')
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

let settings = normalizeSettings(null)
let entries = []
let editingId = null
/** @type {{ text: string, sourceId: string, createdAt?: string } | null} */
let pendingQuote = null
let bHeld = false
let hHeld = false
let backdateSession = null
let nameSession = null
/** @type {'journal' | 'settings'} */
let currentView = 'journal'
/** @type {'journal' | 'entry' | null} */
let contextMenuKind = null
let contextMenuJournalId = null
let contextMenuEntryId = null
/** Entry whose edit-history panel is open. */
let historyEntryId = null
/** Expanded history row index within the open panel, or null. */
let historyExpandedIndex = null
/** Entry ids whose quoted text is fully expanded. */
/** @type {Set<string>} */
const expandedQuoteIds = new Set()
/** Whether the composer quote preview is fully expanded. */
let composerQuoteExpanded = false
/** Avoid re-touching the same journal on every composer keystroke. */
let lastMarkedUsedJournalId = null
/** @type {Set<string>} */
const collapsedFolderIds = new Set()

function createDefaultJournal() {
  return {
    id: DEFAULT_JOURNAL_ID,
    name: 'Journal',
    parentId: null,
    lastUsedAt: null,
  }
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

function normalizeLastUsedAt(value) {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return value
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
    lastUsedAt: normalizeLastUsedAt(journal.lastUsedAt),
  }
}

function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return null
  if (typeof quote.text !== 'string') return null
  const text = quote.text.trim()
  if (!text) return null

  const normalized = { text }

  if (typeof quote.sourceId === 'string' && quote.sourceId) {
    normalized.sourceId = quote.sourceId
  }

  if (typeof quote.createdAt === 'string') {
    const date = new Date(quote.createdAt)
    if (!Number.isNaN(date.getTime())) {
      normalized.createdAt = quote.createdAt
    }
  }

  return normalized
}

function normalizeCopiedFrom(copiedFrom) {
  if (!copiedFrom || typeof copiedFrom !== 'object') return null
  if (typeof copiedFrom.sourceId !== 'string' || !copiedFrom.sourceId) {
    return null
  }

  const normalized = { sourceId: copiedFrom.sourceId }

  if (typeof copiedFrom.createdAt === 'string') {
    const date = new Date(copiedFrom.createdAt)
    if (!Number.isNaN(date.getTime())) {
      normalized.createdAt = copiedFrom.createdAt
    }
  }

  return normalized
}

function normalizeMovedFrom(movedFrom) {
  if (!movedFrom || typeof movedFrom !== 'object') return null

  const journalName =
    typeof movedFrom.journalName === 'string' ? movedFrom.journalName.trim() : ''
  if (!journalName) return null

  const normalized = { journalName }

  if (typeof movedFrom.journalId === 'string' && movedFrom.journalId) {
    normalized.journalId = movedFrom.journalId
  }

  if (typeof movedFrom.movedAt === 'string') {
    const movedAt = new Date(movedFrom.movedAt)
    if (!Number.isNaN(movedAt.getTime())) {
      normalized.movedAt = movedFrom.movedAt
    }
  }

  if (typeof movedFrom.createdAt === 'string') {
    const createdAt = new Date(movedFrom.createdAt)
    if (!Number.isNaN(createdAt.getTime())) {
      normalized.createdAt = movedFrom.createdAt
    }
  }

  return normalized
}

function normalizeTransferredFrom(transferredFrom) {
  if (!transferredFrom || typeof transferredFrom !== 'object') return null

  const sourceApp =
    typeof transferredFrom.sourceApp === 'string'
      ? transferredFrom.sourceApp.trim()
      : ''
  if (!sourceApp) return null

  const normalized = { sourceApp }

  if (typeof transferredFrom.transferId === 'string' && transferredFrom.transferId) {
    normalized.transferId = transferredFrom.transferId
  }

  if (
    typeof transferredFrom.destinationApp === 'string' &&
    transferredFrom.destinationApp.trim()
  ) {
    normalized.destinationApp = transferredFrom.destinationApp.trim()
  }

  if (
    typeof transferredFrom.sourceEntryId === 'string' &&
    transferredFrom.sourceEntryId
  ) {
    normalized.sourceEntryId = transferredFrom.sourceEntryId
  }

  if (typeof transferredFrom.transferredAt === 'string') {
    const transferredAt = new Date(transferredFrom.transferredAt)
    if (!Number.isNaN(transferredAt.getTime())) {
      normalized.transferredAt = transferredFrom.transferredAt
    }
  }

  if (typeof transferredFrom.createdAt === 'string') {
    const createdAt = new Date(transferredFrom.createdAt)
    if (!Number.isNaN(createdAt.getTime())) {
      normalized.createdAt = transferredFrom.createdAt
    }
  }

  return normalized
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null
  if (typeof item.text !== 'string' || typeof item.editedAt !== 'string') return null

  const date = new Date(item.editedAt)
  if (Number.isNaN(date.getTime())) return null

  return {
    editedAt: item.editedAt,
    text: item.text,
  }
}

function getQuoteCreatedAt(quote) {
  if (!quote) return null

  if (typeof quote.createdAt === 'string') {
    const date = new Date(quote.createdAt)
    if (!Number.isNaN(date.getTime())) return quote.createdAt
  }

  if (quote.sourceId) {
    const source = entries.find((item) => item.id === quote.sourceId)
    if (source) return source.createdAt
  }

  return null
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

  const normalized = {
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt,
    journalId,
  }

  if (entry.kind === ENTRY_KIND_ANNOUNCEMENT) {
    normalized.kind = ENTRY_KIND_ANNOUNCEMENT
  }

  const quote = normalizeQuote(entry.quote)
  if (quote) normalized.quote = quote

  const copiedFrom = normalizeCopiedFrom(entry.copiedFrom)
  if (copiedFrom) normalized.copiedFrom = copiedFrom

  const movedFrom = normalizeMovedFrom(entry.movedFrom)
  if (movedFrom) normalized.movedFrom = movedFrom

  const transferredFrom = normalizeTransferredFrom(entry.transferredFrom)
  if (transferredFrom) normalized.transferredFrom = transferredFrom

  if (Array.isArray(entry.history)) {
    const history = entry.history.map(normalizeHistoryItem).filter(Boolean)
    if (history.length > 0) normalized.history = history
  }

  return normalized
}

function loadEntriesFromLocal() {
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

function writeEntriesLocal(nextEntries = entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEntries))
}

function folderRowFromState(folder) {
  return {
    id: folder.id,
    name: folder.name,
    parent_id: folder.parentId || null,
  }
}

function folderFromRow(row) {
  return normalizeFolder({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
  })
}

function journalRowFromState(journal) {
  return {
    id: journal.id,
    name: journal.name,
    parent_id: journal.parentId || null,
    last_used_at: journal.lastUsedAt || null,
  }
}

function journalFromRow(row) {
  return normalizeJournal({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    lastUsedAt: row.last_used_at,
  })
}

function entryRowFromState(entry) {
  return {
    id: entry.id,
    journal_id: entry.journalId,
    text: entry.text,
    created_at: entry.createdAt,
    kind:
      entry.kind === ENTRY_KIND_ANNOUNCEMENT
        ? ENTRY_KIND_ANNOUNCEMENT
        : ENTRY_KIND_ENTRY,
    quote: entry.quote || null,
    copied_from: entry.copiedFrom || null,
    moved_from: entry.movedFrom || null,
    transferred_from: entry.transferredFrom || null,
    history: Array.isArray(entry.history) ? entry.history : [],
    updated_at: new Date().toISOString(),
  }
}

function entryFromRow(row, fallbackJournalId) {
  return normalizeEntry(
    {
      id: row.id,
      text: row.text,
      createdAt: row.created_at,
      journalId: row.journal_id,
      kind: row.kind || undefined,
      quote: row.quote || undefined,
      copiedFrom: row.copied_from || undefined,
      movedFrom: row.moved_from || undefined,
      transferredFrom: row.transferred_from || undefined,
      history: row.history || undefined,
    },
    fallbackJournalId,
  )
}

/** Parents before children so self-FK upserts succeed. */
function sortFoldersForUpsert(folders) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const sorted = []
  const visiting = new Set()
  const visited = new Set()

  function visit(id) {
    if (visited.has(id) || !byId.has(id)) return
    if (visiting.has(id)) return
    visiting.add(id)
    const folder = byId.get(id)
    if (folder.parentId) visit(folder.parentId)
    visiting.delete(id)
    visited.add(id)
    sorted.push(folder)
  }

  for (const folder of folders) visit(folder.id)
  return sorted
}

function isDefaultRemoteSeed(folders, journals, settingsRow, entryCount) {
  if (entryCount > 0) return false
  if (folders.length > 0) return false
  if (journals.length !== 1) return false
  const only = journals[0]
  if (!only || only.id !== DEFAULT_JOURNAL_ID || only.name !== 'Journal') return false
  if (only.parentId) return false
  if (!settingsRow) return true
  if (settingsRow.view_mode !== VIEW_MODE_TIMELINE) return false
  if (settingsRow.selected_journal_id !== DEFAULT_JOURNAL_ID) return false
  if (settingsRow.show_weekday === true) return false
  const collapsed = settingsRow.collapsed_folder_ids
  if (Array.isArray(collapsed) && collapsed.length > 0) return false
  return true
}

async function loadJournalStateFromSupabase() {
  const [
    { data: folderRows, error: foldersError },
    { data: journalRows, error: journalsError },
    { data: settingsRow, error: settingsError },
    { data: entryRows, error: entriesError },
  ] = await Promise.all([
    supabase.from('journal_folders').select('*'),
    supabase.from('journal_journals').select('*'),
    supabase.from('journal_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('journal_entries').select('*').order('created_at', { ascending: true }),
  ])

  if (foldersError) throw foldersError
  if (journalsError) throw journalsError
  if (settingsError) throw settingsError
  if (entriesError) throw entriesError

  const folders = (folderRows || []).map(folderFromRow).filter(Boolean)
  const journals = (journalRows || []).map(journalFromRow).filter(Boolean)
  const fallbackJournalId = journals[0]?.id ?? DEFAULT_JOURNAL_ID
  const nextEntries = (entryRows || [])
    .map((row) => entryFromRow(row, fallbackJournalId))
    .filter(Boolean)

  if (isDefaultRemoteSeed(folders, journals, settingsRow, nextEntries.length)) {
    return null
  }

  const localSettings = loadSettingsFromLocal()
  const nextSettings = normalizeSettings({
    showWeekday:
      typeof settingsRow?.show_weekday === 'boolean'
        ? settingsRow.show_weekday
        : localSettings.showWeekday,
    folders,
    journals,
    selectedJournalId: settingsRow?.selected_journal_id,
    collapsedFolderIds: settingsRow?.collapsed_folder_ids,
  })

  return { settings: nextSettings, entries: nextEntries }
}

async function loadJournalState() {
  try {
    const remote = await loadJournalStateFromSupabase()
    if (remote) {
      writeSettingsLocal(remote.settings)
      writeEntriesLocal(remote.entries)
      return remote
    }
  } catch (err) {
    console.error('Failed to load journal from Supabase:', err)
  }

  const localSettings = loadSettingsFromLocal()
  // Temporary assign so loadEntriesFromLocal can read journal ids.
  settings = localSettings
  return {
    settings: localSettings,
    entries: loadEntriesFromLocal(),
  }
}

async function persistEntriesToSupabase(nextEntries = entries, options = {}) {
  const deleteIds = Array.isArray(options.deleteIds) ? options.deleteIds : []
  const replaceAll = options.replaceAll === true

  if (replaceAll) {
    const desiredIds = new Set(nextEntries.map((entry) => entry.id))
    const { data: existing, error: existingError } = await supabase
      .from('journal_entries')
      .select('id')
    if (existingError) throw existingError

    const toDelete = (existing || [])
      .map((row) => row.id)
      .filter((id) => !desiredIds.has(id))
    if (toDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from('journal_entries')
        .delete()
        .in('id', toDelete)
      if (deleteError) throw deleteError
    }
  } else if (deleteIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('journal_entries')
      .delete()
      .in('id', deleteIds)
    if (deleteError) throw deleteError
  }

  if (nextEntries.length === 0) return

  const { error: upsertError } = await supabase
    .from('journal_entries')
    .upsert(nextEntries.map(entryRowFromState))
  if (upsertError) throw upsertError
}

function queueRemoteDelete(id) {
  if (typeof id === 'string' && id) pendingRemoteDeletes.add(id)
}

function queueRemoteDeletes(ids) {
  for (const id of ids) queueRemoteDelete(id)
}

async function persistSettingsToSupabase(nextSettings = settings) {
  const folders = sortFoldersForUpsert(nextSettings.folders)
  const journals = nextSettings.journals
  const folderIds = new Set(folders.map((folder) => folder.id))
  const journalIds = new Set(journals.map((journal) => journal.id))

  const [{ data: existingFolders, error: existingFoldersError }, { data: existingJournals, error: existingJournalsError }] =
    await Promise.all([
      supabase.from('journal_folders').select('id'),
      supabase.from('journal_journals').select('id'),
    ])
  if (existingFoldersError) throw existingFoldersError
  if (existingJournalsError) throw existingJournalsError

  if (folders.length > 0) {
    const { error: upsertFoldersError } = await supabase
      .from('journal_folders')
      .upsert(folders.map(folderRowFromState))
    if (upsertFoldersError) throw upsertFoldersError
  }

  if (journals.length > 0) {
    const { error: upsertJournalsError } = await supabase
      .from('journal_journals')
      .upsert(journals.map(journalRowFromState))
    if (upsertJournalsError) throw upsertJournalsError
  }

  const settingsPayload = {
    id: 1,
    view_mode: VIEW_MODE_TIMELINE,
    show_weekday: !!nextSettings.showWeekday,
    selected_journal_id: nextSettings.selectedJournalId,
    collapsed_folder_ids: nextSettings.collapsedFolderIds || [],
    updated_at: new Date().toISOString(),
  }
  let { error: settingsError } = await supabase
    .from('journal_settings')
    .upsert(settingsPayload)
  if (settingsError && /show_weekday/i.test(settingsError.message || '')) {
    const { show_weekday, ...withoutWeekday } = settingsPayload
    ;({ error: settingsError } = await supabase
      .from('journal_settings')
      .upsert(withoutWeekday))
  }
  if (settingsError) throw settingsError

  const journalsToDelete = (existingJournals || [])
    .map((row) => row.id)
    .filter((id) => !journalIds.has(id))
  if (journalsToDelete.length > 0) {
    const { error: deleteJournalsError } = await supabase
      .from('journal_journals')
      .delete()
      .in('id', journalsToDelete)
    if (deleteJournalsError) throw deleteJournalsError
  }

  const foldersToDelete = (existingFolders || [])
    .map((row) => row.id)
    .filter((id) => !folderIds.has(id))
  if (foldersToDelete.length > 0) {
    const { error: deleteFoldersError } = await supabase
      .from('journal_folders')
      .delete()
      .in('id', foldersToDelete)
    if (deleteFoldersError) throw deleteFoldersError
  }
}

function queueJournalPersist() {
  writeSettingsLocal()
  writeEntriesLocal()
  if (journalPersistTimer) clearTimeout(journalPersistTimer)
  journalPersistTimer = setTimeout(() => {
    journalPersistTimer = null
    const settingsSnapshot = structuredClone(settings)
    const entriesSnapshot = structuredClone(entries)
    const deleteIdsSnapshot = [...pendingRemoteDeletes]
    journalPersistChain = journalPersistChain
      .then(async () => {
        // Folders/journals first so entry FKs stay valid.
        await persistSettingsToSupabase(settingsSnapshot)
        await persistEntriesToSupabase(entriesSnapshot, {
          deleteIds: deleteIdsSnapshot,
        })
        for (const id of deleteIdsSnapshot) pendingRemoteDeletes.delete(id)
      })
      .catch((err) => console.error('Failed to save journal to Supabase:', err))
  }, PERSIST_DEBOUNCE_MS)
}

function saveEntries() {
  queueJournalPersist()
}

function normalizeSettings(value) {
  const showWeekday = value?.showWeekday === true

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
    showWeekday,
    folders,
    journals,
    selectedJournalId,
    collapsedFolderIds,
  }
}

function loadSettingsFromLocal() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return normalizeSettings(null)
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(null)
  }
}

function writeSettingsLocal(nextSettings = settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings))
}

function saveSettings() {
  queueJournalPersist()
}

function localHasJournalData() {
  const localSettings = loadSettingsFromLocal()
  const previousSettings = settings
  settings = localSettings
  const localEntries = loadEntriesFromLocal()
  settings = previousSettings

  const hasExtraJournals =
    localSettings.journals.length > 1 ||
    localSettings.journals.some(
      (journal) =>
        journal.id !== DEFAULT_JOURNAL_ID || journal.name !== 'Journal' || journal.parentId,
    )
  const hasFolders = localSettings.folders.length > 0
  const hasCustomSettings =
    localSettings.showWeekday ||
    localSettings.selectedJournalId !== DEFAULT_JOURNAL_ID ||
    localSettings.collapsedFolderIds.length > 0

  return localEntries.length > 0 || hasExtraJournals || hasFolders || hasCustomSettings
}

async function remoteHasJournalData() {
  const [
    { count: entryCount, error: entryError },
    { count: folderCount, error: folderError },
    { count: journalCount, error: journalError },
  ] = await Promise.all([
    supabase.from('journal_entries').select('id', { count: 'exact', head: true }),
    supabase.from('journal_folders').select('id', { count: 'exact', head: true }),
    supabase.from('journal_journals').select('id', { count: 'exact', head: true }),
  ])
  if (entryError) throw entryError
  if (folderError) throw folderError
  if (journalError) throw journalError

  if ((entryCount || 0) > 0) return true
  if ((folderCount || 0) > 0) return true
  if ((journalCount || 0) > 1) return true

  const { data: settingsRow, error: settingsError } = await supabase
    .from('journal_settings')
    .select('view_mode, selected_journal_id, collapsed_folder_ids, show_weekday')
    .eq('id', 1)
    .maybeSingle()
  if (settingsError) {
    // Older DBs may not have show_weekday yet.
    if (/show_weekday/i.test(settingsError.message || '')) {
      const { data: fallbackRow, error: fallbackError } = await supabase
        .from('journal_settings')
        .select('view_mode, selected_journal_id, collapsed_folder_ids')
        .eq('id', 1)
        .maybeSingle()
      if (fallbackError) throw fallbackError
      const { data: journals, error: journalsError } = await supabase
        .from('journal_journals')
        .select('id, name, parent_id')
      if (journalsError) throw journalsError
      const mapped = (journals || []).map(journalFromRow).filter(Boolean)
      return !isDefaultRemoteSeed([], mapped, fallbackRow, 0)
    }
    throw settingsError
  }

  const { data: journals, error: journalsError } = await supabase
    .from('journal_journals')
    .select('id, name, parent_id')
  if (journalsError) throw journalsError

  const mapped = (journals || []).map(journalFromRow).filter(Boolean)
  return !isDefaultRemoteSeed([], mapped, settingsRow, 0)
}

async function migrateFromLocalStorageIfNeeded() {
  if (!localHasJournalData()) return
  if (await remoteHasJournalData()) return

  console.info('Migrating journal localStorage → Supabase…')
  const localSettings = loadSettingsFromLocal()
  settings = localSettings
  const localEntries = loadEntriesFromLocal()
  await persistSettingsToSupabase(localSettings)
  await persistEntriesToSupabase(localEntries, { replaceAll: true })
  console.info('Migration complete.')
}

async function flushAllPendingPersists() {
  if (journalPersistTimer) {
    clearTimeout(journalPersistTimer)
    journalPersistTimer = null
    const settingsSnapshot = structuredClone(settings)
    const entriesSnapshot = structuredClone(entries)
    const deleteIdsSnapshot = [...pendingRemoteDeletes]
    journalPersistChain = journalPersistChain
      .then(async () => {
        await persistSettingsToSupabase(settingsSnapshot)
        await persistEntriesToSupabase(entriesSnapshot, {
          deleteIds: deleteIdsSnapshot,
        })
        for (const id of deleteIdsSnapshot) pendingRemoteDeletes.delete(id)
      })
      .catch((err) => console.error('Failed to save journal to Supabase:', err))
  }
  await journalPersistChain
}

function syncCollapsedFolderIdsFromSettings() {
  collapsedFolderIds.clear()
  for (const id of settings.collapsedFolderIds ?? []) {
    collapsedFolderIds.add(id)
  }
}

async function boot() {
  try {
    await migrateFromLocalStorageIfNeeded()
  } catch (err) {
    console.error('Migration failed:', err)
  }

  const loaded = await loadJournalState()
  settings = loaded.settings
  entries = loaded.entries
  syncCollapsedFolderIdsFromSettings()

  if (seedJournalLastUsedFromEntries()) {
    saveSettings()
  }

  render()
  resetComposerHeight()
  inputEl.focus()
  startTransferPolling()
}

/**
 * Pull any journal rows created outside this tab (e.g. Drafts → Journal transfers)
 * and merge them into local state without wiping local-only pending writes.
 */
async function mergeRemoteTransfers() {
  try {
    const fallbackJournalId = settings.journals[0]?.id ?? DEFAULT_JOURNAL_ID
    const { data: rows, error } = await supabase
      .from('journal_entries')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) throw error

    const localIds = new Set(entries.map((entry) => entry.id))
    const incoming = []
    for (const row of rows || []) {
      if (localIds.has(row.id)) continue
      if (pendingRemoteDeletes.has(row.id)) continue
      const entry = entryFromRow(row, fallbackJournalId)
      if (!entry) continue
      incoming.push(entry)
      if (entry.transferredFrom) {
        pendingTransferEnterIds.add(entry.id)
      }
    }

    if (incoming.length === 0) return false

    entries = [...entries, ...incoming]
    writeEntriesLocal()
    render()
    return true
  } catch (err) {
    console.warn('Failed to merge remote journal entries:', err)
    return false
  }
}

function startTransferPolling() {
  if (transferPollTimer) return
  transferPollTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void mergeRemoteTransfers()
  }, TRANSFER_POLL_MS)
}

window.addEventListener('beforeunload', () => {
  void flushAllPendingPersists()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void flushAllPendingPersists()
    return
  }
  void mergeRemoteTransfers()
})

window.addEventListener('focus', () => {
  void mergeRemoteTransfers()
})

function createEntry(text, createdAt = new Date().toISOString(), quote = null) {
  const entry = {
    id: crypto.randomUUID(),
    text,
    createdAt,
    journalId: settings.selectedJournalId,
  }
  const normalizedQuote = normalizeQuote(quote)
  if (normalizedQuote) entry.quote = normalizedQuote
  return entry
}

function isAnnouncementEntry(entry) {
  return entry?.kind === ENTRY_KIND_ANNOUNCEMENT
}

function createAnnouncementEntry(journalId, text, createdAt = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt,
    journalId,
    kind: ENTRY_KIND_ANNOUNCEMENT,
  }
}

function getEntryQuoteSnapshot(entry) {
  if (entry.quote?.text) {
    return `${entry.quote.text}\n\n${entry.text}`
  }
  return entry.text
}

function createJournal(name, parentId = null) {
  return {
    id: crypto.randomUUID(),
    name,
    parentId: parentId || null,
    lastUsedAt: new Date().toISOString(),
  }
}

function getJournalLastUsedMs(journal) {
  if (!journal?.lastUsedAt) return 0
  const ms = Date.parse(journal.lastUsedAt)
  return Number.isNaN(ms) ? 0 : ms
}

/** Seed missing lastUsedAt from each journal's newest entry activity. */
function seedJournalLastUsedFromEntries() {
  const latestByJournal = new Map()

  for (const entry of entries) {
    let latest = entry.createdAt
    if (Array.isArray(entry.history)) {
      for (const item of entry.history) {
        if (item.editedAt && item.editedAt > latest) latest = item.editedAt
      }
    }
    const prev = latestByJournal.get(entry.journalId)
    if (!prev || latest > prev) latestByJournal.set(entry.journalId, latest)
  }

  let changed = false
  for (const journal of settings.journals) {
    if (journal.lastUsedAt) continue
    const fromEntries = latestByJournal.get(journal.id)
    if (!fromEntries) continue
    journal.lastUsedAt = fromEntries
    changed = true
  }

  return changed
}

/**
 * Mark a journal as most recently used and re-sort the sidebar when needed.
 * Dedupes per journal until selection changes so typing does not thrash storage.
 */
function markJournalUsed(journalId) {
  if (!journalId || lastMarkedUsedJournalId === journalId) return

  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  const siblings = settings.journals.filter(
    (item) => item.parentId === journal.parentId,
  )
  const previousTopId = [...siblings].sort(compareJournalsByRecent)[0]?.id

  journal.lastUsedAt = new Date().toISOString()
  lastMarkedUsedJournalId = journalId
  saveSettings()

  if (previousTopId !== journalId) {
    render({ preserveScroll: true })
  }
}

function compareJournalsByRecent(a, b) {
  const diff = getJournalLastUsedMs(b) - getJournalLastUsedMs(a)
  if (diff !== 0) return diff
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
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
  return settings.journals
    .filter((journal) => journal.parentId === parentId)
    .sort(compareJournalsByRecent)
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

/** Journals in depth-first folder order. */
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
  const openEntry = feedEl.querySelector('.entry.is-menu-open')
  if (openEntry) openEntry.classList.remove('is-menu-open')

  contextMenuKind = null
  contextMenuJournalId = null
  contextMenuEntryId = null
  contextMenuEl.hidden = true
  contextMenuEl.innerHTML = ''
}

function positionContextMenu(clientX, clientY) {
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

function openJournalContextMenu(journalId, clientX, clientY) {
  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return

  closeContextMenu()
  closeSettings()
  contextMenuKind = 'journal'
  contextMenuJournalId = journalId
  contextMenuEntryId = null

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

  positionContextMenu(clientX, clientY)
}

function openEntryContextMenu(entryId, clientX, clientY) {
  const entry = entries.find((item) => item.id === entryId)
  if (!entry) return

  closeSettings()
  contextMenuKind = 'entry'
  contextMenuEntryId = entryId
  contextMenuJournalId = null

  for (const el of feedEl.querySelectorAll('.entry.is-menu-open')) {
    el.classList.remove('is-menu-open')
  }
  const entryEl = feedEl.querySelector(`.entry[data-id="${CSS.escape(entryId)}"]`)
  if (entryEl) entryEl.classList.add('is-menu-open')

  if (isAnnouncementEntry(entry)) {
    contextMenuEl.innerHTML = `
      <button
        type="button"
        class="context-menu-item is-danger"
        role="menuitem"
        data-action="delete"
      >Delete</button>
    `
    positionContextMenu(clientX, clientY)
    return
  }

  contextMenuEl.innerHTML = `
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="copy"
    >Copy</button>
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="copy-to-menu"
    >Copy to…</button>
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="move-to-menu"
    >Move to…</button>
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="edit"
    >Edit</button>
    <button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="build-on"
    >Build on</button>
    ${
      entry.history?.length
        ? `<button
      type="button"
      class="context-menu-item"
      role="menuitem"
      data-action="history"
    >History</button>`
        : ''
    }
    <div class="context-menu-separator" role="separator"></div>
    <button
      type="button"
      class="context-menu-item is-danger"
      role="menuitem"
      data-action="delete"
    >Delete</button>
  `

  positionContextMenu(clientX, clientY)
}

function openTransferToJournalMenu(entryId, mode) {
  const entry = entries.find((item) => item.id === entryId)
  if (!entry) return

  const action =
    mode === 'move' ? 'move-to-journal' : 'copy-to-journal'
  const label = mode === 'move' ? 'Move to journal' : 'Copy to journal'

  contextMenuKind = 'entry'
  contextMenuEntryId = entryId
  contextMenuJournalId = null

  const journals = getJournalsDepthFirst()
  const journalItems = journals
    .map((journal) => {
      const current = journal.id === entry.journalId
      return `
        <button
          type="button"
          class="context-menu-item${current ? ' is-current' : ''}"
          role="menuitem"
          data-action="${action}"
          data-journal-id="${escapeHtml(journal.id)}"
          ${current ? 'disabled aria-current="true"' : ''}
        >${escapeHtml(getJournalPathLabel(journal))}</button>
      `
    })
    .join('')

  const rect = contextMenuEl.getBoundingClientRect()
  contextMenuEl.innerHTML = `
    <div class="context-menu-section-label">${label}</div>
    ${journalItems}
  `
  positionContextMenu(rect.left, rect.top)
}

async function copyEntry(id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry) return

  try {
    await navigator.clipboard.writeText(entry.text)
  } catch {
    // Clipboard may be denied; ignore quietly.
  }
}

function focusEntryInJournal(entryId, journalId) {
  clearPendingQuote()
  editingId = null
  historyEntryId = null
  historyExpandedIndex = null
  inputEl.value = ''
  resetComposerHeight()

  expandFolderPathForJournal(journalId)
  settings.selectedJournalId = journalId

  saveSettings()
  render()

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      highlightAndScrollToEntry(entryId)
    })
  })
}

function copyEntryToJournal(entryId, targetJournalId) {
  const source = entries.find((item) => item.id === entryId)
  if (!source || isAnnouncementEntry(source)) return

  const targetJournal = settings.journals.find((item) => item.id === targetJournalId)
  if (!targetJournal) return
  if (source.journalId === targetJournalId) return

  const copy = {
    id: crypto.randomUUID(),
    text: source.text,
    createdAt: new Date().toISOString(),
    journalId: targetJournalId,
    copiedFrom: {
      sourceId: source.id,
      createdAt: source.createdAt,
    },
  }

  const quote = normalizeQuote(source.quote)
  if (quote) copy.quote = quote

  entries.push(copy)

  targetJournal.lastUsedAt = new Date().toISOString()
  lastMarkedUsedJournalId = targetJournalId

  saveEntries()
  focusEntryInJournal(copy.id, targetJournalId)
}

function moveEntryToJournal(entryId, targetJournalId) {
  const entry = entries.find((item) => item.id === entryId)
  if (!entry || isAnnouncementEntry(entry)) return

  const targetJournal = settings.journals.find((item) => item.id === targetJournalId)
  if (!targetJournal) return
  if (entry.journalId === targetJournalId) return

  const sourceJournal = settings.journals.find((item) => item.id === entry.journalId)
  const journalName = sourceJournal
    ? getJournalPathLabel(sourceJournal)
    : 'Unknown journal'

  entry.movedFrom = {
    journalId: entry.journalId,
    journalName,
    movedAt: new Date().toISOString(),
    createdAt: entry.createdAt,
  }
  entry.journalId = targetJournalId

  targetJournal.lastUsedAt = new Date().toISOString()
  lastMarkedUsedJournalId = targetJournalId

  saveEntries()
  focusEntryInJournal(entry.id, targetJournalId)
}

function handleContextMenuAction(action, folderId, targetJournalId) {
  const kind = contextMenuKind
  const journalId = contextMenuJournalId
  const entryId = contextMenuEntryId

  if (kind === 'entry' && action === 'copy-to-menu') {
    if (!entryId) {
      closeContextMenu()
      return
    }
    openTransferToJournalMenu(entryId, 'copy')
    return
  }

  if (kind === 'entry' && action === 'move-to-menu') {
    if (!entryId) {
      closeContextMenu()
      return
    }
    openTransferToJournalMenu(entryId, 'move')
    return
  }

  closeContextMenu()

  if (kind === 'entry') {
    if (!entryId) return
    if (action === 'copy') {
      copyEntry(entryId)
    } else if (action === 'copy-to-journal') {
      if (targetJournalId) copyEntryToJournal(entryId, targetJournalId)
    } else if (action === 'move-to-journal') {
      if (targetJournalId) moveEntryToJournal(entryId, targetJournalId)
    } else if (action === 'edit') {
      startEdit(entryId)
    } else if (action === 'build-on') {
      startBuildOn(entryId)
    } else if (action === 'history') {
      toggleEntryHistory(entryId)
    } else if (action === 'delete') {
      deleteEntry(entryId)
    }
    return
  }

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

function formatWeekday(date) {
  return [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ][date.getDay()]
}

function formatDayHeader(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = String(date.getFullYear()).slice(-2)
  const stamp = `${month}.${day}.${year}`
  if (!settings.showWeekday) return stamp
  return `${stamp} • ${formatWeekday(date)}`
}

function formatEntryTime(date) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function formatQuoteStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${formatDayHeader(date)} · ${formatEntryTime(date)}`
}

/** Announcement banners always skip weekday, even if that setting is on. */
function formatAnnouncementStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = String(date.getFullYear()).slice(-2)
  return `${month}.${day}.${year} · ${formatEntryTime(date)}`
}

function formatCopiedFromNote(copiedFrom) {
  if (!copiedFrom?.createdAt) return 'Entry copied from original'
  const date = new Date(copiedFrom.createdAt)
  if (Number.isNaN(date.getTime())) return 'Entry copied from original'
  return `Entry copied from ${formatDayHeader(date)} at ${formatEntryTime(date)}`
}

function formatMovedFromNote(movedFrom) {
  const journalName = movedFrom?.journalName?.trim() || 'Unknown journal'
  const movedAt = movedFrom?.movedAt ? new Date(movedFrom.movedAt) : null
  const createdAt = movedFrom?.createdAt ? new Date(movedFrom.createdAt) : null

  const movedStamp =
    movedAt && !Number.isNaN(movedAt.getTime())
      ? `${formatDayHeader(movedAt)} at ${formatEntryTime(movedAt)}`
      : null
  const createdStamp =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? `${formatDayHeader(createdAt)} at ${formatEntryTime(createdAt)}`
      : null

  if (movedStamp && createdStamp) {
    return `Moved from ${journalName} on ${movedStamp} · created ${createdStamp}`
  }
  if (movedStamp) {
    return `Moved from ${journalName} on ${movedStamp}`
  }
  if (createdStamp) {
    return `Moved from ${journalName} · created ${createdStamp}`
  }
  return `Moved from ${journalName}`
}

/** Compact stamp for cross-app provenance: 8.11.26 1545 */
function formatTransferStamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = String(date.getFullYear()).slice(-2)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}.${day}.${year} ${hours}${minutes}`
}

function formatTransferredFromNote(transferredFrom) {
  const sourceApp = transferredFrom?.sourceApp?.trim() || 'another app'
  const transferredStamp = transferredFrom?.transferredAt
    ? formatTransferStamp(transferredFrom.transferredAt)
    : ''
  const createdStamp = transferredFrom?.createdAt
    ? formatTransferStamp(transferredFrom.createdAt)
    : ''

  if (transferredStamp && createdStamp) {
    return `Transferred from ${sourceApp} ${transferredStamp} • Created ${createdStamp}`
  }
  if (transferredStamp) {
    return `Transferred from ${sourceApp} ${transferredStamp}`
  }
  if (createdStamp) {
    return `Transferred from ${sourceApp} • Created ${createdStamp}`
  }
  return `Transferred from ${sourceApp}`
}

function formatHistoryTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  if (getDayKey(date) === getDayKey(new Date())) {
    return formatEntryTime(date)
  }
  return formatQuoteStamp(iso)
}

function tokenizeForDiff(text) {
  return text.match(/\s+|[^\s]+/g) || []
}

/** @returns {{ type: 'equal' | 'add' | 'del', value: string }[]} */
function diffTokens(beforeTokens, afterTokens) {
  const n = beforeTokens.length
  const m = afterTokens.length

  // Prefix/suffix shortcut for large texts (avoids heavy LCS).
  if (n * m > 250_000) {
    let start = 0
    while (
      start < n &&
      start < m &&
      beforeTokens[start] === afterTokens[start]
    ) {
      start += 1
    }
    let endBefore = n
    let endAfter = m
    while (
      endBefore > start &&
      endAfter > start &&
      beforeTokens[endBefore - 1] === afterTokens[endAfter - 1]
    ) {
      endBefore -= 1
      endAfter -= 1
    }

    const parts = []
    if (start > 0) {
      parts.push({ type: 'equal', value: beforeTokens.slice(0, start).join('') })
    }
    if (endBefore > start) {
      parts.push({
        type: 'del',
        value: beforeTokens.slice(start, endBefore).join(''),
      })
    }
    if (endAfter > start) {
      parts.push({
        type: 'add',
        value: afterTokens.slice(start, endAfter).join(''),
      })
    }
    if (endBefore < n) {
      parts.push({ type: 'equal', value: beforeTokens.slice(endBefore).join('') })
    }
    return parts
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (beforeTokens[i] === afterTokens[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const parts = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeTokens[i] === afterTokens[j]) {
      parts.push({ type: 'equal', value: beforeTokens[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: 'del', value: beforeTokens[i] })
      i += 1
    } else {
      parts.push({ type: 'add', value: afterTokens[j] })
      j += 1
    }
  }
  while (i < n) {
    parts.push({ type: 'del', value: beforeTokens[i] })
    i += 1
  }
  while (j < m) {
    parts.push({ type: 'add', value: afterTokens[j] })
    j += 1
  }

  // Merge adjacent same-type runs.
  const merged = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last && last.type === part.type) {
      last.value += part.value
    } else {
      merged.push({ type: part.type, value: part.value })
    }
  }
  return merged
}

function diffText(before, after) {
  return diffTokens(tokenizeForDiff(before), tokenizeForDiff(after))
}

function getHistoryChangeTexts(entry, index) {
  const before = entry.history[index]?.text ?? ''
  const after =
    index + 1 < entry.history.length
      ? entry.history[index + 1].text
      : entry.text
  return { before, after }
}

function renderDiffChangeHtml(parts, { compact = false } = {}) {
  const changed = parts.filter((part) => part.type !== 'equal' && part.value)
  if (changed.length === 0) {
    return `<span class="entry-history-empty">No text change</span>`
  }

  if (compact) {
    return changed
      .map((part) => {
        const label = part.type === 'add' ? 'Added' : 'Removed'
        return `<span class="diff-hunk diff-hunk-inline"><span class="diff-label">${label}</span> ${escapeHtml(part.value.trim() || part.value)}</span>`
      })
      .join('<span class="diff-sep"> · </span>')
  }

  return changed
    .map((part) => {
      const label = part.type === 'add' ? 'Added' : 'Removed'
      return `<span class="diff-hunk"><span class="diff-label">${label}</span> <span class="diff-value">${escapeHtml(part.value)}</span></span>`
    })
    .join('')
}

function toggleEntryHistory(entryId) {
  const entry = entries.find((item) => item.id === entryId)
  if (!entry?.history?.length) {
    historyEntryId = null
    historyExpandedIndex = null
    render({ preserveScroll: true })
    return
  }

  if (historyEntryId === entryId) {
    historyEntryId = null
    historyExpandedIndex = null
  } else {
    historyEntryId = entryId
    historyExpandedIndex = null
  }
  render({ preserveScroll: true })
}

function toggleHistoryItem(entryId, index) {
  if (historyEntryId !== entryId) return
  if (historyExpandedIndex === index) {
    historyExpandedIndex = null
  } else {
    historyExpandedIndex = index
  }
  render({ preserveScroll: true })
}

function toDatetimeLocalValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
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

function getActiveEntries() {
  return entries
    .filter((entry) => entry.journalId === settings.selectedJournalId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
}

function getDayGroups() {
  return groupEntriesByDay(getActiveEntries())
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

function shouldArmPasteModifierKey() {
  if (backdateSession || nameSession) return false
  if (editingId) return false
  if (inputEl.value.trim() !== '') return false
  return true
}

function updateComposerQuote() {
  if (!pendingQuote) {
    composerQuoteEl.hidden = true
    composerQuoteEl.classList.remove('is-jumpable', 'is-collapsible', 'is-expanded')
    composerQuoteEl.removeAttribute('role')
    composerQuoteEl.removeAttribute('tabindex')
    composerQuoteEl.removeAttribute('aria-label')
    composerQuoteMetaEl.textContent = ''
    composerQuoteMetaEl.hidden = true
    composerQuoteTextEl.textContent = ''
    composerQuoteClampEl.classList.remove('is-expanded')
    composerQuoteToggleEl.hidden = true
    composerQuoteToggleEl.textContent = 'Show more'
    composerQuoteToggleEl.setAttribute('aria-expanded', 'false')
    composerQuoteExpanded = false
    return
  }

  const createdAt = getQuoteCreatedAt(pendingQuote)
  if (createdAt) {
    composerQuoteMetaEl.textContent = formatQuoteStamp(createdAt)
    composerQuoteMetaEl.hidden = false
  } else {
    composerQuoteMetaEl.textContent = ''
    composerQuoteMetaEl.hidden = true
  }

  composerQuoteTextEl.textContent = pendingQuote.text
  composerQuoteEl.hidden = false

  if (pendingQuote.sourceId) {
    composerQuoteEl.classList.add('is-jumpable')
    composerQuoteEl.setAttribute('role', 'button')
    composerQuoteEl.setAttribute('tabindex', '0')
    composerQuoteEl.setAttribute('aria-label', 'Go to original entry')
  } else {
    composerQuoteEl.classList.remove('is-jumpable')
    composerQuoteEl.removeAttribute('role')
    composerQuoteEl.removeAttribute('tabindex')
    composerQuoteEl.removeAttribute('aria-label')
  }

  enhanceComposerQuoteClamp()
}

function enhanceComposerQuoteClamp() {
  composerQuoteEl.classList.remove('is-collapsible', 'is-expanded')
  composerQuoteClampEl.classList.toggle('is-expanded', composerQuoteExpanded)

  if (composerQuoteExpanded) {
    composerQuoteEl.classList.add('is-collapsible', 'is-expanded')
    composerQuoteToggleEl.hidden = false
    composerQuoteToggleEl.textContent = 'Show less'
    composerQuoteToggleEl.setAttribute('aria-expanded', 'true')
    return
  }

  // Measure overflow while collapsed.
  composerQuoteClampEl.classList.remove('is-expanded')
  const overflows =
    composerQuoteClampEl.scrollHeight > composerQuoteClampEl.clientHeight + 1

  if (overflows) {
    composerQuoteEl.classList.add('is-collapsible')
    composerQuoteToggleEl.hidden = false
    composerQuoteToggleEl.textContent = 'Show more'
    composerQuoteToggleEl.setAttribute('aria-expanded', 'false')
  } else {
    composerQuoteClampEl.classList.add('is-expanded')
    composerQuoteToggleEl.hidden = true
    composerQuoteToggleEl.textContent = 'Show more'
    composerQuoteToggleEl.setAttribute('aria-expanded', 'false')
  }
}

function clearPendingQuote() {
  pendingQuote = null
  composerQuoteExpanded = false
  updateComposerQuote()
}

function startBuildOn(id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry || isAnnouncementEntry(entry)) return

  editingId = null
  composerQuoteExpanded = false
  pendingQuote = {
    text: getEntryQuoteSnapshot(entry),
    sourceId: entry.id,
    createdAt: entry.createdAt,
  }
  inputEl.value = ''
  updateComposerQuote()
  resetComposerHeight()
  inputEl.focus()
}

function startEdit(id) {
  const entry = entries.find((item) => item.id === id)
  if (!entry || isAnnouncementEntry(entry)) return

  clearPendingQuote()
  editingId = id
  inputEl.value = entry.text
  resizeComposer()
  inputEl.focus()
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
  markJournalUsed(entry.journalId || settings.selectedJournalId)
}

function deleteEntry(id) {
  entries = entries.filter((item) => item.id !== id)
  queueRemoteDelete(id)
  if (editingId === id) {
    editingId = null
    inputEl.value = ''
    resetComposerHeight()
  }
  if (pendingQuote?.sourceId === id) {
    clearPendingQuote()
  }
  if (historyEntryId === id) {
    historyEntryId = null
    historyExpandedIndex = null
  }
  expandedQuoteIds.delete(id)
  saveEntries()
  render()
}

function openBackdateSheet(session) {
  backdateSession = session
  bHeld = false
  hHeld = false
  closeSettings()

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
    markJournalUsed(settings.selectedJournalId)
    const entry = createEntry(
      backdateSession.text,
      createdAt,
      backdateSession.quote ?? null,
    )
    entries.push(entry)
    clearPendingQuote()
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

function openNameSheet(session) {
  nameSession = session
  closeSettings()
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
    lastMarkedUsedJournalId = null
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
    closeNameSheet()
    render({ preserveScroll: true })
    return
  }

  const journal = settings.journals.find(
    (item) => item.id === nameSession.journalId,
  )
  if (!journal) {
    closeNameSheet()
    render({ preserveScroll: true })
    return
  }

  const previousName = journal.name
  journal.name = name
  saveSettings()

  let revealAnnouncement = false
  if (previousName !== name) {
    const createdAt = new Date().toISOString()
    const announcement = createAnnouncementEntry(
      journal.id,
      `Journal name changed to “${name}”`,
      createdAt,
    )
    entries.push(announcement)
    markJournalUsed(journal.id)
    saveEntries()
    revealAnnouncement =
      journal.id === settings.selectedJournalId && currentView === 'journal'
  }

  closeNameSheet()
  render({ preserveScroll: !revealAnnouncement })
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
  const removedIds = entries
    .filter((entry) => entry.journalId === journalId)
    .map((entry) => entry.id)
  queueRemoteDeletes(removedIds)
  entries = entries.filter((entry) => entry.journalId !== journalId)

  if (settings.selectedJournalId === journalId) {
    settings.selectedJournalId = settings.journals[0].id
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
  const removedIds = entries
    .filter((entry) => journalIdSet.has(entry.journalId))
    .map((entry) => entry.id)
  queueRemoteDeletes(removedIds)
  entries = entries.filter((entry) => !journalIdSet.has(entry.journalId))

  for (const id of folderIds) {
    collapsedFolderIds.delete(id)
  }

  if (journalIdSet.has(settings.selectedJournalId)) {
    settings.selectedJournalId = settings.journals[0].id
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

  const expandedPath = expandFolderPathForJournal(journalId)

  if (settings.selectedJournalId === journalId) {
    if (expandedPath) render({ preserveScroll: true })
    return
  }

  settings.selectedJournalId = journalId
  clearPendingQuote()
  editingId = null
  historyEntryId = null
  historyExpandedIndex = null
  lastMarkedUsedJournalId = null
  inputEl.value = ''
  resetComposerHeight()
  saveSettings()
  render()
}

function renderQuoteHtml(quote, entryId) {
  if (!quote?.text) return ''

  const createdAt = getQuoteCreatedAt(quote)
  const metaHtml = createdAt
    ? `<p class="entry-quote-meta">${escapeHtml(formatQuoteStamp(createdAt))}</p>`
    : ''
  const expanded = entryId ? expandedQuoteIds.has(entryId) : false
  const clampHtml = `
    <div class="entry-quote-clamp${expanded ? ' is-expanded' : ''}">
      <p class="entry-quote-text">${escapeHtml(quote.text)}</p>
    </div>
  `
  const toggleHtml = `
    <button
      type="button"
      class="entry-quote-toggle"
      data-action="toggle-quote"
      aria-expanded="${expanded ? 'true' : 'false'}"
      hidden
    >${expanded ? 'Show less' : 'Show more'}</button>
  `
  const bodyHtml = `${metaHtml}${clampHtml}`

  if (quote.sourceId) {
    return `
      <div
        class="entry-quote${expanded ? ' is-expanded' : ''}"
        data-quote-clamp
      >
        <div
          class="entry-quote-hit is-jumpable"
          data-action="jump-quote"
          role="button"
          tabindex="0"
          aria-label="Go to original entry"
        >
          ${bodyHtml}
        </div>
        ${toggleHtml}
      </div>
    `
  }

  return `
    <div
      class="entry-quote${expanded ? ' is-expanded' : ''}"
      data-quote-clamp
    >
      ${bodyHtml}
      ${toggleHtml}
    </div>
  `
}

function enhanceCollapsibleQuotes() {
  for (const quoteEl of feedEl.querySelectorAll('[data-quote-clamp]')) {
    const clamp = quoteEl.querySelector('.entry-quote-clamp')
    const toggle = quoteEl.querySelector('[data-action="toggle-quote"]')
    if (!clamp || !toggle) continue

    const entryId = quoteEl.closest('.entry')?.dataset.id
    const expanded = entryId ? expandedQuoteIds.has(entryId) : false

    quoteEl.classList.toggle('is-expanded', expanded)
    clamp.classList.toggle('is-expanded', expanded)

    if (expanded) {
      quoteEl.classList.add('is-collapsible')
      toggle.hidden = false
      toggle.textContent = 'Show less'
      toggle.setAttribute('aria-expanded', 'true')
      continue
    }

    clamp.classList.remove('is-expanded')
    const overflows = clamp.scrollHeight > clamp.clientHeight + 1

    if (overflows) {
      quoteEl.classList.add('is-collapsible')
      toggle.hidden = false
      toggle.textContent = 'Show more'
      toggle.setAttribute('aria-expanded', 'false')
    } else {
      quoteEl.classList.remove('is-collapsible')
      clamp.classList.add('is-expanded')
      toggle.hidden = true
      toggle.textContent = 'Show more'
      toggle.setAttribute('aria-expanded', 'false')
    }
  }
}

function toggleQuoteExpand(entryId) {
  if (!entryId) return
  if (expandedQuoteIds.has(entryId)) {
    expandedQuoteIds.delete(entryId)
  } else {
    expandedQuoteIds.add(entryId)
  }
  render({ preserveScroll: true })
}

/** @type {ReturnType<typeof setTimeout> | null} */
let highlightEntryTimer = null

function expandFolderPathForJournal(journalId) {
  const journal = settings.journals.find((item) => item.id === journalId)
  if (!journal) return false

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
  return expandedPath
}

function highlightAndScrollToEntry(entryId) {
  const entryEl = feedEl.querySelector(`.entry[data-id="${CSS.escape(entryId)}"]`)
  if (!entryEl) return

  for (const el of feedEl.querySelectorAll('.entry.is-highlighted')) {
    el.classList.remove('is-highlighted')
  }

  // Restart the flash if the same entry is jumped to again.
  void entryEl.offsetWidth
  entryEl.classList.add('is-highlighted')

  clearTimeout(highlightEntryTimer)
  highlightEntryTimer = setTimeout(() => {
    entryEl.classList.remove('is-highlighted')
    highlightEntryTimer = null
  }, 1600)

  const entryRect = entryEl.getBoundingClientRect()
  const feedRect = feedEl.getBoundingClientRect()
  const nextTop =
    feedEl.scrollTop +
    (entryRect.top - feedRect.top) -
    feedRect.height / 2 +
    entryRect.height / 2

  feedEl.scrollTo({
    top: Math.max(0, nextTop),
    behavior: 'smooth',
  })
}

function jumpToQuotedEntry(sourceId) {
  if (!sourceId) return

  const source = entries.find((item) => item.id === sourceId)
  if (!source) return

  closeContextMenu()

  const wasSettings = currentView === 'settings'
  if (wasSettings) currentView = 'journal'

  const expandedPath = expandFolderPathForJournal(
    source.journalId || settings.selectedJournalId,
  )

  let needsRender = wasSettings || expandedPath

  if (
    source.journalId &&
    source.journalId !== settings.selectedJournalId
  ) {
    settings.selectedJournalId = source.journalId
    saveSettings()
    needsRender = true
  }

  if (needsRender) {
    render({ preserveScroll: true })
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      highlightAndScrollToEntry(source.id)
    })
  })
}

function renderHistoryHtml(entry) {
  if (historyEntryId !== entry.id || !entry.history?.length) return ''

  const items = entry.history
    .map((item, index) => {
      const { before, after } = getHistoryChangeTexts(entry, index)
      const parts = diffText(before, after)
      const previewHtml = renderDiffChangeHtml(parts, { compact: true })
      const isExpanded = historyExpandedIndex === index
      const fullHtml = isExpanded
        ? `<div class="entry-history-full">${renderDiffChangeHtml(parts)}</div>`
        : ''
      return `
      <button
        type="button"
        class="entry-history-item${isExpanded ? ' is-expanded' : ''}"
        data-action="toggle-history-item"
        data-history-index="${index}"
        aria-expanded="${isExpanded ? 'true' : 'false'}"
      >
        <span class="entry-history-time">${escapeHtml(formatHistoryTime(item.editedAt))}</span>
        <span class="entry-history-preview">${previewHtml}</span>
      </button>
      ${fullHtml}`
    })
    .join('')

  return `<div class="entry-history" aria-label="Edit history">${items}</div>`
}

function renderCopiedFromHtml(copiedFrom) {
  if (!copiedFrom?.sourceId) return ''

  const sourceExists = entries.some((item) => item.id === copiedFrom.sourceId)
  const label = formatCopiedFromNote(copiedFrom)

  if (!sourceExists) {
    return `<p class="entry-provenance">${escapeHtml(label)}</p>`
  }

  return `
    <button
      type="button"
      class="entry-provenance is-jumpable"
      data-action="jump-copied-from"
      aria-label="Go to original entry"
    >${escapeHtml(label)}</button>
  `
}

function renderMovedFromHtml(movedFrom) {
  if (!movedFrom?.journalName) return ''
  return `<p class="entry-provenance">${escapeHtml(formatMovedFromNote(movedFrom))}</p>`
}

function renderTransferredFromHtml(transferredFrom) {
  if (!transferredFrom?.sourceApp) return ''
  return `<p class="entry-provenance">${escapeHtml(formatTransferredFromNote(transferredFrom))}</p>`
}

function renderEntry(entry) {
  if (isAnnouncementEntry(entry)) {
    return `
      <article
        class="entry is-announcement"
        data-id="${escapeHtml(entry.id)}"
        data-kind="announcement"
      >
        <div class="entry-actions">
          <button
            type="button"
            class="entry-action"
            data-action="menu"
            aria-label="Announcement menu"
            aria-haspopup="menu"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
            </svg>
          </button>
        </div>
        <div class="entry-body">
          <p class="entry-announcement">${escapeHtml(entry.text)}</p>
          <p class="entry-announcement-time">${escapeHtml(formatAnnouncementStamp(entry.createdAt))}</p>
        </div>
      </article>
    `
  }

  const date = new Date(entry.createdAt)
  const quoteHtml = renderQuoteHtml(entry.quote, entry.id)
  const copiedFromHtml = renderCopiedFromHtml(entry.copiedFrom)
  const movedFromHtml = renderMovedFromHtml(entry.movedFrom)
  const transferredFromHtml = renderTransferredFromHtml(entry.transferredFrom)
  const historyHtml = renderHistoryHtml(entry)
  const transferEnterClass = pendingTransferEnterIds.has(entry.id)
    ? ' is-transfer-enter'
    : ''
  return `
    <article class="entry${historyEntryId === entry.id ? ' is-history-open' : ''}${transferEnterClass}" data-id="${escapeHtml(entry.id)}">
      <div class="entry-actions">
        <button
          type="button"
          class="entry-action"
          data-action="menu"
          aria-label="Entry menu"
          aria-haspopup="menu"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
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
        ${copiedFromHtml}
        ${movedFromHtml}
        ${transferredFromHtml}
        ${quoteHtml}
        <p class="entry-text">${escapeHtml(entry.text)}</p>
        ${historyHtml}
      </div>
    </article>
  `
}

function renderDayGroup(group) {
  return `
    <section class="day-group">
      <h2 class="day-header">${escapeHtml(formatDayHeader(group.date))}</h2>
      ${group.entries.map(renderEntry).join('')}
    </section>
  `
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

function renderSidebar() {
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

function renderFeed(groups) {
  if (groups.length === 0) {
    feedEl.innerHTML = `<p class="feed-empty">No entries yet</p>`
    return
  }

  feedEl.innerHTML = groups.map((group) => renderDayGroup(group)).join('')
}

function syncSettingsUi() {
  showWeekdayEl.checked = !!settings.showWeekday
}

function render({ preserveScroll = false } = {}) {
  const scrollTop = feedEl.scrollTop
  ensureSelectedJournal()

  const showSettings = currentView === 'settings'
  appEl.classList.toggle('is-settings-mode', showSettings)
  settingsOpenEl.hidden = showSettings
  settingsCloseEl.hidden = !showSettings
  settingsViewEl.hidden = !showSettings
  journalViewEl.hidden = showSettings

  if (showSettings) {
    syncSettingsUi()
    return
  }

  const groups = getDayGroups()
  renderSidebar()
  renderFeed(groups)
  feedEl.scrollTop = preserveScroll ? scrollTop : feedEl.scrollHeight

  enhanceCollapsibleQuotes()

  // Clear transfer enter flags after this paint so re-renders don't replay.
  if (pendingTransferEnterIds.size > 0) {
    const enteringIds = [...pendingTransferEnterIds]
    pendingTransferEnterIds.clear()
    requestAnimationFrame(() => {
      for (const id of enteringIds) {
        const el = feedEl.querySelector(`.entry[data-id="${CSS.escape(id)}"]`)
        if (!el) continue
        const clear = () => el.classList.remove('is-transfer-enter')
        el.addEventListener('animationend', clear, { once: true })
        window.setTimeout(clear, 600)
      }
    })
  }
}

function openSettings() {
  currentView = 'settings'
  closeContextMenu()
  render({ preserveScroll: true })
}

function closeSettings() {
  if (currentView !== 'settings') return
  currentView = 'journal'
  render({ preserveScroll: true })
  inputEl.focus()
}

function setShowWeekday(enabled) {
  const next = !!enabled
  if (settings.showWeekday === next) {
    showWeekdayEl.checked = next
    return
  }
  settings.showWeekday = next
  saveSettings()
  showWeekdayEl.checked = next
  if (currentView === 'journal') {
    render({ preserveScroll: true })
  }
}

function submitEntry(text = inputEl.value) {
  const trimmed = text.trim()
  if (!trimmed) return

  markJournalUsed(settings.selectedJournalId)

  if (editingId) {
    const entry = entries.find((item) => item.id === editingId)
    if (entry) {
      if (entry.text !== trimmed) {
        if (!Array.isArray(entry.history)) entry.history = []
        entry.history.push({
          editedAt: new Date().toISOString(),
          text: entry.text,
        })
        entry.text = trimmed
      }
    }
    editingId = null
  } else {
    const entry = createEntry(trimmed, new Date().toISOString(), pendingQuote)
    entries.push(entry)
    clearPendingQuote()
  }

  saveEntries()
  inputEl.value = ''
  resetComposerHeight()
  render()
  inputEl.focus()
}

function pasteIntoComposer(text) {
  inputEl.value = text
  resizeComposer()
  inputEl.focus()
  const end = inputEl.value.length
  inputEl.setSelectionRange(end, end)
  markJournalUsed(settings.selectedJournalId)
}

function submitPastedText(text) {
  const trimmed = text.trim()
  if (!trimmed) return

  if (hHeld) {
    pasteIntoComposer(text)
    return
  }

  if (bHeld) {
    markJournalUsed(settings.selectedJournalId)
    openBackdateSheet({
      mode: 'create',
      text: trimmed,
      createdAt: new Date().toISOString(),
      quote: pendingQuote,
    })
    return
  }

  markJournalUsed(settings.selectedJournalId)
  const entry = createEntry(trimmed, new Date().toISOString(), pendingQuote)
  entries.push(entry)
  clearPendingQuote()
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
  if (!entry || isAnnouncementEntry(entry)) return

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

  if (event.key === 'Escape' && currentView === 'settings') {
    event.preventDefault()
    closeSettings()
    return
  }

  if (
    event.key === 'Escape' &&
    pendingQuote &&
    !editingId &&
    inputEl.value.trim() === ''
  ) {
    event.preventDefault()
    clearPendingQuote()
    return
  }

  if (event.repeat) return
  if (event.altKey || event.shiftKey) return
  if (!(event.metaKey || event.ctrlKey)) return
  if (!shouldArmPasteModifierKey()) return

  if (event.key === 'b' || event.key === 'B') {
    event.preventDefault()
    bHeld = true
    return
  }

  if (event.key === 'h' || event.key === 'H') {
    event.preventDefault()
    hHeld = true
  }
})

document.addEventListener('keyup', (event) => {
  if (event.key === 'b' || event.key === 'B') {
    bHeld = false
  }
  if (event.key === 'h' || event.key === 'H') {
    hHeld = false
  }
  if (event.key === 'Meta' || event.key === 'Control') {
    bHeld = false
    hHeld = false
  }
})

window.addEventListener('blur', () => {
  bHeld = false
  hHeld = false
})

document.addEventListener('pointerdown', (event) => {
  if (!contextMenuEl.hidden && !contextMenuEl.contains(event.target)) {
    closeContextMenu()
  }
})

inputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submitEntry()
})

inputEl.addEventListener('paste', (event) => {
  if (editingId) return
  if (inputEl.value.trim() !== '') return

  // ⌘V H: let the browser paste into the composer without auto-submitting.
  if (hHeld) return

  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim()) return

  event.preventDefault()
  submitPastedText(text)
})

inputEl.addEventListener('input', () => {
  resizeComposer()
  markJournalUsed(settings.selectedJournalId)
})

pasteBtnEl.addEventListener('click', pasteAndSubmit)

settingsOpenEl.addEventListener('click', (event) => {
  event.stopPropagation()
  openSettings()
})

settingsCloseEl.addEventListener('click', () => {
  closeSettings()
})

showWeekdayEl.addEventListener('change', () => {
  setShowWeekday(showWeekdayEl.checked)
})

contextMenuEl.addEventListener('click', (event) => {
  const item = event.target.closest('[data-action]')
  if (!item || !contextMenuEl.contains(item)) return
  if (item.disabled) return
  handleContextMenuAction(
    item.dataset.action,
    item.dataset.folderId ?? null,
    item.dataset.journalId ?? null,
  )
})

sidebarEl.addEventListener('contextmenu', (event) => {
  const journalEl = event.target.closest('.sidebar-journal[data-journal-id]')
  if (!journalEl || !sidebarEl.contains(journalEl)) return

  event.preventDefault()
  openJournalContextMenu(
    journalEl.dataset.journalId,
    event.clientX,
    event.clientY,
  )
})

feedEl.addEventListener('contextmenu', (event) => {
  const entryEl = event.target.closest('.entry')
  if (!entryEl || !feedEl.contains(entryEl)) return

  event.preventDefault()
  openEntryContextMenu(entryEl.dataset.id, event.clientX, event.clientY)
})

sidebarEl.addEventListener('click', (event) => {
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

  if (action === 'menu') {
    event.stopPropagation()
    if (
      contextMenuKind === 'entry' &&
      contextMenuEntryId === id &&
      !contextMenuEl.hidden
    ) {
      closeContextMenu()
      return
    }
    const rect = button.getBoundingClientRect()
    openEntryContextMenu(id, rect.left, rect.bottom + 4)
  } else if (action === 'edit-time') {
    startEditTime(id)
  } else if (action === 'toggle-history-item') {
    const index = Number(button.dataset.historyIndex)
    if (Number.isInteger(index)) toggleHistoryItem(id, index)
  } else if (action === 'toggle-quote') {
    event.stopPropagation()
    toggleQuoteExpand(id)
  } else if (action === 'jump-quote') {
    const entry = entries.find((item) => item.id === id)
    if (entry?.quote?.sourceId) jumpToQuotedEntry(entry.quote.sourceId)
  } else if (action === 'jump-copied-from') {
    const entry = entries.find((item) => item.id === id)
    if (entry?.copiedFrom?.sourceId) {
      jumpToQuotedEntry(entry.copiedFrom.sourceId)
    }
  }
})

feedEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const target = event.target.closest('[data-action="jump-quote"]')
  if (!target || !feedEl.contains(target)) return
  event.preventDefault()
  const entryEl = target.closest('.entry')
  if (!entryEl || !feedEl.contains(entryEl)) return
  const entry = entries.find((item) => item.id === entryEl.dataset.id)
  if (entry?.quote?.sourceId) jumpToQuotedEntry(entry.quote.sourceId)
})

composerQuoteEl.addEventListener('click', (event) => {
  if (event.target.closest('.composer-quote-dismiss')) return
  if (event.target.closest('.composer-quote-toggle')) return
  if (!pendingQuote?.sourceId) return
  jumpToQuotedEntry(pendingQuote.sourceId)
})

composerQuoteEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target.closest('.composer-quote-dismiss')) return
  if (event.target.closest('.composer-quote-toggle')) return
  if (!pendingQuote?.sourceId) return
  event.preventDefault()
  jumpToQuotedEntry(pendingQuote.sourceId)
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

composerQuoteDismissEl.addEventListener('click', () => {
  clearPendingQuote()
  inputEl.focus()
})

composerQuoteToggleEl.addEventListener('click', (event) => {
  event.stopPropagation()
  composerQuoteExpanded = !composerQuoteExpanded
  enhanceComposerQuoteClamp()
})

boot()
