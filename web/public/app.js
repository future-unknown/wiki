/**
 * wiki-web browser app. All data access goes through wiki-sdk.
 */

import { WikiClient } from '/sdk/index.js'
import { renderContent, seriesFromRows } from '/views.js'

const elements = {
  wikiSelect: document.getElementById('wiki-select'),
  tree: document.getElementById('tree'),
  content: document.getElementById('content'),
  dataPanel: document.getElementById('data-panel'),
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

const CHART_COLORS = ['#2563eb', '#db8b0b', '#0f9d58', '#b3261e', '#7c3aed', '#0e7490']

function renderDataInto (container, node, rows) {
  const latest = rows[rows.length - 1]
  const readout = document.createElement('div')
  readout.className = 'data-latest'
  const value = document.createElement('code')
  value.textContent = JSON.stringify(latest.payload)
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = ` · ${latest.ts} · ${rows.length} observation(s)`
  readout.appendChild(value)
  readout.appendChild(meta)
  container.appendChild(readout)

  const { ts, series } = seriesFromRows(rows, node.metadata?.data?.render)
  const fields = Object.keys(series)
  if (rows.length < 2 || fields.length === 0 || typeof uPlot !== 'function') return

  const chart = document.createElement('div')
  chart.className = 'data-chart'
  container.appendChild(chart)
  const width = Math.max(320, container.clientWidth - 16)
  new uPlot({
    width,
    height: 180,
    series: [
      {},
      ...fields.map((field, index) => ({
        label: field,
        stroke: CHART_COLORS[index % CHART_COLORS.length],
        width: 2
      }))
    ]
  }, [ts, ...fields.map((field) => series[field])], chart)
}

async function loadData (node) {
  elements.dataPanel.hidden = true
  try {
    const { rows } = await client.data(node.fullPath, { limit: 500 })
    // The reader may already be on another page by the time this lands.
    if (selectedPath !== node.fullPath || rows.length === 0) return
    elements.dataPanel.hidden = false
    elements.dataPanel.innerHTML = ''
    renderDataInto(elements.dataPanel, node, rows)
  } catch {
    // A page without readable data simply has no panel.
  }
}

const EMBED_DEPTH_LIMIT = 3

function embedNotice (target, message) {
  target.innerHTML = ''
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = message
  target.appendChild(hint)
}

/**
 * Fill ![[...]] placeholders with their target pages: header link,
 * content rendered by type, data block when the page has observations.
 * Depth-capped and cycle-safe; a failing embed becomes an inert notice
 * and never breaks the host page.
 */
async function hydrateEmbeds (container, rootPath, depth, visited) {
  for (const target of container.querySelectorAll('[data-embed]')) {
    if (selectedPath !== rootPath) return // reader moved on mid-hydration
    const relPath = target.dataset.embed
    const fullPath = config.wiki + '.' + relPath
    if (depth >= EMBED_DEPTH_LIMIT) {
      embedNotice(target, `embed depth limit reached: ${relPath}`)
      continue
    }
    if (visited.has(fullPath)) {
      embedNotice(target, `circular embed: ${relPath}`)
      continue
    }
    try {
      const node = await client.get(fullPath)
      target.innerHTML = ''

      const header = document.createElement('div')
      header.className = 'embed-header'
      const link = document.createElement('a')
      link.href = `#${fullPath}`
      link.dataset.path = fullPath
      link.textContent = node.title || node.slug
      const pathCode = document.createElement('code')
      pathCode.textContent = fullPath
      header.appendChild(link)
      header.appendChild(pathCode)
      target.appendChild(header)

      const body = document.createElement('div')
      body.className = 'embed-body'
      body.innerHTML = renderContent(node)
      target.appendChild(body)

      try {
        const { rows } = await client.data(fullPath, { limit: 500 })
        if (rows.length > 0) {
          const dataBlock = document.createElement('div')
          dataBlock.className = 'embed-data'
          target.appendChild(dataBlock)
          renderDataInto(dataBlock, node, rows)
        }
      } catch {
        // No readable data — no block.
      }

      await hydrateEmbeds(body, rootPath, depth + 1, new Set([...visited, fullPath]))
    } catch {
      embedNotice(target, `embed unavailable: ${relPath}`)
    }
  }
}

async function openNode (fullPath) {
  hidePanels()
  const node = await client.get(fullPath)
  selectedPath = fullPath
  elements.pageMeta.hidden = false
  elements.pageTitle.textContent = node.title || node.slug
  elements.pagePath.textContent = node.fullPath
  elements.content.innerHTML = renderContent(node) ||
    '<p class="hint">(empty page)</p>'
  for (const link of elements.tree.querySelectorAll('a')) {
    link.classList.toggle('selected', link.dataset.path === fullPath)
  }
  await loadData(node)
  await hydrateEmbeds(elements.content, fullPath, 0, new Set([fullPath]))
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
  const wikilink = event.target.closest('a[data-wikilink]')
  if (wikilink) {
    event.preventDefault()
    openNode(config.wiki + '.' + wikilink.dataset.wikilink).catch(showError)
    return
  }
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
