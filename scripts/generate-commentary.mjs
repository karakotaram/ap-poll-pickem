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

if (process.env.LIST_MODELS === '1') {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { authorization: `Bearer ${GROQ_KEY}` } });
  const d = await r.json();
  (d.data || []).map(m => `${m.id}  ctx=${m.context_window ?? '?'}  owner=${m.owned_by ?? '?'}`)
                .sort().forEach(l => console.log(l));
  process.exit(0);
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
             nickname: t.team?.name || '',
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

// Real standings, so any claim about the race is grounded instead of guessed.
const STANDINGS = ROSTER.map(p => ({
  name: p.name,
  points: p.picks.reduce((a, id) => a + (SM.get(id)?.pts || 0), 0),
})).sort((a, b) => b.points - a.points);
let pl = 1;
STANDINGS.forEach((r, i) => { if (i && r.points !== STANDINGS[i-1].points) pl = i + 1; r.place = pl; });

// Spell the venue situation out; a raw boolean gets skimmed past.
games.forEach(({ facts: f }) => {
  f.venueNote = f.neutralSite
    ? `NEUTRAL SITE at ${f.venue} — neither team is at home. Do not claim home-field advantage.`
    : `${f.home.name} is at home at ${f.venue}.`;
});

/* ---------- ask Groq ---------- */
const ANGLES = [
  'lead with a verdict on somebody\'s draft pick, using the line as evidence rather than as information',
  'lead with the asymmetry — name who is playing with house money and who actually has something to lose',
  'lead by naming the owner who looks worst if this goes wrong',
  'lead with what one owner is exposed to that the other simply is not',
  'lead with the distance between what somebody thought they drafted and what they actually have',
  'lead with a flat, unhedged read on one owner\'s weekend',
];

const SYSTEM = `You write a short weekly column for an eight-person college football pick'em pool.

THE POOL: ${ROSTER.map(p => p.name).join(', ')}. Each drafted six teams before the season and scores off the AP Top 25 weekly: 25 pts for No.1, 20 for Nos.2-6, 15 for 7-10, 10 for 11-15, 5 for 16-20, 3 for 21-24, 2 for No.25, 2 for a top-3 also-receiving-votes team. $200 each, $1,600 pot, paid on the final poll before the playoffs (40%) and after (60%).

THE SPREAD HAS NOTHING TO DO WITH POINTS. Pool points come from AP poll position. Covering a spread earns nobody anything; failing to cover costs nobody anything. The line is only evidence about how good a team is. Never write that a margin, a cover, or a blowout wins or loses pool points.

WHAT THE LINE MEANS — a line like "ND -20.5" means Notre Dame is FAVOURED and must win by more than 20.5. The favourite is never "facing a hole", "in a deficit", "an underdog", or "climbing back"; that is the other team's position. A favourite can only "fail to cover", "blow a cushion", or "win without covering". Get this backwards and the blurb is thrown away.

HOW SCORING ACTUALLY WORKS — you have been getting this wrong. Points come from where a team sits in the AP poll, NOT from winning a game. Winning a game adds nothing; it defends a team's existing ranking. Losing subtracts nothing directly; it risks the team sliding in next week's poll, and the slide is where points are lost. So never write that someone "gains 15 points" by covering, or "collects" points by winning. The correct framing is exposure: the owner of a highly ranked team has points to LOSE, and the owner of an unranked team has nothing to lose and something to gain only if their team climbs into the poll.

CRITICAL — YOU ARE NOT A SCOREBOARD. The card directly above your text already shows the reader: both teams' ranks, both owners, both point values, the total at stake, the betting line, the TV network, and the venue. Restating ANY of those as information is wasted words. "Doak Campbell Stadium hosts the clash, televised on ESPN" tells the reader nothing they cannot see. "Murph's Louisville is No.24, worth 3 points" is worse.

Use those facts as the PREMISE of a verdict or a joke, never as the content. The reader has the numbers; you supply the opinion about them.

Weak (recitation):  "SMU -2.5 puts Jim's five-point draft on the line while Merc's Florida State carries zero pool value."
Strong (a take):    "The market has Jim's third-rounder as a road favorite over a team Merc apparently drafted on purpose. Two and a half points is not much of a moat."

Never name the TV network or the stadium unless it is the actual joke.

VOICE: you're in the group chat, not on television. Needle these guys by name. Dry, confident, funny, a little mean. Short sentences. Never explain the joke.

BANNED: hype cliches ("all eyes on", "must-win", "buckle up", "for the ages", "brings nothing to the table", "watch his hopes evaporate"), exclamation marks, emoji, rhetorical questions, em-dash-heavy constructions, and opening two blurbs the same way.

STYLE SAMPLES — match this register, never reuse the content:
- "Ty is favoured by nearly a touchdown and still has more to lose than anyone on the card. That is what happens when you draft the ninth-best team and get asked to prove it in week one."
- "Merc is getting points at home and it still feels generous. Jim drafted better and the market agrees, which is the worst possible combination for Merc's weekend."
- "Twenty and a half is not a spread, it is an opinion. Ty took Wisconsin anyway, and now gets to sit with that in front of everyone."

HARD RULES:
- Use ONLY the facts in the JSON provided. You have no other knowledge of these teams.
- Never invent statistics, records, injuries, quotes, coaches, players, or history.
- EVERY NUMBER you write must appear in that game's JSON or the standings block. Do not compute, infer, or invent figures. If you are unsure of a number, do not use one.
- Respect venueNote exactly. Never claim home-field advantage at a neutral site.
- Do not talk about "the race", "the leaderboard", "swings", or who is gaining on whom. You were not given standings and any such claim will be thrown away. Write about THIS GAME and the two draft picks in it.
- You do NOT know the standings. Never say anyone leads, trails, is ahead, is behind, is winning, or is collecting the pot. The standings table is rendered below you; it is not your subject.
- Never predict a final score, declare a winner, or call anything decided or near-certain. BANNED: "almost a certainty", "no room for surprise", "sits safely", "collects the pot", "before the season even starts". A spread is a market opinion, not a result. BANNED outright: "lock", "inevitable", "safe bet", "cash cow", "free lunch", "sure thing", "cannot lose", "will win", "should win", "hands X the win".
- Refer to owners by the exact names above.
- A team's nickname and its name are the SAME team — Notre Dame is the Fighting Irish, Ole Miss is the Rebels. Never use both in one sentence, and never write a team as though it were playing itself ("Notre Dame fails to dominate the Irish" is nonsense). Picking one name per sentence is safest.
- EXACTLY 2 or 3 sentences per game. Never one. 55 words max.
- Do not use the construction "X, while Y" in more than one blurb.
- Every blurb must open differently from the others.

Return ONLY a JSON object mapping each game id to its blurb string: {"401756789": "..."}.`;

const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content:
        `AP poll in effect: ${poll.label}. Week ${week ?? '?'} games, highest pool impact first.\n\n` +

        `Each game is assigned a REQUIRED opening angle. Obey it — it exists so the blurbs don't all read the same:\n` +
        games.map((g, i) => `  ${g.facts.id} (${g.facts.matchup}) -> ${ANGLES[i % ANGLES.length]}`).join('\n') +
        `\n\n${JSON.stringify(games.map(g => g.facts), null, 1)}` },
];

// gpt-oss models spend a large share of max_tokens on internal reasoning, so
// the budget has to cover reasoning + the JSON payload or the object arrives
// truncated and Groq rejects it with json_validate_failed.
const MAX_TOKENS = 6000;

async function callGroq(jsonMode) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${GROQ_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.85,
      max_tokens: MAX_TOKENS,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const choice = d.choices?.[0] || {};
  const msg = choice.message || {};
  const content = msg.content || '';
  if (!content.trim()) {
    // Reasoning models can burn the whole budget before emitting content, or
    // put the text somewhere other than message.content. Say which.
    console.error(`empty content — finish_reason=${choice.finish_reason}` +
      ` usage=${JSON.stringify(d.usage || {})}` +
      ` fields=${Object.keys(msg).join(',')}` +
      (msg.reasoning ? ` reasoning[0:200]=${String(msg.reasoning).slice(0, 200)}` : ''));
  }
  // Some models return the payload in `reasoning` when content comes back blank.
  return content.trim() ? content : (msg.reasoning || '');
}

// Pull the first balanced {...} out of a free-text reply.
function extractJson(text) {
  const i = text.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

if (DRY_RUN) {
  console.log('--- SYSTEM PROMPT ---\n' + SYSTEM);
  console.log('\n--- FACTS (' + games.length + ' games) ---');
  console.log(JSON.stringify(games.map(g => g.facts), null, 1));
  console.log('\nDRY RUN — no Groq call made, commentary.json untouched.');
  process.exit(0);
}

/* ---------- verification ----------
   The prompt asks the model not to invent things; this checks that it didn't.
   A blurb that fails is dropped and the page falls back to its own text. */
const NUMWORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10 };

function numbersIn(text) {
  const found = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (!Number.isNaN(n)) found.push(n);
  }
  for (const m of text.toLowerCase().matchAll(/[a-z]+/g)) {
    if (NUMWORDS[m[0]] !== undefined) found.push(NUMWORDS[m[0]]);
  }
  return found;
}

const POOL_CONSTANTS = [ROSTER.length, 6, 200, 1600, 40, 60, 400, 160, 80, 600, 240, 120];

function allowedNumbers(facts) {
  const set = new Set(POOL_CONSTANTS);
  const walk = v => {
    if (typeof v === 'number') set.add(v);
    else if (typeof v === 'string') numbersIn(v).forEach(n => set.add(n));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  STANDINGS.forEach(r => { set.add(r.points); set.add(r.place); });
  return [...set];
}

// Banned in the prompt, so also banned in code — the model ignores the prompt
// roughly one blurb in six.
const BANNED = ['swing the pool', 'rewrite the leaderboard', 'leaderboard', 'pool balance',
  'biggest swing', 'flip the standings', 'the race',
  'lock', 'inevitable', 'safe bet', 'cash cow', 'free lunch', 'sure thing',
  'no-brainer', 'no brainer', 'almost a certainty', 'no room for surprise', 'sits safely',
  'collects the pot', 'buckle up', 'must-win', 'all eyes on', 'for the ages',
  'will win', 'should win', 'cannot lose', "can't lose"];

/* Favourite/underdog inversion: "Notre Dame collapses under a 20.5-point hole"
   when Notre Dame is LAYING 20.5. The number is real, so the numeric check
   passes — only the direction is wrong. */
const DOG_LANG = /\b(hole|deficit|underdog|upset|long ?shot|climb|comeback|trailing|trails)\b/i;
const FAV_LANG = /\b(favou?red|favou?rite|laying|giving)\b/i;

function favouriteSide(facts) {
  const m = /^\s*([A-Za-z&.'\- ]+?)\s*-\s*[\d.]+\s*$/.exec(facts.line || '');
  if (!m) return null;
  const ab = m[1].trim().toUpperCase();
  if ((facts.home.abbr || '').toUpperCase() === ab) return { fav: facts.home, dog: facts.away };
  if ((facts.away.abbr || '').toUpperCase() === ab) return { fav: facts.away, dog: facts.home };
  return null;
}

function mentions(sentence, side) {
  const names = [side.name, side.abbr].filter(Boolean)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return names.some(n => new RegExp(`\\b${n}\\b`, 'i').test(sentence));
}

function directionProblem(blurb, facts) {
  const sides = favouriteSide(facts);
  if (!sides) return null;
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    const hasFav = mentions(sentence, sides.fav), hasDog = mentions(sentence, sides.dog);
    // Only judge sentences about one team; a sentence naming both is ambiguous.
    if (hasFav && !hasDog && DOG_LANG.test(sentence))
      return `describes the favourite (${sides.fav.name}) in underdog terms`;
    if (hasDog && !hasFav && FAV_LANG.test(sentence))
      return `describes the underdog (${sides.dog.name}) as the favourite`;
  }
  return null;
}

/* Spread/points conflation. Pool points come from AP poll position and move
   only when the poll updates — never because a margin was covered. So a
   sentence that makes a points quantity depend on covering, the spread, or
   the margin of victory is describing a mechanic that does not exist.
   Losing outright legitimately risks a poll slide, so outcome words
   (stumbles, loses, upset) are deliberately NOT margin language. */
const MARGIN_LANG  = /\b(cover(s|ed|ing)?|spread|blowout|margin|point line|by more than)\b/i;
const POINTS_NOUN  = /\b(stake|draft|haul|points?|pts|payday|value)\b/i;
const CAUSAL_VERB  = /\b(wipes?|wiped|erases?|gains?|collects?|earns?|banks?|boosts?|vanish(es|ed)?|evaporates?|bleeds?|hangs? on|rides? on|depends? on|hinges? on|protects?|shields?|secures?|saves?)\b/i;

function conflationProblem(blurb) {
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    if (MARGIN_LANG.test(sentence) && POINTS_NOUN.test(sentence) && CAUSAL_VERB.test(sentence))
      return 'ties pool points to covering the spread (points come from poll position, not margin)';
  }
  return null;
}

const PLACEHOLDER = /^(\.{2,}|…+|todo|tbd|n\/?a|lorem\b.*|<.*>|\{.*\}|blurb|string)$/i;

/* Mangled idioms the model has actually produced. A regex cannot catch garbled
   English in general — the audit pass judges fluency — but anything seen once
   is cheap to block forever. */
const GARBLED = [
  /\brolls? the night\b/i,
  /\brolls? the dice on the night\b/i,
];

/* The model reliably mangles this one idiom ("rolls the night with house
   money", "rolls the house money"). The valid forms all put a preposition or
   a play-verb immediately before it, so check that rather than chase variants. */
function houseMoneyProblem(text) {
  if (!/house money/i.test(text)) return null;
  return /\b(with|on|playing|plays|play|played)\s+house money\b/i.test(text)
    ? null
    : 'mangled "house money" idiom (use "playing with house money" / "on house money")';
}

/* qwen echoed the "..." from the prompt's format example and every other
   check passed it — an ellipsis has no numbers to verify and no claims to
   contradict. Substance has to be checked explicitly. */
function substanceProblem(blurb) {
  const t = blurb.trim();
  if (PLACEHOLDER.test(t)) return 'placeholder text, not a blurb';
  const g = GARBLED.find(re => re.test(t));
  if (g) return `garbled idiom: ${g.source}`;
  const hm = houseMoneyProblem(t);
  if (hm) return hm;
  const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  if (words.length < 8) return `too short (${words.length} words)`;
  if (t.replace(/[^A-Za-z]/g, '').length < 30) return 'almost no prose';
  if (!/[.!?]/.test(t)) return 'no sentence punctuation';
  return null;
}

/* "Notre Dame fails to dominate the Irish" — Notre Dame IS the Irish. Allowing
   two names per team invites treating one team as two, and the card only ever
   shows the location name anyway. So nicknames are simply not allowed. */
function nicknameProblem(blurb, facts) {
  const esc_ = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    for (const side of [facts.away, facts.home]) {
      const nick = (side.nickname || '').trim();
      if (!nick || !side.name) continue;
      const forms = [nick, nick.split(/\s+/).pop()].filter(w => w && w.length > 3);
      const usesNick = forms.some(f => new RegExp(`\\b${esc_(f)}\\b`, 'i').test(sentence));
      const usesName = new RegExp(`\\b${esc_(side.name)}\\b`, 'i').test(sentence);
      // Either name alone is fine. Both in one sentence is how "Notre Dame
      // fails to dominate the Irish" happens — one team written as two.
      if (usesNick && usesName)
        return `refers to ${side.name} by both name and nickname in one sentence`;
    }
  }
  return null;
}

function validate(blurb, facts) {
  const sub = substanceProblem(blurb);
  if (sub) return sub;
  const nick = nicknameProblem(blurb, facts);
  if (nick) return nick;
  const dir = directionProblem(blurb, facts);
  if (dir) return dir;
  const conf = conflationProblem(blurb);
  if (conf) return conf;
  const low = blurb.toLowerCase();
  const hit = BANNED.find(b => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low));
  if (hit) return `banned phrase: "${hit}"`;
  if (facts.neutralSite &&
      /\bhome[- ]?(field|team|crowd)\b|\bat home\b|\bhosts?\b|\bhome advantage\b|\broad (test|trip|game)\b|\btravels?\b|\bvisits?\b|\baway game\b/i.test(blurb))
    return 'treats a neutral-site game as home/away';
  const allowed = allowedNumbers(facts);
  for (const n of numbersIn(blurb)) {
    // 0.5 tolerance so rounding a 9.5 line to "nine" is fine.
    if (!allowed.some(a => Math.abs(a - n) <= 0.5)) return `unsupported number: ${n}`;
  }
  return null;
}

async function verify(blurbs, byId) {
  const items = Object.entries(blurbs).map(([id, text]) => ({
    id, blurb: text, facts: byId.get(id),
    standings: STANDINGS.map(r => `${r.place}. ${r.name} ${r.points}`).join(', '),
  }));

  const sys = `You are a fact-checker. For each item you get a blurb and the ONLY facts that exist about that game, plus the current pool standings.

Mark ok=false if the blurb states anything the facts do not support. Specifically catch:
- treating a win as earning points or a loss as deducting them. Points come from AP poll position only; a win defends a ranking, a loss risks a slide in next week's poll. "Gains 15 points by covering" is wrong.
- tying pool points to the spread or to covering. Points come from AP poll position and change only when the poll updates. "A 20-point draft hangs on a 20.5-point spread" and "anything less than a blowout wipes his stake" are both wrong. Losing the GAME risking a poll slide is fine; covering is irrelevant to points.
- favourite/underdog inversion: in "ND -20.5" Notre Dame is favoured. Describing the favourite as facing a hole, deficit, or upset climb is wrong.
- inverting exposure: the owner of the HIGHER-ranked, higher-point team has more to lose; the owner of a 0-point team is the one risking nothing
- ANY claim about the pool standings or the overall race (who leads, trails, is ahead, is winning, is collecting the pot) — the writer was not given standings, so any such claim is unsupported
- treating an outcome as settled or near-certain ("almost a certainty", "no room for surprise", "sits safely")
- inverting who has points at risk (the owner with more points has MORE to lose; an owner whose team is worth 0 is the one playing with house money)
- claiming home-field advantage when neutralSite is true
- any number, record, statistic, injury, or history not present in the facts
- predicting a winner or a final score as settled fact

Also mark ok=false if the writing is broken English: a garbled or mangled idiom ("rolls the night" instead of "rolls the dice"), a phrase that does not parse, a word that clearly is not the one meant, or a sentence a fluent speaker would not write.

Do NOT mark ok=false for opinion, sarcasm, insults, bluntness or informal tone — rudeness is intended and is not an error. Judge only factual support and whether the English is coherent.

Return ONLY JSON: {"<id>": {"ok": true|false, "reason": "<short>"}, ...}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${GROQ_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0, max_tokens: MAX_TOKENS,
      messages: [{ role: 'system', content: sys },
                 { role: 'user', content: JSON.stringify(items, null, 1) }],
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const txt = (await r.json()).choices?.[0]?.message?.content || '';
  const j = extractJson(txt);
  return j ? JSON.parse(j) : {};
}

let out = {};
try {
  let raw;
  try {
    raw = await callGroq(true);
  } catch (e) {
    // Strict JSON mode can fail outright (json_validate_failed). Retry in plain
    // mode and dig the object out ourselves rather than losing the whole run.
    console.error('json mode failed, retrying without it:', e.message);
    raw = await callGroq(false);
  }
  const jsonText = extractJson(raw);
  if (!jsonText) throw new Error('no JSON object in model reply');
  const parsed = JSON.parse(jsonText);
  const byId = new Map(games.map(g => [g.facts.id, g.facts]));
  let rejected = 0;
  for (const [k, v] of Object.entries(parsed)) {
    const facts = byId.get(String(k));
    if (!facts) {
      // e.g. the model echoed the example id from the prompt instead of a real one
      console.error(`ignored unknown game id "${k}" — not in this week's slate`);
      continue;
    }
    if (typeof v !== 'string' || !v.trim()) {
      console.error(`ignored ${k}: empty or non-string value`);
      continue;
    }
    const blurb = v.trim().slice(0, 400);
    const problem = validate(blurb, facts);
    if (problem) { console.error(`rejected ${k}: ${problem}\n   ${blurb}`); rejected++; continue; }
    out[String(k)] = blurb;
  }
  // Second pass: a fresh, cold-temperature call whose only job is to find
  // claims the facts do not support. Catches semantic errors (inverted
  // asymmetry, invented standings) that the numeric check cannot see.
  if (Object.keys(out).length) {
    try {
      const audit = await verify(out, byId);
      for (const [id, verdict] of Object.entries(audit)) {
        if (verdict && verdict.ok === false) {
          console.error(`audit rejected ${id}: ${verdict.reason}\n   ${out[id]}`);
          delete out[id];
          rejected++;
        }
      }
    } catch (e) {
      console.error('audit pass failed, keeping validated blurbs:', e.message);
    }
  }

  if (rejected) console.error(`${rejected} blurb(s) rejected; page falls back to built-in text for those`);
  if (!Object.keys(out).length) console.error('every blurb was rejected — publishing an empty set so stale ones are removed');
} catch (err) {
  // The call itself failed (network/auth/parse). Keep the last good file.
  console.error('generation failed:', err.message);
  process.exit(1);
}
// Note: reaching here means we DID get a response. Even if every blurb was
// rejected we still write, so a previously-published bad blurb is removed
// rather than lingering because this run happened to produce nothing.

if (process.env.NO_WRITE === '1') {
  console.log('NO_WRITE — result not published:');
  for (const [id, text] of Object.entries(out)) console.log(`  ${id}: ${text}`);
  console.log(`(${Object.keys(out).length} of ${games.length} survived validation)`);
  process.exit(0);
}

await writeFile(new URL('../commentary.json', import.meta.url), JSON.stringify({
  generated: new Date().toISOString(),
  model: GROQ_MODEL,
  season, week, poll: poll.label,
  games: out,
}, null, 2) + '\n');

console.log(`wrote commentary.json — week ${week}, ${Object.keys(out).length} blurbs, model ${GROQ_MODEL}`);
