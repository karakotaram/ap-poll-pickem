#!/usr/bin/env node
/* Weekly pool email.
 *
 * Generates the message and writes it to email.html; it does not send.
 * Delivery is the workflow's job, so the provider can change without
 * touching any of this.
 *
 *   DRY_RUN=1 node scripts/weekly-email.mjs     # write + print, send nothing
 *
 * Every sentence is assembled from the poll and the schedule. Nothing is
 * written by a model and nothing is invented — same rule as the page.
 * Points come from AP position: a win defends a ranking, it never earns
 * points, and nothing here says otherwise.
 */
import { readFile, writeFile } from 'node:fs/promises';

const DRY_RUN = process.env.DRY_RUN === '1';   // this script never sends; the flag only labels the log

const RANK_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons';
const SB_API   = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const N_GAMES  = 3;

const TIERS = [[1,1,25],[2,6,20],[7,10,15],[11,15,10],[16,20,5],[21,24,3],[25,25,2]];
const pointsForRank = r => (TIERS.find(t => r >= t[0] && r <= t[1]) || [,,0])[2];
const RV_SLOTS = 3, RV_BONUS = 2;

const jget = async u => {
  const r = await fetch(u, { headers: { 'user-agent': 'ap-poll-pickem/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
const polls = (await Promise.all(slots.map(async ([t,w]) => {
  try {
    const d = await jget(`${RANK_API}/${season}/types/${t}/weeks/${w}/rankings/1`);
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
const teamMove = id => {
  const a = PM?.get(id), b = SM.get(id);
  const ap = a?.pts || 0, bp = b?.pts || 0;
  if (ap === bp) return null;
  let how;
  if (a?.rank && b?.rank)      how = `from No. ${a.rank} to No. ${b.rank}`;
  else if (b?.rank && !a?.rank) how = a?.rv ? `into the poll at No. ${b.rank}` : `entering the poll at No. ${b.rank}`;
  else if (a?.rank && !b?.rank) how = b?.rv ? `out of the poll and down to receiving votes` : `out of the poll entirely`;
  else if (b?.rv && !a?.rv)     how = `into the top three receiving votes`;
  else                          how = `out of the top three receiving votes`;
  return { id, delta: bp - ap, how };
};
const moves = [...new Set(ROSTER.flatMap(p => p.picks))].map(teamMove).filter(Boolean);

const playerDelta = name => {
  const p = ROSTER.find(x => x.name === name);
  return p.picks.reduce((a, id) => a + ((SM.get(id)?.pts || 0) - (PM?.get(id)?.pts || 0)), 0);
};
const drivers = name => {
  const p = ROSTER.find(x => x.name === name);
  return moves.filter(m => p.picks.includes(m.id)).sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));
};

/* Two or three sentences on the standings, each only when it has something to
   say. Written from the numbers above, not about them. */
function changeText() {
  if (!WAS) return `First poll of the season, so there is nothing to compare against yet. ` +
                   `<b>${esc(NOW[0].name)}</b> opens on top with ${NOW[0].points}.`;

  const out = [];
  const lead = NOW[0], oldLead = WAS[0];
  const tiedTop = NOW.filter(r => r.points === lead.points);
  const gap = NOW.find(r => r.points < lead.points);
  const margin = gap ? lead.points - gap.points : 0;

  if (tiedTop.length > 1)
    out.push(`<b>${tiedTop.map(r => esc(r.name)).join('</b> and <b>')}</b> are tied at the top on ${lead.points}.`);
  else if (oldLead.name !== lead.name)
    out.push(`<b>${esc(lead.name)}</b> has taken the lead from <b>${esc(oldLead.name)}</b>, ${lead.points} to ${wasBy[lead.name] ? NOW.find(r => r.name === oldLead.name).points : oldLead.points}.`);
  else
    out.push(`<b>${esc(lead.name)}</b> still leads on ${lead.points}` +
             (margin ? `, ${margin} clear of <b>${esc(gap.name)}</b>.` : `.`));

  const byDelta = ROSTER.map(p => ({ name: p.name, d: playerDelta(p.name) })).sort((a,b) => b.d - a.d);
  const signed = n => (n > 0 ? `+${n}` : `${n}`);
  const names = list => list.length > 1
    ? `<b>${list.slice(0,-1).map(x => esc(x.name)).join('</b>, <b>')}</b> and <b>${esc(list[list.length-1].name)}</b>`
    : `<b>${esc(list[0].name)}</b>`;
  // whoever shares the extreme shares the sentence; naming one of two players
  // who both moved -3 just picks arbitrarily
  const tiedAt = v => byDelta.filter(x => x.d === v);
  const bestDriver = list => list.flatMap(x => drivers(x.name))
                                 .sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta))[0];

  const up = tiedAt(byDelta[0].d);
  if (up[0].d > 0) {
    const d = bestDriver(up);
    out.push(`${names(up)} gained the most, +${up[0].d}${up.length > 1 ? ' each' : ''}` +
             (d ? `, led by ${esc(tname(d.id))} ${d.how} (${signed(d.delta)}).` : `.`));
  }
  const down = tiedAt(byDelta[byDelta.length - 1].d);
  if (down[0].d < 0) {
    const d = bestDriver(down);
    out.push(`${names(down)} gave back ${-down[0].d}${down.length > 1 ? ' apiece' : ''}` +
             (d ? `, with ${esc(tname(d.id))} ${d.how} (${signed(d.delta)}).` : `.`));
  }
  if (out.length === 1) out.push(`No one's total moved &mdash; the poll shuffled without crossing a scoring tier.`);
  return out.join(' ');
}

/* ---------- the week ahead ---------- */
const sb = await jget(`${SB_API}?groups=80&limit=300`);
const week = sb.week?.number ?? null;

const games = (sb.events || []).map(e => {
  const c = e.competitions?.[0]; if (!c || c.competitors?.length !== 2) return null;
  const side = ha => {
    const t = c.competitors.find(x => x.homeAway === ha) || c.competitors[0];
    const id = t.team?.id, sc = SM.get(id) || {};
    return { id, name: t.team?.location || '', rank: sc.rank ?? null, rv: sc.rv ?? null,
             points: sc.pts || 0, owner: OWNER[id] || null };
  };
  const away = side('away'), home = side('home');
  const owned = [away, home].filter(s => s.owner);
  if (!owned.length) return null;
  const od = c.odds?.[0] || {};
  const sp = od.spread == null ? null : Math.abs(od.spread);
  const atRisk = owned.reduce((a,b) => a + b.points, 0);
  const owners = new Set(owned.map(s => s.owner));
  const h2h = owned.length === 2 && owners.size === 2;
  const vol = sp == null ? 1.0 : 0.25 + 1.75 * Math.exp(-sp / 9);
  const upset = owned.some(s => !s.points) && [away, home].some(s => s.rank) ? 8 * vol : 0;
  return {
    impact: atRisk * vol * (h2h ? 1.8 : 1) + upset,
    id: String(e.id || ''),
    away, home, owned, h2h, atRisk,
    kickoff: e.date, timeValid: c.timeValid !== false,
    line: od.details || null, tv: c.broadcasts?.[0]?.names?.[0] || null,
    state: c.status?.type?.state || 'pre',
  };
}).filter(Boolean)
  .filter(g => g.state === 'pre')            // an email about games already played is useless
  .sort((a,b) => b.impact - a.impact)
  .slice(0, N_GAMES);

const rankTag = s => s.rank ? `No. ${s.rank} ` : s.rv ? `ARV ` : '';
// the email has no colour swatches to lean on, so name the owner inline
const teamLabel = s => `${rankTag(s)}${s.name}${s.owner ? ` (${s.owner})` : ''}`;
const kickText = g => {
  const d = new Date(g.kickoff);
  if (isNaN(d)) return '';
  const opt = { weekday:'short', month:'numeric', day:'numeric', timeZone:'America/New_York' };
  if (!g.timeValid) return d.toLocaleDateString('en-US', opt) + ' · time TBD';
  return d.toLocaleString('en-US', { ...opt, hour:'numeric', minute:'2-digit' }) + ' ET';
};

/* The site's column, reused verbatim so the email and the page never say two
   different things about the same game. Same freshness rules the page applies:
   written for the week on screen, and under 8 days old. Falls back per game to
   the built-in line, so a rejected blurb costs the email nothing. */
let COLUMN = null;
try {
  const c = JSON.parse(await readFile(new URL('../commentary.json', import.meta.url), 'utf8'));
  const ageDays = (Date.now() - new Date(c.generated).getTime()) / 864e5;
  if (c && c.games && typeof c.games === 'object' && ageDays >= 0 && ageDays < 8) COLUMN = c;
} catch { /* no column today; the built-in line covers it */ }
const columnUsable = () => !!(COLUMN && (week == null || COLUMN.week === week));

/* Model text is escaped first, then typographic characters become entities —
   the body is required to be ASCII and a stray curly apostrophe would other-
   wise fail the build. Only known roster names are re-emphasised afterwards,
   so nothing the model writes can inject markup. */
function columnHtml(text) {
  let h = esc(String(text))
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '&mdash;').replace(/\u2013/g, '&ndash;')
    .replace(/\u2026/g, '...').replace(/\u00a0/g, ' ');
  ROSTER.forEach(p => {
    const n = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    h = h.replace(new RegExp('(^|[^A-Za-z<])(' + n + ')\\b', 'g'), '$1<b>$2</b>');
  });
  return h;
}

/* Why this game matters, in one line — the fallback when no blurb survived. */
function whyText(g) {
  const byRisk = g.owned.slice().sort((a,b) => b.points - a.points);
  if (g.h2h) {
    const [hi, lo] = byRisk;
    return lo.points
      ? `${g.atRisk} pool points on the field, split ${hi.points}&ndash;${lo.points}.`
      : `Every point here is <b>${esc(hi.owner)}</b>'s &mdash; ${esc(hi.name)} carries ${hi.points}, ${esc(lo.name)} nothing.`;
  }
  const x = byRisk[0];
  const foe = [g.away, g.home].find(s => s !== x);
  return x.points
    ? `<b>${esc(x.owner)}</b> has ${x.points} riding on ${esc(x.name)}${foe?.rank ? ` against No. ${foe.rank}` : ''}.`
    : `${esc(x.name)} is off the board for <b>${esc(x.owner)}</b>${foe?.rank ? `; No. ${foe.rank} ${esc(foe.name)} is the measuring stick` : ''}.`;
}

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

const gameBlocks = games.length ? games.map(g => `
  <div style="border:1px solid ${LINE};border-radius:10px;padding:13px 15px;margin:0 0 10px">
    <div style="font-weight:600;font-size:15px;color:${P}">
      ${esc(teamLabel(g.away))} at ${esc(teamLabel(g.home))}
    </div>
    <div style="font-size:12.5px;color:${MUT};margin:4px 0 7px">
      ${esc(kickText(g))}${g.tv ? ' &middot; ' + esc(g.tv) : ''}${g.line ? ' &middot; ' + esc(g.line) : ''}
    </div>
    <div style="font-size:13.5px;color:#374151;line-height:1.5">${
      (columnUsable() && COLUMN.games[g.id]) ? columnHtml(COLUMN.games[g.id]) : whyText(g)}</div>
  </div>`).join('')
  : `<p style="color:${MUT}">No pool-relevant games on the board yet.</p>`;

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

  <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:${MUT};margin:0 0 9px">What moved</h2>
  <p style="font-size:14px;line-height:1.6;margin:0 0 22px">${changeText()}</p>

  <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:${MUT};margin:0 0 9px">Games that matter</h2>
  ${gameBlocks}

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
console.log(`\nwhat moved:\n  ${plain(changeText())}`);
console.log(`\ngames (${games.length}):`);
games.forEach(g => {
  console.log(`  ${teamLabel(g.away)} at ${teamLabel(g.home)}  —  ${kickText(g)}${g.line ? ' · ' + g.line : ''}`);
  const b = (columnUsable() && COLUMN.games[g.id]) ? COLUMN.games[g.id] : null;
  console.log(`    ${b ? '[column] ' : '[built-in] '}${plain(b ? columnHtml(b) : whyText(g))}`);
});
console.log(`\nwrote email.html (${body.length} bytes)${DRY_RUN ? ' — DRY_RUN, nothing sent' : ''}`);
