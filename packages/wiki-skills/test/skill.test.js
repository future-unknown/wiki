import should from 'should'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { commands, globalOptions, exitCodes } from 'wiki-cli'

/**
 * The skill is documentation for agents; verify it against the actual
 * CLI command definitions so it cannot silently drift.
 */

const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const skill = fs.readFileSync(skillPath, 'utf8')

describe('wiki-skills SKILL.md', () => {
  it('has skill frontmatter', () => {
    skill.should.startWith('---\n')
    skill.should.match(/name: /)
    skill.should.match(/description: /)
  })

  it('documents every CLI command with its exact usage line', () => {
    for (const definition of Object.values(commands)) {
      skill.should.containEql(`\`${definition.usage}\``)
    }
  })

  it('documents every command option', () => {
    for (const definition of Object.values(commands)) {
      for (const option of Object.keys(definition.options)) {
        skill.should.containEql(`--${option}`)
      }
    }
  })

  it('documents the global options and environment variables', () => {
    for (const option of Object.keys(globalOptions)) {
      if (option === 'help') continue
      skill.should.containEql(`--${option}`)
    }
    skill.should.containEql('WIKI_URL')
    skill.should.containEql('WIKI_TOKEN')
  })

  it('documents every exit code', () => {
    Object.values(exitCodes).forEach((code) => {
      skill.should.match(new RegExp(`\\| ${code} \\|`))
    })
  })

  it('teaches the safe edit workflow', () => {
    skill.should.containEql('--if-revision')
    skill.should.containEql('revisionId')
    skill.should.match(/read[\s\S]*?--json/i)
    skill.should.match(/reread|re-read/i)
    skill.should.containEql('--recursive')
  })

  it('stays at the behavior level (no implementation details)', () => {
    skill.should.not.match(/sqlite/i)
    skill.should.not.match(/\bSQL\b/)
    skill.should.not.match(/node_revisions/)
  })
})
