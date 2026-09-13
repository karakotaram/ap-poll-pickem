#!/usr/bin/env node
/* Poll gate — has an AP poll landed that we haven't processed yet?
 *
 * The Poll watch workflow runs this several times around the Sunday release
 * window. It compares the latest poll ESPN has against the marker committed
 * in .github/poll-state.json and answers through GitHub outputs:
 *
 *   new=true    a fresh, unprocessed poll is up — generate the column and
 *               send the email, then record it with `mark`
 *   adopt=true  an unprocessed poll exists but it is days old (the repo was
 *               merged or fixed late) — record it without emailing, because
 *               a stale "news" email is worse than none
 *   neither     nothing to do
 *
 * Modes:
 *   node scripts/poll-gate.mjs                        decide (writes nothing)
 *   node scripts/poll-gate.mjs mark <season> <order> <label>   write marker
 *
 * FORCE=1 treats the latest poll as new whatever the marker says — the
 * workflow_dispatch escape hatch for resending. MAX_AGE_DAYS (default 3)
 * bounds how old a poll can be and still trigger the email.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises';

const RANK_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons';
const MARKER = new URL('../.github/poll-state.json', import.meta.url);
const MAX_AGE_DAYS = process.env.MAX_AGE_DAYS === undefined ? 3 : Number(process.env.MAX_AGE_DAYS);
const FORCE = process.env.FORCE === '1';

const season = (() => { const d = new Date(); return d.getMonth() >= 1 ? d.getFullYear() : d.getFullYear() - 1; })();

// Labels come from ESPN — data, not something to hand a shell unfiltered.
const cleanLabel = s => String(s).replace(/[^A-Za-z0-9 .\-]/g, '').slice(0, 40).trim() || 'AP Poll';

async function output(kv) {
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
  console.log(lines.map(l => '  -> ' + l).join('\n'));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

async function writeMarker(m) {
  await writeFile(MARKER, JSON.stringify(m, null, 2) + '\n', 'utf8');
  console.log(`marker <- season ${m.season}, order ${m.order} (${m.label})`);
}

if (process.argv[2] === 'mark') {
  const [, , , s, o, l] = process.argv;
  if (!s || !o || !l) { console.error('usage: poll-gate.mjs mark <season> <order> <label>'); process.exit(1); }
  await writeMarker({ season: +s, order: +o, label: cleanLabel(l), processedAt: new Date().toISOString() });
  process.exit(0);
}

/* ---------- latest poll ESPN has ---------- */
const jget = async u => {
  const r = await fetch(u, { headers: { 'user-agent': 'ap-poll-pickem/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};
const slots = [[1, 1], ...Array.from({ length: 17 }, (_, i) => [2, i + 1]), [3, 1]];
// Rolls every 5 minutes — dodges ESPN's CDN stale-while-revalidate window,
// which otherwise can answer "no ranks yet" for up to two hours after the
// poll drops. This gate exists to catch the poll minutes after release, so
// it must not read a stale edge. Same trick as index.html.
const bust = Math.floor(Date.now() / 3e5);
const polls = (await Promise.all(slots.map(async ([t, w]) => {
  try {
    const d = await jget(`${RANK_API}/${season}/types/${t}/weeks/${w}/rankings/1?b=${bust}`);
    if (!d.ranks?.length) return null;
    return {
      order: t * 100 + w,
      label: cleanLabel(d.occurrence?.displayValue || `Week ${w}`),
      date: d.date || d.lastUpdated || null,
    };
  } catch { return null; }
}))).filter(Boolean).sort((a, b) => a.order - b.order);

if (!polls.length) {
  console.log(`no AP poll available for ${season} yet`);
  await output({ new: false, adopt: false });
  process.exit(0);
}
const latest = polls[polls.length - 1];
const ageDays = latest.date ? (Date.now() - new Date(latest.date).getTime()) / 864e5 : null;
console.log(`latest poll: ${latest.label} (order ${latest.order}, season ${season}` +
            `${ageDays == null ? '' : `, ${ageDays.toFixed(1)} days old`})`);

let marker = null;
try { marker = JSON.parse(await readFile(MARKER, 'utf8')); } catch { console.log('no marker on record'); }
if (marker) console.log(`marker: ${marker.label} (order ${marker.order}, season ${marker.season})`);

const processed = !!marker && marker.season === season && marker.order >= latest.order;
const fresh = ageDays == null || ageDays <= MAX_AGE_DAYS;

const base = { season, order: latest.order, label: latest.label };
if (FORCE) {
  console.log('FORCE=1 — treating the latest poll as new');
  await output({ ...base, new: true, adopt: false });
} else if (processed) {
  console.log('already processed — nothing to do');
  await output({ ...base, new: false, adopt: false });
} else if (fresh) {
  console.log('new poll — go');
  await output({ ...base, new: true, adopt: false });
} else {
  console.log(`unprocessed but ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}) — ` +
              'recording it without emailing');
  await output({ ...base, new: false, adopt: true });
}
