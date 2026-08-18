/**
 * wiki-web browser app. All data access goes through wiki-sdk.
 */

import { WikiClient } from '/sdk/index.js'
import { renderMarkdown } from '/markdown.js'

const elements = {
  wikiSelect: document.getElementById('wiki-select'),
  tree: document.getElementById('tree'),
  content: document.getElementById('content'),
  pageMeta: document.getElementById('page-meta'),
  pageTitle: document.getElementById('page-title'),
  pagePath: document.getElementById('page-path'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  history: document.getElementById('history'),
  historyToggle: document.getElementById('history-toggle'),
  settings: document.getElementById('settings'),
  settingsToggle: document.getElementById('settings-toggle'),
  settingsForm: document.getElementById('settings-form'),
  settingUrl: document.getElementById('setting-url'),
  settingToken: document.getElementById('setting-token'),
  settingWiki: document.getElementById('setting-wiki')
}

const config = {
  url: localStorage.getItem('wiki.url') || 'http://localhost:3000',
  token: localStorage.getItem('wiki.token') || 'dev-token',
  wiki: localStorage.getItem('wiki.wiki') || 'acme'
}

let client = null
let selectedPath = null

function showError (error) {
  elements.content.innerHTML = ''
  const paragraph = document.createElement('p')
  paragraph.className = 'error'
  paragraph.textContent = `error: ${error.message}`
  elements.content.appendChild(paragraph)
}

function hidePanels () {
  elements.searchResults.hidden = true
  elements.history.hidden = true
}

function renderTreeNode (node) {
  const item = document.createElement('li')
  const link = document.createElement('a')
  link.href = `#${node.fullPath}`
  link.textContent = node.slug
  link.dataset.path = node.fullPath
  if (node.fullPath === selectedPath) link.className = 'selected'
  item.appendChild(link)
  if (node.children.length > 0) {
    const list = document.createElement('ul')
    for (const child of node.children) list.appendChild(renderTreeNode(child))
    item.appendChild(list)
  }
  return item
}

async function loadTree () {
  const tree = await client.tree(config.wiki)
  elements.tree.innerHTML = ''
  const list = document.createElement('ul')
  list.appendChild(renderTreeNode(tree))
  elements.tree.appendChild(list)
}

async function openNode (fullPath) {
  hidePanels()
  const node = await client.get(fullPath)
  selectedPath = fullPath
  elements.pageMeta.hidden = false
  elements.pageTitle.textContent = node.title || node.slug
  elements.pagePath.textContent = node.fullPath
  elements.content.innerHTML = renderMarkdown(node.content) ||
    '<p class="hint">(empty page)</p>'
  for (const link of elements.tree.querySelectorAll('a')) {
    link.classList.toggle('selected', link.dataset.path === fullPath)
  }
}

async function runSearch (query) {
  hidePanels()
  const results = await client.search(config.wiki, query)
  elements.searchResults.hidden = false
  elements.searchResults.innerHTML = ''
  const heading = document.createElement('p')
  heading.textContent = `${results.length} result(s) for “${query}”`
  elements.searchResults.appendChild(heading)
  const list = document.createElement('ul')
  for (const result of results) {
    const item = document.createElement('li')
    const link = document.createElement('a')
    link.href = `#${result.fullPath}`
    link.textContent = result.title || result.fullPath
    const excerpt = document.createElement('span')
    excerpt.className = 'excerpt'
    excerpt.textContent = `${result.fullPath} — ${result.excerpt}`
    item.appendChild(link)
    item.appendChild(excerpt)
    list.appendChild(item)
  }
  elements.searchResults.appendChild(list)
}

async function showHistory () {
  if (!selectedPath) return
  const entries = await client.history(selectedPath)
  elements.history.hidden = false
  elements.history.innerHTML = ''
  const list = document.createElement('ul')
  for (const entry of entries) {
    const item = document.createElement('li')
    const actor = entry.commit.actor
    const who = actor.onBehalfOf ? `${actor.id} for ${actor.onBehalfOf}` : actor.id
    item.innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = `commit ${entry.commitId}`
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = ` · ${entry.createdAt} · ${actor.type}:${who}` +
      (entry.deleted ? ' · deleted' : '') +
      (entry.commit.message ? ` · ${entry.commit.message}` : '') +
      ` · revision ${entry.revisionId}`
    item.appendChild(strong)
    item.appendChild(meta)
    list.appendChild(item)
  }
  elements.history.appendChild(list)
}

async function loadWikiList () {
  const wikis = await client.list()
  elements.wikiSelect.innerHTML = ''
  for (const wiki of wikis) {
    const option = document.createElement('option')
    option.value = wiki.slug
    option.textContent = wiki.slug
    option.title = wiki.title || wiki.slug
    elements.wikiSelect.appendChild(option)
  }
  if (wikis.length > 0 && !wikis.some((wiki) => wiki.slug === config.wiki)) {
    config.wiki = wikis[0].slug
  }
  elements.wikiSelect.value = config.wiki
  return wikis
}

async function connect () {
  client = new WikiClient({ baseUrl: config.url, token: config.token })
  try {
    const wikis = await loadWikiList()
    if (wikis.length === 0) {
      elements.tree.innerHTML = ''
      elements.pageMeta.hidden = true
      elements.content.innerHTML = '<p class="hint">no wikis yet — create one with the CLI</p>'
      return
    }
    await loadTree()
    await openNode(config.wiki)
  } catch (error) {
    showError(error)
  }
}

elements.wikiSelect.addEventListener('change', () => {
  config.wiki = elements.wikiSelect.value
  localStorage.setItem('wiki.wiki', config.wiki)
  elements.settingWiki.value = config.wiki
  hidePanels()
  loadTree().then(() => openNode(config.wiki)).catch(showError)
})

elements.settingsToggle.addEventListener('click', () => {
  elements.settings.hidden = !elements.settings.hidden
})

elements.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault()
  config.url = elements.settingUrl.value.trim() || config.url
  config.token = elements.settingToken.value.trim() || config.token
  config.wiki = elements.settingWiki.value.trim() || config.wiki
  localStorage.setItem('wiki.url', config.url)
  localStorage.setItem('wiki.token', config.token)
  localStorage.setItem('wiki.wiki', config.wiki)
  elements.settings.hidden = true
  connect()
})

elements.searchForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const query = elements.searchInput.value.trim()
  if (query) runSearch(query).catch(showError)
})

elements.historyToggle.addEventListener('click', () => {
  if (elements.history.hidden) showHistory().catch(showError)
  else elements.history.hidden = true
})

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-path], #search-results a')
  if (!link) return
  event.preventDefault()
  const fullPath = link.dataset.path || link.getAttribute('href').slice(1)
  openNode(fullPath).catch(showError)
})

elements.settingUrl.value = config.url
elements.settingToken.value = config.token
elements.settingWiki.value = config.wiki

const initial = location.hash.slice(1)
if (initial) config.wiki = initial.split('.')[0]
connect().then(() => {
  if (initial) return openNode(initial).catch(showError)
})
