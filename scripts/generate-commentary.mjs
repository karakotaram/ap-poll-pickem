#!/usr/bin/env node
/**
 * Generates columnist-style blurbs for the week's highest-impact games and
 * writes them to commentary.json.
 *
 * Runs in CI only — the Anthropic key never reaches the browser. The site
 * treats commentary.json as optional: if this script fails or never runs, the
 * page falls back to its built-in rule-based text.
 *
 * The roster is read out of index.html so there is exactly one source of truth.
 */
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const N_GAMES = 6;   // page shows 3; extra cover it picking a slightly different set

const DRY_RUN = process.env.DRY_RUN === '1';   // build the payload, skip the API call

if (!DRY_RUN) {
  // Distinguish "missing" from "present but empty" — `gh secret set` with no
  // stdin silently stores an empty string, which is otherwise invisible in CI
  // logs because there is nothing for GitHub to mask.
  if (API_KEY === undefined) {
    console.error('ANTHROPIC_API_KEY is not set at all. Add it as a repository secret.');
    process.exit(1);
  }
  if (!API_KEY.trim()) {
    console.error('ANTHROPIC_API_KEY is set but EMPTY — the secret was stored with no value.');
    console.error('Re-add it via Settings > Secrets and variables > Actions,');
    console.error('or from an interactive terminal: gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>');
    process.exit(1);
  }
}

// Zero-arg constructor reads ANTHROPIC_API_KEY (or an `ant auth login` profile).
const client = new Anthropic();

const RANK_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons';
const SB_API   = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

const TIERS = [[1,1,25],[2,6,20],[7,10,15],[11,15,10],[16,20,5],[21,24,3],[25,25,2]];
const pointsForRank = r => (TIERS.find(t => r >= t[0] && r <= t[1]) || [,,0])[2];

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
// Rolls every 5 minutes — dodges ESPN's CDN stale-while-revalidate window,
// which can serve poll-drop-Sunday runs a rankings copy from before the
// poll landed. Same trick as index.html and poll-gate.mjs.
const bust = Math.floor(Date.now() / 3e5);
const polls = (await Promise.all(slots.map(async ([t,w]) => {
  try {
    const d = await jget(`${RANK_API}/${season}/types/${t}/weeks/${w}/rankings/1?b=${bust}`);
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

/* How each team moved in this week's poll, pre-phrased so the model copies a
   direction rather than working one out. "Moved up" rather than "climbed",
   because "climb" is on directionProblem()'s underdog list below. */
const prevPoll = polls.length > 1 ? polls[polls.length - 2] : null;
const PREV_RANK = new Map((prevPoll?.ranks || []).map(r => [r.id, r.rank]));
const pollMove = (id, rank) => {
  if (!prevPoll) return null;
  const was = PREV_RANK.get(id) ?? null;
  if (was == null && rank == null) return null;
  if (was == null) return `entered the poll this week at No.${rank}`;
  if (rank == null) return `dropped out of the poll this week; it was No.${was}`;
  if (was === rank) return null;
  return `moved ${rank < was ? 'up' : 'down'} from No.${was} to No.${rank} in this week's poll`;
};
poll.others.slice(0, 3).forEach((o, i) => { if (!SM.has(o.id)) SM.set(o.id, { pts: 2, rank: null, rv: i+1 }); });

/* ---------- this week's games, ranked by pool impact ----------
   Mirrors analyze() in index.html — keep the two in sync.

   ESPN's "current" scoreboard week rolls over Monday around 3am ET, so on a
   poll-drop Sunday it still points at the week just played — every game
   final, nothing worth a preview. When the current week has no game left to
   play, advance one week (regular week 17 rolls into the postseason). One
   step only: if that week is empty too, the season is over and the current
   answer stands. Mirrored in weekly-email.mjs and index.html — keep in sync. */
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

const games = (sb.events || []).map(e => {
  const c = e.competitions?.[0]; if (!c || c.competitors?.length !== 2) return null;
  const side = ha => {
    const t = c.competitors.find(x => x.homeAway === ha) || c.competitors[0];
    const id = t.team?.id, sc = SM.get(id) || {};
    return { id, name: t.team?.location || '', abbr: t.team?.abbreviation || '',
             nickname: t.team?.name || '',
             record: t.records?.[0]?.summary || '', rank: sc.rank ?? null, rv: sc.rv ?? null,
             points: sc.pts || 0, owner: OWNER[id] || null,
             pollMove: pollMove(id, sc.rank ?? null) };
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

/* ---------- how the teams match up ----------
   Where each side ranks nationally in points scored and allowed per game.
   The model gets these as ready-made phrases ("Texas's 9th-ranked scoring
   offense") and must copy them verbatim: a rank pinned on the wrong team, or
   on offense instead of defense, would pass every number check because the
   number itself is real, and a fixed phrase is something statProblem() can
   check. The same ranks also make a plain team line (teamLine below) that the
   page shows only when the model's blurb for a game was rejected.

   One request covers the whole FBS. ESPN files points per game under the
   "passing" category (it repeats team totals in each one); the "Own" split is
   the team's offense and "Opponent" is what it allowed. Ranks are computed
   here, with ties sharing a rank, rather than read from ESPN's own rank
   strings, whose direction for the Opponent split isn't documented. */
const STATS_API = 'https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam';
const MIN_GAMES = 2;   // a national rank off one game is noise

async function scoringRanks() {
  const d = await jget(`${STATS_API}?region=us&lang=en&contentorigin=espn&limit=200&group=80&season=${season}&seasontype=2`);
  const names = Object.fromEntries((d.categories || []).map(c => [c.name, c.names || []]));
  const val = (t, split, cat, stat) => {
    const c = (t.categories || []).find(x => x.name === cat && (x.displayName || '').startsWith(split));
    const i = (names[cat] || []).indexOf(stat);
    return c && i >= 0 ? c.values?.[i] : null;
  };
  const rows = (d.teams || []).map(t => ({
    id: String(t.team?.id || ''),
    gp: val(t, 'Own', 'general', 'gamesPlayed'),
    off: val(t, 'Own', 'passing', 'totalPointsPerGame'),
    def: val(t, 'Opponent', 'passing', 'totalPointsPerGame'),
  })).filter(r => r.id && typeof r.off === 'number' && typeof r.def === 'number');
  const rankOf = (r, better) => 1 + rows.filter(o => better(o, r)).length;
  return new Map(rows.map(r => [r.id, {
    gp: r.gp || 0,
    off: rankOf(r, (o, x) => o.off > x.off),   // more points scored is better
    def: rankOf(r, (o, x) => o.def < x.def),   // fewer points allowed is better
  }]));
}

const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const rankedAs = n => (n === 1 ? 'top-ranked' : `${ordinal(n)}-ranked`);

function teamLine(f, R) {
  const usable = s => { const r = R.get(String(s.id)); return r && r.gp >= MIN_GAMES ? r : null; };
  const a = usable(f.away), h = usable(f.home);
  if (a && h) {
    // Lead with the more lopsided pairing; the other direction follows.
    const [[o1, so1, d1, sd1], [o2, so2, d2, sd2]] = [[f.away, a, f.home, h], [f.home, h, f.away, a]]
      .sort((x, y) => Math.abs(y[1].off - y[3].def) - Math.abs(x[1].off - x[3].def));
    return `${o1.name}'s ${rankedAs(so1.off)} scoring offense takes on ${d1.name}'s ${rankedAs(sd1.def)} scoring defense. ` +
           `The other way, ${o2.name}'s offense ranks ${ordinal(so2.off)} and ${d2.name}'s defense ${ordinal(sd2.def)}.`;
  }
  // One side has no FBS numbers: an FCS opponent, or too few games played.
  const [s, r] = a ? [f.away, a] : h ? [f.home, h] : [null, null];
  return s ? `${s.name} ranks ${ordinal(r.off)} in the FBS in scoring offense and ${ordinal(r.def)} in scoring defense.` : null;
}

let RANKS = new Map();
try {
  RANKS = await scoringRanks();
} catch (e) {
  console.error('team stats unavailable, previews go out without them:', e.message);
}
const TEAM_LINES = {};
games.forEach(({ facts: f }) => {
  for (const s of [f.away, f.home]) {
    const r = RANKS.get(String(s.id));
    // A few wordings of the same two ranks: one fixed form made every
    // matchup sentence in the set read identically.
    s.statPhrases = r && r.gp >= MIN_GAMES ? [
      `${s.name}'s ${rankedAs(r.off)} scoring offense`,
      `a ${s.name} offense that ranks ${ordinal(r.off)} in scoring`,
      `${s.name}'s offense, ${ordinal(r.off)} in scoring`,
      `${s.name}'s ${rankedAs(r.def)} scoring defense`,
      `a ${s.name} defense that ranks ${ordinal(r.def)} in points allowed`,
      `${s.name}'s defense, ${ordinal(r.def)} in points allowed`,
    ] : [];
  }
  const t = teamLine(f, RANKS);
  if (t) TEAM_LINES[f.id] = t;
});

// Spell the venue situation out; a raw boolean gets skimmed past.
games.forEach(({ facts: f }) => {
  f.venueNote = f.neutralSite
    ? `NEUTRAL SITE at ${f.venue} — neither team is at home. Do not claim home-field advantage.`
    : `${f.home.name} is at home at ${f.venue}.`;
});

/* ---------- ask Claude ---------- */
const SYSTEM = `You write the preview that sits under each matchup card for an eight-person college football pick'em pool. The same people get a weekly email with an entry per player, and the previews should read the same way: plain, specific, built from facts, with a light touch. An entry looks like this (the register, not the content):

  "Gained 5 points this week: Oregon moved up from No. 15 to No. 9 (+5). Has been 2nd since Week 4. Will see if Oregon can hold on to its jump when it visits Ty's No. 12 Ole Miss as a 2.5-point underdog."

THE POOL: ${ROSTER.map(p => p.name).join(', ')}. Each drafted six teams before the season and scores off the AP Top 25 weekly: 25 pts for No.1, 20 for Nos.2-6, 15 for 7-10, 10 for 11-15, 5 for 16-20, 3 for 21-24, 2 for No.25, 2 for a top-3 also-receiving-votes team. $200 each, $1,600 pot, paid on the final poll before the playoffs (40%) and after (60%).

THE SPREAD HAS NOTHING TO DO WITH POINTS. Pool points come from AP poll position. Covering a spread earns nobody anything; failing to cover costs nobody anything. The line is only evidence about how good a team is. Never write that a margin, a cover, or a blowout wins or loses pool points.

WHAT THE LINE MEANS — a line like "ND -20.5" means Notre Dame is FAVORED and must win by more than 20.5. The favorite is never "facing a hole", "in a deficit", "an underdog", or "climbing back"; that is the other team's position. A favorite can only "fail to cover", "blow a cushion", or "win without covering". Get this backwards and the blurb is thrown away.

HOW SCORING ACTUALLY WORKS — you have been getting this wrong. Points come from where a team sits in the AP poll, NOT from winning a game. Winning a game adds nothing; it defends a team's existing ranking. Losing subtracts nothing directly; it risks the team sliding in next week's poll, and the slide is where points are lost. So never write that someone "gains 15 points" by covering, or "collects" points by winning. The correct framing is exposure: the owner of a highly ranked team has points to LOSE, and the owner of an unranked team has nothing to lose and something to gain only if their team climbs into the poll.

WHAT A PREVIEW IS — two or three sentences, 60 words at most. Find the one or two things that make THIS game worth watching for the pool and say those. The facts are a menu, not a checklist:
- who has points riding on the game, or one owner holding both sides
- a team that just moved in the poll (pollMove) and now has a spot to defend
- how the teams match up: a big gap between one team's offense and the other's defense, the best unit on the field, two strong units meeting
- whether the line agrees with the stat ranks or with the poll
- an unbeaten record, a neutral site, a road favorite
Use what is interesting about this game and leave the rest out.

THE SIX ARE READ TOGETHER, ONE AFTER ANOTHER. Write them as a set and make them sound different from each other:
- No two previews may follow the same order of ideas. Lead one with the matchup, another with the poll move, another with an owner, another with the line.
- Usually one stat pairing, the telling one, is enough. Write the both-directions construction ("A's offense meets B's defense, and B's offense faces A's defense") in at most one preview.
- Mention the line in at most half of the previews.
- Never reuse a phrase from another preview in the set — not "has nothing to lose", "a new spot to defend", "which fits the ranks", "depend on keeping it there", or any other.

STAT RANKS — COPY A PHRASE EXACTLY. Each team with stats has statPhrases: its scoring-offense and scoring-defense ranks, each written three ways, e.g. "Texas's 55th-ranked scoring offense", "a Texas offense that ranks 55th in scoring", "Texas's offense, 55th in scoring". Whenever you cite where a team ranks on offense or defense, copy one of its phrases word for word (a capital letter at the start of a sentence is fine) and build the sentence around it. Never write a stat rank any other way ("Texas's offense ranks 55th", "the 55th-best offense"), never move a number from one phrase to another, and never give a rank for a team whose statPhrases list is empty. These are national ranks in points scored and allowed per game among FBS teams. You may say one unit ranks well above or below another; do not invent anything else about how a team plays.

DON'T RECITE THE CARD. The card above your text already shows both teams' ranks, both owners, both point values, the total at stake, the line, the TV network and the venue. Bring those up only to say what they mean: who has something to lose, who has nothing to lose, whether the line agrees with the stat ranks. "Murph's Louisville is No.24, worth 3 points" tells the reader nothing new. Never name the TV network or the stadium.

VOICE: plain declarative sentences, specific and a little dry. Say what is at stake and how the teams compare, and let it land on its own. No verdicts on anyone's drafting.

AMERICAN ENGLISH. Write "favored", not "favoured"; "defense", not "defence". This is an American college football pool.

WRITE PLAINLY — THIS IS THE MOST IMPORTANT INSTRUCTION. Use no idioms, no set phrases, no slang, no wordplay, no metaphors, no team nicknames. Specifically avoid: "house money", "rolls the dice", "hanging by a thread", "coin flip", "moat", "juggernaut", "cushion", "on the line", "grab", "haul", "payday". If a colorful phrase occurs to you, write the plain version of it instead. A flat accurate sentence is always better than a vivid one you get slightly wrong.

NO TIER TALK. Do not mention scoring tiers or bands, or what the next spot up or down in the poll would pay. Say who has points riding on the game, and leave the scoring table out of it.

BANNED: hype cliches ("all eyes on", "must-win", "buckle up", "for the ages"), exclamation marks, emoji, rhetorical questions, and opening two blurbs the same way.

STYLE SAMPLES — three different shapes. Match the register, never reuse the content or copy a shape for every game:
- "Kansas State's 9th-ranked scoring defense gets a Baylor offense that ranks 80th in scoring, the widest gap on the field. Karan has 5 points on Kansas State, which just moved up from No.21 to No.16."
- "Mike drafted both teams, so the only question for him is which one is ranked next week. Clemson is the one carrying points, 10 of them."
- "The market makes Utah a 6-point favorite on the road, and the numbers back it: a Utah defense that ranks 7th in points allowed against Arizona's 98th-ranked scoring offense. Chris has 10 points on Utah and Jim has none on Arizona."

HARD RULES:
- Use ONLY the facts in the JSON provided. You have no other knowledge of these teams.
- Never invent statistics, records, injuries, quotes, coaches, players, or history.
- EVERY NUMBER you write must appear in that game's JSON or the standings block. Do not compute, infer, or invent figures. If you are unsure of a number, do not use one.
- Respect venueNote exactly. Never claim home-field advantage at a neutral site.
- Do not talk about "the race", "the leaderboard", "swings", or who is gaining on whom. You were not given standings and any such claim will be thrown away. Write about THIS GAME and the two draft picks in it.
- You do NOT know the standings. Never say anyone leads, trails, is ahead, is behind, is winning, or is collecting the pot. The standings table is rendered below you; it is not your subject.
- Never predict a final score, declare a winner, or call anything decided or near-certain. BANNED: "almost a certainty", "no room for surprise", "sits safely", "collects the pot", "before the season even starts". BANNED outright: "lock", "inevitable", "safe bet", "cash cow", "free lunch", "sure thing", "cannot lose", "will win", "should win", "hands X the win".
- Refer to owners by the exact names above.
- A team's nickname and its name are the SAME team — Notre Dame is the Fighting Irish, Ole Miss is the Rebels. Never use both in one sentence, and never write a team as though it were playing itself ("Notre Dame fails to dominate the Irish" is nonsense). Picking one name per sentence is safest.
- 2 or 3 sentences per game. Never one. 60 words max.
- Do not use the construction "X, while Y" in more than one blurb.
- Every blurb must open differently from the others.

THESE SIX MISTAKES GOT BLURBS THROWN AWAY IN RECENT RUNS. Do not repeat them:
- "Texas favored by eight and a half is the market's opinion, not a result" — never explain what a betting line is or is not. Everyone reading knows a spread is not a final score; "only a prediction", "guarantees nothing", "nothing is decided until they play" are the same empty sentence. Every sentence must say something specific about this game and these owners.
- "nothing he watches this weekend can cost him anything" — you are given ONE game. Never describe what an owner risks or gains in any other game, or across a weekend. Confine every claim to this matchup.
- "nobody in the pool has any reason to want the upset" — you cannot know what other owners want. Never write about anyone who does not own a team in THIS game.
- "neither owner gains anything here" — false whenever a ranked team can climb. Only a team already at No.1 has no upside; everyone else can move up.
- Attaching "exposed", "at risk", "most to lose", "toughest" or "vulnerable" to an owner whose team in this game is worth 0. That owner risks nothing here. Name the owner who actually holds the points instead, and do not use risk words about the other one even to deny them.
- Using a team's name and its nickname in the same sentence. Pick one and stay with it.`;

const USER =
  `AP poll in effect: ${poll.label}. Week ${week ?? '?'} games, highest pool impact first. ` +
  `Write one preview per game. Plan the six as a set first, so no two share an opening, an order of ideas, or a phrase.\n\n` +
  JSON.stringify(games.map(g => g.facts), null, 1);

/* Structured outputs, so the reply is a typed object rather than prose we have
   to scrape a JSON object out of. Keyed as an array because the ids are the
   week's game ids and a JSON schema cannot express dynamic keys. */
const BlurbSet = z.object({
  games: z.array(z.object({
    id: z.string().describe('the game id exactly as given in the facts'),
    blurb: z.string().describe('two or three sentences about that game'),
  })).describe('one entry per game supplied, in the same order'),
});

const AuditSet = z.object({
  verdicts: z.array(z.object({
    id: z.string(),
    ok: z.boolean().describe('false if the blurb states anything the facts do not support'),
    reason: z.string().describe('short explanation when ok is false, otherwise empty'),
  })),
});

/* Thinking is always on for Opus 5.5 and temperature is not a knob on this
   model family. Effort defaults to medium on 5.5, one level below Opus 5, so
   it is pinned to high to keep what the column was tuned against.

   Server-side fallback ("default" routes by refusal category): if the model
   declines, the API reruns the same request on a fallback model inside the
   same call, rather than the run failing. A refusal on a football column is
   unlikely, but it would otherwise cost the whole week's previews. */
async function callClaude(system, user, format) {
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'high', format: betaZodOutputFormat(format) },
  });
  if (res.stop_reason === 'refusal')
    throw new Error(`model declined: ${res.stop_details?.category ?? 'unknown'}`);
  if (!res.parsed_output)
    throw new Error(`structured output did not parse (stop_reason=${res.stop_reason})`);
  const fellBack = (res.usage.iterations ?? []).some(x => x.type === 'fallback_message');
  console.error(`  ${res.model}${fellBack ? ` (fallback from ${MODEL})` : ''}: ` +
                `in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
  return res.parsed_output;
}

if (DRY_RUN) {
  console.log('--- MODEL ---\n' + MODEL);
  console.log('\n--- SYSTEM PROMPT ---\n' + SYSTEM);
  console.log('\n--- FACTS (' + games.length + ' games) ---');
  console.log(JSON.stringify(games.map(g => g.facts), null, 1));
  console.log('\n--- TEAM LINES ---');
  games.forEach(({ facts: f }) => console.log(`  ${f.id} ${f.matchup}\n    ${TEAM_LINES[f.id] || '(none)'}`));
  console.log('\nDRY RUN — no API call made, commentary.json untouched.');
  process.exit(0);
}

/* American spelling. The prompt asks for it, but asking is not a guarantee —
   the previous prompt was itself written in British English, which is where
   "favoured" came from in the first place. Unlike every other check here this
   one CORRECTS rather than rejects: respelling a word cannot change what the
   sentence claims, and throwing away an accurate blurb over one letter is a
   bad trade. Every substitution is logged. */
const BRITISH = [
  ['favour', 'favor'], ['colour', 'color'], ['honour', 'honor'],
  ['behaviour', 'behavior'], ['neighbour', 'neighbor'], ['rumour', 'rumor'],
  ['labour', 'labor'], ['defence', 'defense'], ['offence', 'offense'],
  ['pretence', 'pretense'], ['licence', 'license'], ['practise', 'practice'],
  ['analyse', 'analyze'], ['realise', 'realize'], ['recognise', 'recognize'],
  ['apologise', 'apologize'], ['organise', 'organize'], ['emphasise', 'emphasize'],
  ['metre', 'meter'], ['litre', 'liter'], ['centre', 'center'], ['theatre', 'theater'],
  ['programme', 'program'], ['grey', 'gray'], ['sceptic', 'skeptic'],
  ['manoeuvre', 'maneuver'], ['travelled', 'traveled'], ['travelling', 'traveling'],
  ['cancelled', 'canceled'], ['modelled', 'modeled'], ['marvellous', 'marvelous'],
  ['whilst', 'while'], ['amongst', 'among'], ['learnt', 'learned'], ['spelt', 'spelled'],
];

function americanize(text) {
  let out = text;
  const hits = [];
  for (const [uk, us] of BRITISH) {
    const next = out.replace(new RegExp(uk, 'gi'),
      m => (m[0] === m[0].toUpperCase() ? us[0].toUpperCase() + us.slice(1) : us));
    if (next !== out) hits.push(uk);
    out = next;
  }
  return { text: out, hits };
}

/* ---------- verification ----------
   The prompt asks the model not to invent things; this checks that it didn't.
   A blurb that fails is dropped and the page falls back to its own text. */
const NUMWORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
  first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10,
  eleventh:11, twelfth:12, thirteenth:13, fourteenth:14, fifteenth:15, sixteenth:16, seventeenth:17,
  eighteenth:18, nineteenth:19, twentieth:20, thirtieth:30, fortieth:40, fiftieth:50, sixtieth:60,
  seventieth:70, eightieth:80, ninetieth:90 };

const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const ONES = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9 };
const COMPOUND = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g;

function numbersIn(text) {
  // "twenty-five" is 25, not 20 and 5. Without collapsing compounds first, a
  // blurb correctly saying "twenty-five points" is rejected for the phantom 5 —
  // which is exactly what happened once the model started spelling numbers out.
  const collapsed = String(text).toLowerCase()
    .replace(COMPOUND, (_, t, o) => String(TENS[t] + ONES[o]));
  const found = [];
  for (const m of collapsed.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (!Number.isNaN(n)) found.push(n);
  }
  for (const m of collapsed.matchAll(/[a-z]+/g)) {
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

/* Favorite/underdog inversion: "Notre Dame collapses under a 20.5-point hole"
   when Notre Dame is LAYING 20.5. The number is real, so the numeric check
   passes — only the direction is wrong. */
const DOG_LANG = /\b(hole|deficit|underdog|upset|long ?shot|climb|comeback|trailing|trails)\b/i;
const FAV_LANG = /\b(favou?red|favou?rite|laying|giving)\b/i;

function favoriteSide(facts) {
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
  const sides = favoriteSide(facts);
  if (!sides) return null;
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    const hasFav = mentions(sentence, sides.fav), hasDog = mentions(sentence, sides.dog);
    // Only judge sentences about one team; a sentence naming both is ambiguous.
    if (hasFav && !hasDog && DOG_LANG.test(sentence))
      return `describes the favorite (${sides.fav.name}) in underdog terms`;
    if (hasDog && !hasFav && FAV_LANG.test(sentence))
      return `describes the underdog (${sides.dog.name}) as the favorite`;
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

/* Whether a team covers never affects an owner — only the poll does. So any
   sentence that names an owner and talks about covering is wrong, even with
   no points word in it ("Mike looks vulnerable if Notre Dame fails to cover").
   Deliberately excludes bare "margin" and "spread", which are legitimate as
   evidence ("has little margin", "the spread suggests"). */
const OUTCOME_MARGIN = /\b(covers?|covered|covering|blowout|margin of victory|win(?:ning)? by more than)\b/i;
const OWNER_NAMES = ROSTER.map(p => p.name);

function conflationProblem(blurb) {
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    if (MARGIN_LANG.test(sentence) && POINTS_NOUN.test(sentence) && CAUSAL_VERB.test(sentence))
      return 'ties pool points to covering the spread (points come from poll position, not margin)';
    if (OUTCOME_MARGIN.test(sentence) &&
        OWNER_NAMES.some(n => new RegExp(`\\b${n}\\b`).test(sentence)))
      return 'makes an owner\'s outcome depend on covering (covering affects nobody\'s points)';
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

/* Exposure has to point at the owner who actually has points on the field.
   Both the prompt and the audit are told to catch this, and both passed
   "Mike faces the toughest scenario" for an owner holding zero. A rule that
   can be checked gets checked. */
const RISK_TAIL = /\b(most to lose|stands? to lose|toughest|looks worst|worst position|exposed|exposure|at risk|on the hook|in danger|vulnerable)\b/i;
const RISK_NEG  = /\b(no|not|nothing|none|never|zero|without)\b/i;

function exposureProblem(blurb, facts) {
  const owned = [facts.away, facts.home].filter(s => s.owner);
  const zero  = owned.filter(s => !s.points);
  if (!zero.length || !owned.some(s => s.points)) return null;   // nothing to invert
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    for (const z of zero) {
      const who = [z.owner, z.name, z.abbr].filter(Boolean)
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      // only the span between the name and the risk phrase can negate it, so
      // "Mike has nothing at risk" still passes
      const m = new RegExp(`\\b(?:${who})\\b([^.!?]{0,50}?)${RISK_TAIL.source}`, 'i').exec(sentence);
      if (m && !RISK_NEG.test(m[1]))
        return `puts the exposure on ${z.owner}, whose ${z.name} is worth 0`;
    }
  }
  return null;
}

/* Pool points and the betting margin are different units. "worth 20 points,
   far below the 22.5-point margin" is not a rounding slip, it is a category
   error, and no amount of prompt wording has stopped it. */
const COMPARATIVE = /\b(above|below|under|over|more than|less than|greater|smaller|exceeds?|outweighs?|compared (to|with)|versus)\b/i;

function unitProblem(blurb) {
  for (const sentence of blurb.split(/(?<=[.!?])\s+/)) {
    if (POINTS_NOUN.test(sentence) && MARGIN_LANG.test(sentence) &&
        COMPARATIVE.test(sentence) && numbersIn(sentence).length >= 2)
      return 'compares pool points against the betting margin (different units)';
  }
  return null;
}

/* Telling the reader what a betting line is. "Texas favored by eight and a
   half is the market's opinion, not a result" got published — nobody reading
   a pick'em column needs to be told a spread is not a final score. The prompt
   itself used to carry "a spread is a market opinion, not a result", which is
   where the model got it. */
const TRUISM = [
  /\bnot (?:a|the) (?:result|final score|outcome|guarantee)\b/i,
  /\b(?:only|just|merely|simply) (?:an? )?(?:opinion|prediction|estimate|guess|projection|forecast)\b/i,
  /\b(?:guarantees|decides|settles|proves) nothing\b/i,
  /\bnothing is (?:decided|settled|guaranteed)\b/i,
  /\bgames? (?:still )?(?:has|have) to be played\b/i,
  /\bwhy they play the games?\b/i,
];

function truismProblem(blurb) {
  const t = TRUISM.find(re => re.test(blurb));
  return t ? `explains what a betting line is instead of saying anything (${t.source})` : null;
}

/* Stat ranks have to come from the supplied phrases, copied verbatim. Strip
   every phrase out of the blurb: anything left that still puts an ordinal
   next to "offense" or "defense" was written freehand, and freehand is how
   one team's defense rank ends up on the other team's offense. The number
   check cannot see that — the number is real, only its owner is wrong. */
const UNIT_WORD = /\b(?:offen[sc]e|defen[sc]e)s?\b/i;
const RANK_WORD = new RegExp('\\b\\d+(?:st|nd|rd|th)\\b|-ranked\\b|\\b(?:' +
  Object.keys(NUMWORDS).filter(w => /(st|nd|rd|th)$/.test(w)).join('|') + ')\\b', 'i');

function statProblem(blurb, facts) {
  let rest = blurb.replace(/[\u2018\u2019]/g, "'").replace(/[\u2010\u2011]/g, '-');
  for (const ph of [...(facts.away.statPhrases || []), ...(facts.home.statPhrases || [])])
    rest = rest.replace(new RegExp(ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  for (const sentence of rest.split(/(?<=[.!?])\s+/))
    if (UNIT_WORD.test(sentence) && RANK_WORD.test(sentence))
      return 'gives an offense or defense rank without copying one of the supplied statPhrases word for word';
  return null;
}

/* The previews leave the scoring table out: who has points riding on a game,
   not what the next band down pays. Banned in the prompt and checked here,
   because a prompt ban alone holds about five times in six. */
const TIER_TALK = /\b(?:tiers?|bands?|rungs?|pays)\b/i;
const tierProblem = blurb => (TIER_TALK.test(blurb) ? 'talks about scoring tiers or what a tier pays' : null);

function validate(blurb, facts) {
  const sub = substanceProblem(blurb);
  if (sub) return sub;
  const tru = truismProblem(blurb);
  if (tru) return tru;
  const tier = tierProblem(blurb);
  if (tier) return tier;
  const stat = statProblem(blurb, facts);
  if (stat) return stat;
  const nick = nicknameProblem(blurb, facts);
  if (nick) return nick;
  const dir = directionProblem(blurb, facts);
  if (dir) return dir;
  const exp = exposureProblem(blurb, facts);
  if (exp) return exp;
  const unit = unitProblem(blurb);
  if (unit) return unit;
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
- Whether a team COVERS the spread is irrelevant to everyone in this pool. Never write that an owner is vulnerable, safe, exposed or rewarded because a team did or did not cover. Only the game result and the resulting poll movement matter.
- tying pool points to the spread or to covering. Points come from AP poll position and change only when the poll updates. "A 20-point draft hangs on a 20.5-point spread" and "anything less than a blowout wipes his stake" are both wrong. Losing the GAME risking a poll slide is fine; covering is irrelevant to points.
- favorite/underdog inversion: in "ND -20.5" Notre Dame is favored. Describing the favorite as facing a hole, deficit, or upset climb is wrong.
- inverting exposure: the owner of the HIGHER-ranked, higher-point team has more to lose; the owner of a 0-point team is the one risking nothing
- ANY claim about the pool standings or the overall race (who leads, trails, is ahead, is winning, is collecting the pot) — the writer was not given standings, so any such claim is unsupported
- treating an outcome as settled or near-certain ("almost a certainty", "no room for surprise", "sits safely")
- inverting who has points at risk (the owner with more points has MORE to lose; an owner whose team is worth 0 is the one playing with house money)
- claiming home-field advantage when neutralSite is true
- any number, record, statistic, injury, or history not present in the facts
- predicting a winner or a final score as settled fact
- a scoring offense or defense rank attached to the wrong team or the wrong unit, or any such rank not copied from that team's statPhrases; a comparison the ranks do not support (calling a 60th-ranked unit the stronger one against a 20th-ranked one)
- a poll move turned around: pollMove says which way a team moved this week, and saying it fell when it rose (or the reverse) is wrong

Also mark ok=false if the writing is broken English: a garbled or mangled idiom ("rolls the night" instead of "rolls the dice"), a phrase that does not parse, a word that clearly is not the one meant, or a sentence a fluent speaker would not write.

Also mark ok=false for a sentence that only tells the reader what a betting line is or is not ("the market's opinion, not a result", "only a prediction", "guarantees nothing"). That is filler, not commentary.

Do NOT mark ok=false for opinion, sarcasm, insults, bluntness or informal tone — rudeness is intended and is not an error. Judge only factual support and whether the English is coherent.

Return one verdict per item, carrying that item's id.`;

  const parsed = await callClaude(sys, JSON.stringify(items, null, 1), AuditSet);
  return Object.fromEntries(parsed.verdicts.map(v => [String(v.id), v]));
}

let out = {};
const byId = new Map(games.map(g => [g.facts.id, g.facts]));
const failures = new Map();          // id -> why it was thrown away

/* Deterministic checks. A blurb that passes lands in `out`; one that fails
   records its reason so the repair round can hand that reason back. */
function ingest(items, label) {
  for (const item of items.games || []) {
    const k = String(item.id);
    const facts = byId.get(k);
    if (!facts) { console.error(`ignored unknown game id "${k}" — not in this week's slate`); continue; }
    if (typeof item.blurb !== 'string' || !item.blurb.trim()) { failures.set(k, 'empty blurb'); continue; }
    const spelled = americanize(item.blurb.trim().slice(0, 700));
    if (spelled.hits.length) console.error(`respelled ${k}: ${spelled.hits.join(', ')}`);
    const problem = validate(spelled.text, facts);
    if (problem) {
      console.error(`${label} rejected ${k}: ${problem}\n   ${spelled.text}`);
      failures.set(k, problem);
      delete out[k];
      continue;
    }
    failures.delete(k);
    out[k] = spelled.text;
  }
}

/* Second pass: a fresh call whose only job is to find claims the facts do not
   support. Catches semantic errors the numeric checks cannot see. */
async function auditInto(ids) {
  const subset = Object.fromEntries(ids.filter(i => out[i]).map(i => [i, out[i]]));
  if (!Object.keys(subset).length) return;
  const audit = await verify(subset, byId);
  for (const [id, verdict] of Object.entries(audit)) {
    if (verdict && verdict.ok === false) {
      console.error(`audit rejected ${id}: ${verdict.reason}\n   ${out[id]}`);
      failures.set(id, `fact-check: ${verdict.reason}`);
      delete out[id];
    }
  }
}

/* Six previews are read one after another, so a phrase that turns up in three
   of them reads as a template ("has nothing to lose", "is favored by 3.5 at
   home, which fits the ranks"). Team names, owners, numbers and the supplied
   stat phrases are masked first — those repeat legitimately — and any 4-word
   run left that two earlier previews already used sends this one back for a
   rewrite. This is style, not fact: a rewrite that fails the checks keeps the
   original rather than dropping it. */
const MASKS = new Set(['team', 'owner', 'stat', 'n', 'rank']);
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'at', 'is', 'it', 'its', 'for',
  'with', 'by', 'as', 'that', 'this', 'but', 'so', 'or', 'has', 'have', 'from', 'be', 'are', 'was']);

function wordRuns(text, f) {
  const esc_ = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = text.replace(/[\u2018\u2019]/g, "'");
  for (const ph of [...(f.away.statPhrases || []), ...(f.home.statPhrases || [])])
    t = t.replace(new RegExp(esc_(ph), 'gi'), ' stat ');
  for (const sd of [f.away, f.home])
    for (const n of [sd.name, sd.abbr, sd.nickname].filter(Boolean))
      t = t.replace(new RegExp(`\\b${esc_(n)}\\b('s)?`, 'g'), ' team ');
  OWNER_NAMES.forEach(n => { t = t.replace(new RegExp(`\\b${esc_(n)}\\b('s)?`, 'g'), ' owner '); });
  const w = t.toLowerCase().replace(/no\.\s*\d+/g, ' rank ').replace(/\d+(?:\.\d+)?/g, ' n ')
             .replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const runs = new Set();
  for (let i = 0; i + 4 <= w.length; i++) {
    const g = w.slice(i, i + 4);
    if (g.some(x => !MASKS.has(x) && !STOP.has(x))) runs.add(g.join(' '));
  }
  return runs;
}

function repeatedAcrossSet() {
  const used = new Map();                // run -> how many earlier previews used it
  const flagged = new Map();             // id -> the run it repeated
  for (const { facts: f } of games) {    // impact order: the top games keep their wording
    if (!out[f.id]) continue;
    const runs = wordRuns(out[f.id], f);
    const hit = [...runs].find(r => (used.get(r) || 0) >= 2);
    if (hit) flagged.set(f.id, hit);
    runs.forEach(r => used.set(r, (used.get(r) || 0) + 1));
  }
  return flagged;
}

try {
  ingest(await callClaude(SYSTEM, USER, BlurbSet), 'first pass');
  await auditInto(Object.keys(out));

  const styleOnly = {};                  // id -> the accepted text to fall back on
  for (const [id, run] of repeatedAcrossSet()) {
    console.error(`repetition ${id}: reuses "${run}"\n   ${out[id]}`);
    styleOnly[id] = out[id];
    failures.set(id, `reads like the other previews — it repeats the wording "${run}" (names and numbers masked). ` +
                     `Rewrite it with a different opening, order of ideas and phrasing`);
  }

  /* Repair round. Every rejection reason is a specific, actionable sentence —
     handing it straight back is far cheaper than regenerating the slate and
     recovers most of what a run would otherwise lose. One round only: a blurb
     that fails twice falls back to the page's own text, which costs nothing. */
  if (failures.size) {
    const wanted = [...failures.keys()].filter(id => byId.has(id));
    console.error(`repairing ${wanted.length}: ${wanted.join(', ')}`);
    const kept = Object.entries(out).filter(([id]) => !wanted.includes(id));
    const repairUser =
      `These previews were sent back. Rewrite ONLY these games, ` +
      `fixing the stated problem. Everything else in the brief still applies.\n\n` +
      wanted.map(id => `  ${id} (${byId.get(id).matchup})\n    sent back because: ${failures.get(id)}`).join('\n') +
      (kept.length ? `\n\nPreviews already accepted for the other games. Do not reuse their openings, ` +
                     `order of ideas or phrasing:\n` + kept.map(([, t]) => `  - ${t}`).join('\n') : '') +
      `\n\nFacts for the games to rewrite:\n` +
      JSON.stringify(wanted.map(id => byId.get(id)), null, 1);
    try {
      ingest(await callClaude(SYSTEM, repairUser, BlurbSet), 'repair');
      await auditInto(wanted);
    } catch (e) {
      console.error('repair round failed, keeping the first pass:', e.message);
    }
    // A rewrite for repetition that didn't survive keeps the accepted original.
    for (const [id, text] of Object.entries(styleOnly)) {
      if (!out[id]) { out[id] = text; failures.delete(id); console.error(`kept original ${id} (rewrite failed)`); }
    }
  }

  const rejected = failures.size;
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
  for (const [id, text] of Object.entries(TEAM_LINES)) console.log(`  ${id} team line: ${text}`);
  process.exit(0);
}

await writeFile(new URL('../commentary.json', import.meta.url), JSON.stringify({
  generated: new Date().toISOString(),
  model: MODEL,
  season, week, poll: poll.label,
  games: out,
  teams: TEAM_LINES,
}, null, 2) + '\n');

console.log(`wrote commentary.json — week ${week}, ${Object.keys(out).length} blurbs, model ${MODEL}`);
