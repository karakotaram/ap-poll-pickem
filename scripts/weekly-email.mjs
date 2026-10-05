#!/usr/bin/env node
/* Weekly pool email.
 *
 * Generates the message and writes it to email.html; it does not send.
 * Delivery is the workflow's job, so the provider can change without
 * touching any of this.
 *
 *   DRY_RUN=1 node scripts/weekly-email.mjs     # write + print, send nothing
 *
 * After the standings, one short entry per player: the week's change and
 * what drove it, how long they have held their place, and the game of theirs
 * worth watching next. Every sentence is assembled from the poll, the poll
 * history and the schedule. Nothing is written by a model and nothing is
 * invented.
 * Points come from AP position: a win defends a ranking, it never earns
 * points, and nothing here says otherwise.
 */
import { readFile, writeFile } from 'node:fs/promises';

const DRY_RUN = process.env.DRY_RUN === '1';   // this script never sends; the flag only labels the log

const RANK_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons';
const SB_API   = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

const TIERS = [[1,1,25],[2,6,20],[7,10,15],[11,15,10],[16,20,5],[21,24,3],[25,25,2]];
const pointsForRank = r => (TIERS.find(t => r >= t[0] && r <= t[1]) || [,,0])[2];
const RV_SLOTS = 3, RV_BONUS = 2;

const jget = async u => {
  const r = await fetch(u, { headers: { 'user-agent': 'ap-poll-pickem/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};
// Also turns non-ASCII into numeric entities: the body must stay ASCII (see
// the check at the bottom), and ESPN spells some team names with accents.
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
                          .replace(/[^\x00-\x7f]/gu, c => `&#${c.codePointAt(0)};`);
const plural = n => (n === 1 ? '' : 's');

/* ---------- roster (single source of truth: index.html) ---------- */
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const pm = html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
if (!pm) { console.error('could not find payload in index.html'); process.exit(1); }
const { teams: TEAMS, roster: ROSTER } = JSON.parse(pm[1]);
const OWNER = {};
ROSTER.forEach(p => p.picks.forEach(id => OWNER[id] = p.name));
const tname = id => (TEAMS[id] ? TEAMS[id][0] : 'Team ' + id);

/* ---------- every poll this season ---------- */
const season = (() => { const d = new Date(); return d.getMonth() >= 1 ? d.getFullYear() : d.getFullYear() - 1; })();
const slots = [[1,1], ...Array.from({length:17}, (_,i) => [2, i+1]), [3,1]];
// Rolls every 5 minutes — dodges ESPN's CDN stale-while-revalidate window,
// which can serve poll-drop-Sunday runs a rankings copy from before the
// poll landed. Same trick as index.html and poll-gate.mjs.
const bust = Math.floor(Date.now() / 3e5);
const polls = (await Promise.all(slots.map(async ([t,w]) => {
  try {
    const d = await jget(`${RANK_API}/${season}/types/${t}/weeks/${w}/rankings/1?b=${bust}`);
    if (!d.ranks?.length) return null;
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
const prev = polls.length > 1 ? polls[polls.length - 2] : null;

const scoreMap = p => {
  const m = new Map();
  p.ranks.forEach(r => m.set(r.id, { pts: pointsForRank(r.rank), rank: r.rank, rv: null }));
  p.others.slice(0, RV_SLOTS).forEach((o, i) => {
    if (!m.has(o.id)) m.set(o.id, { pts: RV_BONUS, rank: null, rv: i + 1 });
  });
  return m;
};
const SM = scoreMap(poll);
const PM = prev ? scoreMap(prev) : null;

const standings = sm => {
  const rows = ROSTER.map(p => ({
    name: p.name,
    points: p.picks.reduce((a, id) => a + (sm.get(id)?.pts || 0), 0),
  })).sort((a,b) => b.points - a.points || a.name.localeCompare(b.name));
  let pl = 1;
  rows.forEach((r,i) => { if (i && r.points !== rows[i-1].points) pl = i + 1; r.place = pl; });
  return rows;
};
const NOW = standings(SM);
const WAS = PM ? standings(PM) : null;
const wasBy = {};
if (WAS) WAS.forEach(r => wasBy[r.name] = r);

/* ---------- what actually moved ---------- */
const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const signed = n => (n > 0 ? `+${n}` : `${n}`);
const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// A team move that changed its points, written as a past-tense clause.
const teamMove = id => {
  const a = PM?.get(id), b = SM.get(id);
  const ap = a?.pts || 0, bp = b?.pts || 0;
  if (ap === bp) return null;
  let how;
  if (a?.rank && b?.rank) how = `${b.rank < a.rank ? 'climbed' : 'slid'} from No. ${a.rank} to No. ${b.rank}`;
  else if (b?.rank)       how = `entered the poll at No. ${b.rank}`;
  else if (a?.rank)       how = b?.rv ? `dropped out of the poll to receiving votes` : `dropped out of the poll`;
  else if (b?.rv)         how = `moved into the top three receiving votes`;
  else                    how = `slipped out of the top three receiving votes`;
  return { id, delta: bp - ap, how };
};
const moves = [...new Set(ROSTER.flatMap(p => p.picks))].map(teamMove).filter(Boolean);

/* Spots moved in the poll whether or not a scoring tier was crossed — Missouri
   going from No. 22 to No. 14 is news even in a week it changes nobody's
   total. Entering or leaving the poll always counts as big. */
const BIG_MOVE = 4;
const rankMove = id => {
  if (!PM) return null;
  const a = PM.get(id)?.rank ?? null, b = SM.get(id)?.rank ?? null;
  if (a == null && b == null) return null;
  if (a == null) return { up: true,  big: true, from: null, to: b };
  if (b == null) return { up: false, big: true, from: a, to: null };
  if (a === b) return null;
  return { up: b < a, big: Math.abs(a - b) >= BIG_MOVE, from: a, to: b, spots: Math.abs(a - b) };
};

const playerDelta = name => {
  const p = ROSTER.find(x => x.name === name);
  return p.picks.reduce((a, id) => a + ((SM.get(id)?.pts || 0) - (PM?.get(id)?.pts || 0)), 0);
};
// Biggest first, but moves in the direction of the net come before the ones
// that went against it: "gained 3: Missouri climbed..., Florida slid...".
const drivers = name => {
  const p = ROSTER.find(x => x.name === name), net = Math.sign(playerDelta(name));
  const against = m => (net && Math.sign(m.delta) !== net ? 1 : 0);
  return moves.filter(m => p.picks.includes(m.id))
              .sort((a,b) => against(a) - against(b) || Math.abs(b.delta) - Math.abs(a.delta));
};

/* ---------- one short entry per player ----------
   Three sentences, each assembled from the poll, the poll history and the
   schedule: the week's change and what drove it, how long they have held
   their place, and the one game of theirs worth watching next. Nothing is
   predicted and a win is never said to earn points. Sentences have no
   subject ("Gained 5 points...") because the entry opens with the name. */
function weekText(r) {
  const p = ROSTER.find(x => x.name === r.name);
  if (!WAS) {
    const best = p.picks.map(id => ({ id, s: SM.get(id) })).filter(x => x.s?.pts)
                        .sort((a, b) => b.s.pts - a.s.pts)[0];
    return `Opens the season with ${r.points}` + (best
      ? `, the most from ${esc(tname(best.id))} at ${best.s.rank ? `No. ${best.s.rank}` : 'receiving votes'} (${best.s.pts}).`
      : `.`);
  }
  const d = playerDelta(r.name), ms = drivers(r.name);
  const named = ms.slice(0, 3).map(m => `${esc(tname(m.id))} ${m.how} (${signed(m.delta)})`);
  const rest = ms.length - named.length;
  const why = named.length ? `: ${andList(named)}${rest ? `, plus ${rest} other move${plural(rest)}` : ''}` : '';
  if (d > 0) return `Gained ${d} point${plural(d)} this week${why}.`;
  if (d < 0) return `Lost ${-d} point${plural(-d)} this week${why}.`;
  if (named.length) return `Even on the week${why}.`;
  // Nothing crossed a tier. Say what moved inside one, if anything did.
  const inside = p.picks.map(id => ({ id, m: rankMove(id) })).filter(x => x.m?.spots >= 2)
                        .sort((a, b) => b.m.spots - a.m.spots)[0];
  return inside
    ? `No change in points; ${esc(tname(inside.id))} ${inside.m.up ? 'moved up' : 'slipped'} from No. ${inside.m.from} ` +
      `to No. ${inside.m.to} without crossing a scoring tier.`
    : `No change in points this week.`;
}

// Standings after every poll this season, for "has led since Week 2".
const HIST = polls.map(p => ({
  label: p.label,
  by: Object.fromEntries(standings(scoreMap(p)).map(x => [x.name, x])),
}));
const pollName = l => (/^preseason$/i.test(l) ? 'the preseason poll' : l);
const placeName = n => (n === 1 ? 'first' : ordinal(n));
const isTied = r => NOW.filter(x => x.place === r.place).length > 1;

function placeText(r) {
  if (!WAS) return '';
  const now = r.place, was = wasBy[r.name].place;
  if (now !== was) {
    if (now === 1 && !isTied(r)) {
      const old = WAS.filter(x => x.place === 1).map(x => `<b>${esc(x.name)}</b>`);
      return `Takes over first from ${andList(old)}.`;
    }
    // A season high or low only means something once there are a few polls.
    const earlier = HIST.slice(0, -1).map(h => h.by[r.name].place);
    const note = earlier.length < 2 ? ''
               : now < Math.min(...earlier) ? ', a season high'
               : now > Math.max(...earlier) ? ', a season low' : '';
    return `${now < was ? 'Up' : 'Down'} from ${ordinal(was)} to ${isTied(r) ? 'a share of ' : ''}${placeName(now)}${note}.`;
  }
  let i = HIST.length - 1;
  while (i > 0 && HIST[i - 1].by[r.name].place === now) i--;
  const span = i === 0 ? 'in every poll this season' : `since ${pollName(HIST[i].label)}`;
  if (now === 1) return isTied(r) ? `Has been on top ${span}.` : `Has led ${span}.`;
  return `Has been ${placeName(now)} ${span}.`;
}

/* ---------- the week ahead ----------
   ESPN's "current" scoreboard week rolls over Monday around 3am ET, so on a
   poll-drop Sunday it still points at the week just played — every game
   final, nothing to preview. When the current week has no game left to play,
   advance one week (regular week 17 rolls into the postseason). One step
   only: if that week is empty too, the season is over and the current answer
   stands. Mirrored in generate-commentary.mjs and index.html — keep in sync. */
async function upcomingScoreboard() {
  const cur = await jget(`${SB_API}?groups=80&limit=300`);
  const hasPre = d => (d.events || [])
    .some(e => (e.competitions?.[0]?.status?.type?.state || 'pre') === 'pre');
  const t = cur.season?.type ?? 2, w = cur.week?.number ?? null;
  if (!(cur.events || []).length || hasPre(cur) || w == null) return cur;
  const [nt, nw] = t === 2 && w >= 17 ? [3, 1] : [t, w + 1];
  try {
    const nxt = await jget(`${SB_API}?groups=80&limit=300&week=${nw}&seasontype=${nt}`);
    if (nxt.events?.length) return nxt;
  } catch { /* season over — fall through */ }
  return cur;
}
const sb = await upcomingScoreboard();
const week = sb.week?.number ?? null;

/* The line from one team's side: negative means that team is favored. Read
   off ESPN's "details" string ("MIZ -3.5"), which names the favorite, so the
   sign never depends on remembering which side ESPN quotes from. */
const lineFor = (details, abbr) => {
  if (!details) return null;
  if (/^\s*(even|pk|pick)/i.test(details)) return 0;
  const m = /^\s*([A-Za-z&.'\- ]+?)\s*-\s*([\d.]+)\s*$/.exec(details);
  if (!m) return null;
  const n = parseFloat(m[2]);
  return m[1].trim().toUpperCase() === String(abbr || '').toUpperCase() ? -n : n;
};

// Each drafted team's game this week, seen from that team's side.
const NEXT = new Map();
for (const e of sb.events || []) {
  const c = e.competitions?.[0];
  if (!c || c.competitors?.length !== 2) continue;
  if ((c.status?.type?.state || 'pre') !== 'pre') continue;   // already played or underway
  for (const t of c.competitors) {
    const id = String(t.team?.id || '');
    if (!OWNER[id]) continue;
    const o = c.competitors.find(x => x !== t), oid = String(o.team?.id || '');
    NEXT.set(id, {
      where: c.neutralSite ? 'neutral' : t.homeAway,
      opp: { id: oid, name: o.team?.location || tname(oid), owner: OWNER[oid] || null, rank: SM.get(oid)?.rank ?? null },
      spread: lineFor(c.odds?.[0]?.details, t.team?.abbreviation),
    });
  }
}

const lineText = sp => {
  if (sp == null) return '';
  if (sp === 0) return ` in a pick'em`;
  const n = String(Number.isInteger(sp) ? Math.abs(sp) : Math.abs(sp).toFixed(1));
  // "an 8.5-point", "an 11-point", "an 18-point"
  const art = /^(8|11(?!\d)|18(?!\d))/.test(n) ? 'an' : 'a';
  return ` as ${art} ${n}-point ${sp < 0 ? 'favorite' : 'underdog'}`;
};

/* Which of a player's games to point at. Same instincts as the impact model
   the page uses — points carried, scaled up when the line is close — plus a
   bump for a team that just moved a lot (can it hold the jump?) and for an
   unranked team getting a ranked opponent. Another player's team on the
   other side counts extra when it carries points: that game moves two
   totals. */
function lookAhead(r) {
  const p = ROSTER.find(x => x.name === r.name);
  const opts = p.picks.filter(id => NEXT.has(String(id))).map(id => {
    const g = NEXT.get(String(id)), pts = SM.get(id)?.pts || 0, mv = rankMove(id);
    const vol = g.spread == null ? 1 : 0.25 + 1.75 * Math.exp(-Math.abs(g.spread) / 9);
    const rival = !!(g.opp.owner && g.opp.owner !== r.name);
    const both = rival && (SM.get(g.opp.id)?.pts || 0) > 0;
    const shot = SM.get(id)?.rank == null && g.opp.rank != null;
    return { id, g, pts, mv, rival, shot,
             score: pts * vol * (both ? 1.5 : 1) + (mv?.big ? 8 * vol : 0) + (shot ? 6 * vol : 0) };
  }).sort((a, b) => b.score - a.score);
  if (!opts.length) return `All six teams are off this week.`;

  const { id, g, pts, mv, rival, shot } = opts[0];
  const T = esc(tname(id));
  const opp = `${rival ? `<b>${esc(g.opp.owner)}</b>'s ` : ''}${g.opp.rank ? `No. ${g.opp.rank} ` : ''}${esc(g.opp.name)}`;
  const game = `${g.where === 'home' ? 'hosts' : g.where === 'away' ? 'visits' : 'plays'} ${opp}` +
               `${g.where === 'neutral' ? ' at a neutral site' : ''}${lineText(g.spread)}`;

  if (mv?.big && mv.up)   return mv.from == null
    ? `Will see if ${T} can stay in the poll when it ${game}.`
    : `Will see if ${T} can hold on to its jump to No. ${mv.to} when it ${game}.`;
  if (mv?.big && mv.to)   return `${T} tries to stop the slide when it ${game}.`;
  if (mv?.big)            return `${T} tries to get back into the poll when it ${game}.`;
  if (rival)              return `Head to head this week: ${T} ${game}.`;
  if (shot)               return `Unranked ${T} ${game}.`;
  if (g.opp.rank)         return `Biggest test: ${T}${pts ? `, worth ${pts},` : ''} ${game}.`;
  return `${T}${pts ? `, worth ${pts},` : ''} ${game}.`;
}

const entryText = r => [weekText(r), placeText(r), lookAhead(r)].filter(Boolean).join(' ');

/* ---------- render ---------- */
const P = '#111', MUT = '#6b7280', LINE = '#e5e7eb', BG = '#ffffff', ALT = '#f9fafb';
const GOOD = '#15803d', BAD = '#b91c1c';

const chgCell = name => {
  if (!WAS) return `<span style="color:${MUT}">&mdash;</span>`;
  const d = playerDelta(name);
  return d > 0 ? `<span style="color:${GOOD}">+${d}</span>`
       : d < 0 ? `<span style="color:${BAD}">${d}</span>`
       : `<span style="color:${MUT}">0</span>`;
};
const moveCell = name => {
  if (!WAS) return `<span style="color:${MUT}">&mdash;</span>`;
  const pm = wasBy[name].place - NOW.find(r => r.name === name).place;
  return pm > 0 ? `<span style="color:${GOOD}">&#9650; ${pm}</span>`
       : pm < 0 ? `<span style="color:${BAD}">&#9660; ${-pm}</span>`
       : `<span style="color:${MUT}">&ndash;</span>`;
};

const rows = NOW.map((r,i) => `
  <tr style="background:${i % 2 ? ALT : BG}">
    <td style="padding:9px 12px;color:${MUT};font-variant-numeric:tabular-nums">${r.place}</td>
    <td style="padding:9px 12px;font-weight:600">${esc(r.name)}</td>
    <td style="padding:9px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${r.points}</td>
    <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums">${chgCell(r.name)}</td>
    <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums">${moveCell(r.name)}</td>
  </tr>`).join('');

const entries = NOW.map(r => `
  <p style="font-size:14px;line-height:1.55;margin:0 0 12px">
    <b>${isTied(r) ? 'T-' : ''}${r.place}. ${esc(r.name)}</b> &mdash; ${entryText(r)}
  </p>`).join('');

const leaders = NOW.filter(r => r.place === 1);
const subject = `AP Poll Pick'em - ${poll.label}: ` +
  (leaders.length > 1
    ? `${leaders.map(r => r.name).join(' & ')} tied on ${leaders[0].points}`
    : `${leaders[0].name} leads on ${leaders[0].points}`);

const body = `
<div style="margin:0;padding:24px 12px;background:${ALT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${P}">
 <div style="max-width:600px;margin:0 auto;background:${BG};border:1px solid ${LINE};border-radius:14px;padding:26px 24px">

  <h1 style="margin:0 0 3px;font-size:20px;letter-spacing:-.01em">AP Poll Pick'em</h1>
  <div style="font-size:13px;color:${MUT};margin:0 0 22px">
    ${esc(poll.label)} AP Poll${week ? ` &middot; Week ${week} ahead` : ''} &middot; ${season} season
  </div>

  <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:${MUT};margin:0 0 9px">Standings</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid ${LINE};border-radius:8px">
    <thead>
      <tr style="background:${BG}">
        <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${MUT};border-bottom:1px solid ${LINE}">#</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${MUT};border-bottom:1px solid ${LINE}">Player</th>
        <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${MUT};border-bottom:1px solid ${LINE}">Pts</th>
        <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${MUT};border-bottom:1px solid ${LINE}">Chg</th>
        <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${MUT};border-bottom:1px solid ${LINE}">Move</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="font-size:11.5px;color:${MUT};margin:7px 0 22px">
    Chg is points against the ${prev ? esc(prev.label) : 'previous'} poll. Move is places gained or lost.
  </div>

  <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:${MUT};margin:0 0 11px">The field</h2>
  ${entries}

  <div style="margin-top:22px;padding-top:14px;border-top:1px solid ${LINE};font-size:12px;color:${MUT}">
    <a href="https://karakotaram.github.io/ap-poll-pickem/" style="color:#2563eb;text-decoration:none">Full standings, payouts and every drafted team &rarr;</a>
  </div>

 </div>
</div>`;

// A stray literal em-dash renders as mojibake in any client that guesses the
// charset, so keep the body ASCII and let entities carry the punctuation.
const stray = [...body].filter(ch => ch.charCodeAt(0) > 127);
if (stray.length) {
  console.error(`non-ASCII in body: ${[...new Set(stray)].map(c => JSON.stringify(c)).join(' ')} ` +
                `— use HTML entities instead`);
  process.exit(1);
}

await writeFile(new URL('../email.html', import.meta.url), body, 'utf8');
await writeFile(new URL('../email-subject.txt', import.meta.url), subject, 'utf8');

const plain = s => s.replace(/<[^>]+>/g, '').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–')
                    .replace(/&middot;/g,'·').replace(/&amp;/g,'&').replace(/&rarr;/g,'→')
                    .replace(/&#9650;/g,'▲').replace(/&#9660;/g,'▼').replace(/\s+/g,' ').trim();
console.log(`subject: ${subject}`);
console.log(`poll: ${poll.label}${prev ? `  (change vs ${prev.label})` : '  (first poll of the season)'}`);
console.log(`\nstandings:`);
NOW.forEach(r => console.log(`  ${String(r.place).padStart(2)}. ${r.name.padEnd(7)} ${String(r.points).padStart(3)}` +
  `  ${plain(chgCell(r.name)).padStart(3)}  ${plain(moveCell(r.name))}`));
console.log(`\nthe field:`);
NOW.forEach(r => console.log(`  ${isTied(r) ? 'T-' : ''}${r.place}. ${r.name} - ${plain(entryText(r))}`));
console.log(`\nwrote email.html (${body.length} bytes)${DRY_RUN ? ' — DRY_RUN, nothing sent' : ''}`);
