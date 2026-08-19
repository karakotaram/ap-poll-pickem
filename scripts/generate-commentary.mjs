#!/usr/bin/env node
/**
 * Generates columnist-style blurbs for the week's highest-impact games and
 * writes them to commentary.json.
 *
 * Runs in CI only — the Groq key never reaches the browser. The site treats
 * commentary.json as optional: if this script fails or never runs, the page
 * falls back to its built-in rule-based text.
 *
 * The roster is read out of index.html so there is exactly one source of truth.
 */
import { readFile, writeFile } from 'node:fs/promises';

const GROQ_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const N_GAMES    = 6;   // page shows 3; extra cover it picking a slightly different set

const DRY_RUN = process.env.DRY_RUN === '1';   // build the payload, skip the API call

if (!DRY_RUN) {
  // Distinguish "missing" from "present but empty" — `gh secret set` with no
  // stdin silently stores an empty string, which is otherwise invisible in CI
  // logs because there is nothing for GitHub to mask.
  if (GROQ_KEY === undefined) {
    console.error('GROQ_API_KEY is not set at all. Add it as a repository secret.');
    process.exit(1);
  }
  if (!GROQ_KEY.trim()) {
    console.error('GROQ_API_KEY is set but EMPTY — the secret was stored with no value.');
    console.error('Re-add it via the web UI (Settings > Secrets and variables > Actions)');
    console.error('or from an interactive terminal: gh secret set GROQ_API_KEY --repo <owner>/<repo>');
    process.exit(1);
  }
  if (!/^gsk_/.test(GROQ_KEY.trim())) {
    console.warn('warning: GROQ_API_KEY does not start with "gsk_" — check you pasted the right value.');
  }
}

const RANK_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons';
const SB_API   = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

const TIERS = [[1,1,25],[2,6,20],[7,10,15],[11,15,10],[16,20,5],[21,24,3],[25,25,2]];
const pointsForRank = r => (TIERS.find(t => r >= t[0] && r <= t[1]) || [,,0])[2];
const tierOf = r => TIERS.find(t => r >= t[0] && r <= t[1]);
const nextDownPts = r => {
  const i = TIERS.findIndex(t => r >= t[0] && r <= t[1]);
  return i < 0 ? 0 : (i + 1 < TIERS.length ? TIERS[i+1][2] : 2);
};

const jget = async (u) => {
  const r = await fetch(u, { headers: { 'user-agent': 'ap-poll-pickem/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};

/* ---------- roster (single source of truth: index.html) ---------- */
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const pm = html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
if (!pm) { console.error('could not find payload in index.html'); process.exit(1); }
const { teams: TEAMS, roster: ROSTER } = JSON.parse(pm[1]);
const OWNER = {};
ROSTER.forEach(p => p.picks.forEach(id => OWNER[id] = p.name));

/* ---------- latest AP poll ---------- */
const season = (() => { const d = new Date(); return d.getMonth() >= 1 ? d.getFullYear() : d.getFullYear() - 1; })();
const slots = [[1,1], ...Array.from({length:17}, (_,i) => [2, i+1]), [3,1]];
const polls = (await Promise.all(slots.map(async ([t,w]) => {
  try {
    const d = await jget(`${RANK_API}/${season}/types/${t}/weeks/${w}/rankings/1`);
    if (!d.ranks || !d.ranks.length) return null;
    const id = ref => (/teams\/(\d+)/.exec(ref || '') || [])[1];
    return {
      order: t*100 + w,
      label: d.occurrence?.displayValue || `Week ${w}`,
      ranks: d.ranks.map(r => ({ id: id(r.team?.$ref), rank: r.current })).filter(x => x.id),
      others: (d.others || []).map(o => ({ id: id(o.team?.$ref), votes: o.points || 0 }))
                              .filter(x => x.id).sort((a,b) => b.votes - a.votes),
    };
  } catch { return null; }
}))).filter(Boolean).sort((a,b) => a.order - b.order);

if (!polls.length) { console.error('no AP poll available'); process.exit(1); }
const poll = polls[polls.length - 1];

const SM = new Map();
poll.ranks.forEach(r => SM.set(r.id, { pts: pointsForRank(r.rank), rank: r.rank }));
poll.others.slice(0, 3).forEach((o, i) => { if (!SM.has(o.id)) SM.set(o.id, { pts: 2, rank: null, rv: i+1 }); });

/* ---------- this week's games, ranked by pool impact ----------
   Mirrors analyze() in index.html — keep the two in sync.        */
const sb = await jget(`${SB_API}?groups=80&limit=300`);
const week = sb.week?.number ?? null;

const games = (sb.events || []).map(e => {
  const c = e.competitions?.[0]; if (!c || c.competitors?.length !== 2) return null;
  const side = ha => {
    const t = c.competitors.find(x => x.homeAway === ha) || c.competitors[0];
    const id = t.team?.id, sc = SM.get(id) || {};
    return { id, name: t.team?.location || '', abbr: t.team?.abbreviation || '',
             record: t.records?.[0]?.summary || '', rank: sc.rank ?? null, rv: sc.rv ?? null,
             points: sc.pts || 0, owner: OWNER[id] || null };
  };
  const away = side('away'), home = side('home');
  const owned = [away, home].filter(s => s.owner);
  if (!owned.length) return null;

  const od = c.odds?.[0] || {};
  const sp = od.spread == null ? null : Math.abs(od.spread);
  const atRisk = owned.reduce((a, b) => a + b.points, 0);
  const owners = new Set(owned.map(s => s.owner));
  const h2h = owned.length === 2 && owners.size === 2;
  const vol = sp == null ? 1.0 : 0.25 + 1.75 * Math.exp(-sp / 9);
  const upset = owned.some(s => !s.points) && [away, home].some(s => s.rank) ? 8 * vol : 0;

  const tierNotes = owned.filter(s => s.rank).map(s => {
    const t = tierOf(s.rank);
    return `${s.name} is No.${s.rank}, in the ${t[0]}-${t[1]} band worth ${t[2]} pts to ${s.owner}; one tier down is ${nextDownPts(s.rank)} pts`;
  });

  return {
    impact: atRisk * vol * (h2h ? 1.8 : 1) + upset,
    facts: {
      id: e.id, matchup: e.name, kickoff: e.date,
      state: c.status?.type?.state || 'pre',
      line: od.details || null, overUnder: od.overUnder ?? null,
      tv: c.broadcasts?.[0]?.names?.[0] || null,
      venue: c.venue?.fullName || null, neutralSite: !!c.neutralSite,
      conferenceGame: !!c.conferenceCompetition,
      eventName: (c.notes || []).find(n => n.headline &&
        !/^(FLEX|EARLY|LATE|TBD|AFTERNOON|NIGHT|MORNING|PRIMETIME)\b/i.test(n.headline))?.headline || null,
      away, home,
      poolPointsAtStake: atRisk,
      headToHead: h2h,
      sameOwnerBothSides: owned.length === 2 && owners.size === 1,
      tierNotes,
    },
  };
}).filter(Boolean)
  .sort((a, b) => b.impact - a.impact)
  .slice(0, N_GAMES);

if (!games.length) { console.log('no pool-relevant games this week — nothing to write'); process.exit(0); }

/* ---------- ask Groq ---------- */
const SYSTEM = `You write a short weekly column for an eight-person college football pick'em pool.

THE POOL: ${ROSTER.map(p => p.name).join(', ')}. Each drafted six teams before the season and scores off the AP Top 25 every week: 25 pts for No.1, 20 for Nos.2-6, 15 for 7-10, 10 for 11-15, 5 for 16-20, 3 for 21-24, 2 for No.25, 2 for a top-3 also-receiving-votes team. $200 buy-in each, $1,600 pot, paid on the final poll before the playoffs (40%) and the final poll after (60%).

VOICE: you're in the group chat, not on television. Needle these guys by name. Dry, confident, funny, a little mean. Short punchy sentences. No hype-man cliches ("all eyes on", "must-win", "buckle up", "for the ages"), no exclamation marks, no emoji, no rhetorical questions.

HARD RULES:
- Use ONLY the facts in the JSON you are given. You have no other knowledge of these teams.
- Never invent statistics, records, injuries, quotes, coaches, players, or history.
- Never predict a final score.
- Refer to owners by the exact names above.
- 2-3 sentences per game, 45 words max each. Plain text only, no markdown.

Return ONLY a JSON object mapping each game id to its blurb string: {"401756789": "..."}.`;

const body = {
  model: GROQ_MODEL,
  temperature: 0.85,
  max_tokens: 1600,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `AP poll in effect: ${poll.label}. Week ${week ?? '?'} games, highest pool impact first:\n\n${JSON.stringify(games.map(g => g.facts), null, 1)}` },
  ],
};

if (DRY_RUN) {
  console.log('--- SYSTEM PROMPT ---\n' + SYSTEM);
  console.log('\n--- FACTS (' + games.length + ' games) ---');
  console.log(JSON.stringify(games.map(g => g.facts), null, 1));
  console.log('\nDRY RUN — no Groq call made, commentary.json untouched.');
  process.exit(0);
}

let out = {};
try {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${GROQ_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const parsed = JSON.parse(d.choices?.[0]?.message?.content || '{}');
  const valid = new Set(games.map(g => g.facts.id));
  for (const [k, v] of Object.entries(parsed)) {
    if (valid.has(String(k)) && typeof v === 'string' && v.trim()) out[String(k)] = v.trim().slice(0, 400);
  }
  if (!Object.keys(out).length) throw new Error('model returned no usable blurbs');
} catch (err) {
  // Never break the site: leave the previous commentary.json in place.
  console.error('generation failed:', err.message);
  process.exit(1);
}

await writeFile(new URL('../commentary.json', import.meta.url), JSON.stringify({
  generated: new Date().toISOString(),
  model: GROQ_MODEL,
  season, week, poll: poll.label,
  games: out,
}, null, 2) + '\n');

console.log(`wrote commentary.json — week ${week}, ${Object.keys(out).length} blurbs, model ${GROQ_MODEL}`);
