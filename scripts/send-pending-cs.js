#!/usr/bin/env node
/**
 * One-shot runner for the Pending CS daily report.
 *
 * Works anywhere with normal outbound network + env vars set:
 *   - GitHub Actions (see .github/workflows/pending-cs-daily.yml)
 *   - Any cron host / manual run:  node scripts/send-pending-cs.js
 *
 * Flags / env:
 *   --force                     Post regardless of the hour guard.
 *   --dry-run                   Fetch + print the report, do NOT post to Slack.
 *   PENDING_CS_ENFORCE_HOUR=9   Only post when it's this hour in PENDING_CS_TZ.
 *                               (Lets a workflow fire at both 06:00 & 07:00 UTC
 *                               and still post exactly once at 9 AM Israel time,
 *                               across daylight-saving changes.)
 */

const cs = require('../lib/pending-cs')

const argv = process.argv.slice(2)
const force = argv.includes('--force') || (process.env['PENDING_CS_FORCE'] || '') === 'true'
const dryRun = argv.includes('--dry-run')

function localHour(tz) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date()))
}

async function main() {
  const cfg = cs.getConfig()

  const enforce = process.env['PENDING_CS_ENFORCE_HOUR']
  if (!force && enforce !== undefined && enforce !== '') {
    const want = Number(enforce)
    const now = localHour(cfg.tz)
    if (now !== want) {
      console.log(`[pending-cs] hour guard: it's ${now}:00 in ${cfg.tz}, waiting for ${want}:00 — skipping this run.`)
      return
    }
  }

  if (!cs.isGithubConfigured(cfg)) {
    throw new Error('GitHub is not configured (GITHUB_TOKEN + GITHUB_PROJECT_OWNER/NUMBER).')
  }

  const report = await cs.generateReport(cfg)
  console.log(`[pending-cs] ${report.agingTickets} Pending CS tickets open >24h across ${report.totalAgents} agents` +
    (report.unassigned.count ? `, ${report.unassigned.count} unassigned.` : '.'))

  if (dryRun) {
    if (cfg.output === 'canvas') {
      console.log('\n--- DRY RUN: CANVAS ---\n' + cs.buildCanvasMarkdown(report, cfg))
      if (cfg.postCard) console.log('\n--- DRY RUN: CHANNEL CARD ---\n' + cs.buildPreviewCard(report, cfg).text)
    } else {
      console.log('\n--- DRY RUN (not posting) ---\n' + cs.formatSlackMessage(report, cfg).text)
    }
    return
  }

  if (cfg.output === 'canvas') {
    const result = await cs.postCanvas(report, cfg)
    console.log(`[pending-cs] channel canvas ${result.created ? 'created' : 'updated'} (${result.canvasId}).`)
    if (cfg.postCard) {
      const card = await cs.postPreviewCard(report, cfg)
      console.log(card ? `[pending-cs] posted preview card (notify: ${cfg.notify}).` : '[pending-cs] no webhook set — skipped preview card.')
    }
    return
  }

  if (!cs.isSlackConfigured(cfg)) {
    throw new Error('Slack is not configured (SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL).')
  }
  const result = await cs.postToSlack(cs.formatSlackMessage(report, cfg), cfg)
  console.log(`[pending-cs] posted to Slack via ${result.via}.`)
}

main().catch(err => {
  console.error('[pending-cs] failed:', err.message)
  process.exit(1)
})
