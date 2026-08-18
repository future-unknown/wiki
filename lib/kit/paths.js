/**
 * Path parsing and validation.
 *
 * Public callers address nodes with full dot-separated paths
 * ("acme.about.foo"). Inside wiki-kit everything is an immutable
 * wiki ID plus a path relative to the wiki root ("about.foo",
 * "" for the root itself).
 */

import { ValidationError } from './errors.js'

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/**
 * @param {string} slug
 * @returns {boolean}
 */
export function isValidSlug (slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug)
}

/**
 * @param {string} slug
 */
export function assertValidSlug (slug) {
  if (!isValidSlug(slug)) {
    throw new ValidationError(`invalid slug: ${JSON.stringify(slug)}`, { slug })
  }
}

/**
 * Parse a relative path ("" | "about" | "about.foo") into segments.
 * The empty string addresses the wiki root.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function parseRelativePath (path) {
  if (typeof path !== 'string') {
    throw new ValidationError('path must be a string', { path })
  }
  if (path === '') return []
  const segments = path.split('.')
  for (const segment of segments) {
    if (!isValidSlug(segment)) {
      throw new ValidationError(`invalid path: ${JSON.stringify(path)}`, { path, segment })
    }
  }
  return segments
}

/**
 * Parse a full public path ("acme.about.foo") into the root slug and
 * the wiki-relative path.
 *
 * @param {string} fullPath
 * @returns {{ slug: string, path: string }}
 */
export function parseFullPath (fullPath) {
  if (typeof fullPath !== 'string' || fullPath === '') {
    throw new ValidationError('path must be a non-empty string', { path: fullPath })
  }
  const segments = fullPath.split('.')
  for (const segment of segments) {
    if (!isValidSlug(segment)) {
      throw new ValidationError(`invalid path: ${JSON.stringify(fullPath)}`, { path: fullPath, segment })
    }
  }
  return { slug: segments[0], path: segments.slice(1).join('.') }
}

/**
 * @param {string[]} segments
 * @returns {string}
 */
export function joinPath (segments) {
  return segments.join('.')
}

/**
 * Parent path of a relative path ("about.foo" -> "about", "about" -> "").
 *
 * @param {string} path
 * @returns {string}
 */
export function parentPath (path) {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(0, index)
}

/**
 * Final segment of a relative path.
 *
 * @param {string} path
 * @returns {string}
 */
export function lastSlug (path) {
  const index = path.lastIndexOf('.')
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * True when `candidate` equals `ancestor` or sits beneath it.
 *
 * @param {string} candidate
 * @param {string} ancestor
 * @returns {boolean}
 */
export function isSameOrDescendant (candidate, ancestor) {
  if (ancestor === '') return true
  return candidate === ancestor || candidate.startsWith(ancestor + '.')
}
