# AP Poll Pick'em

**Live: https://karakotaram.github.io/ap-poll-pickem/**

Single-file static site that scores the 8-team college football pick'em pool off
the live AP Top 25. Everything is in `index.html` — no build step, no backend,
no API key.

## Run it

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 8000     # then http://localhost:8000

## Deploy

Already deployed to GitHub Pages from `main` (root). Any push to `main`
rebuilds and republishes automatically — usually live within a minute:

    git add -A && git commit -m "update picks" && git push

The page carries a `noindex, nofollow` meta tag, so it won't turn up in search
results — it's reachable by anyone with the link, but not discoverable.

## How it works

Poll data comes from ESPN's public rankings API (CORS-open, no key):

    https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/
      seasons/<year>/types/<1|2|3>/weeks/<n>/rankings/1

On load the page fetches every week of the season in parallel — preseason
(type 1), regular season weeks 1–17 (type 2), and the post-playoff Final
Rankings (type 3) — and caches the result in `localStorage` for 30 minutes.
Each request carries a query param that rolls every five minutes: ESPN's CDN
serves these URLs stale-while-revalidate for up to **two hours**, so around
the Sunday drop an edge can keep answering "no ranks yet" long after the
poll is out — a rolling URL sidesteps the stale copy (the scripts do the
same). `no-store` only bypasses the browser cache, not theirs.
If ESPN is unreachable it falls back to the cache, then to an embedded
snapshot of the poll (refreshed in the repo now and then), so the page always
renders.

Team names are resolved from an embedded ESPN team-ID map, and each player's
picks are stored as ESPN team IDs — so nothing depends on fuzzy name matching.

## Games that matter

The section at the top ranks the week's games by **pool impact**, not national
hype, using ESPN's scoreboard API (schedule, AP ranks, records, betting lines,
TV, venue). Each game scores:

    impact = poolPointsAtRisk × volatility × headToHead + upsetUpside

- **poolPointsAtRisk** — points the drafted teams in that game currently carry
- **volatility** — `0.25 + 1.75·e^(−spread/9)`, so a pick'em is worth 2.0× and a
  50-point blowout only 0.26×. Without this a cupcake game involving the No. 1
  team outranks a genuine toss-up.
- **headToHead** — 1.8× when two *different* members' teams play each other
- **upsetUpside** — a bonus when a member owns an unranked team facing a ranked
  one, scaled by volatility so it only fires when the line says it's live

The commentary underneath is generated from those same facts — ranks, records,
the line, who owns what, and how each team moved in the poll. It
switches to a result summary once a game goes final. No prose is hand-written,
so it never goes stale, and nothing in it is invented.

### Preview prose

The card already displays both ranks, both point totals, both owners and the
line, so the preview text does not restate any of it. It says up to three
things, each only when there is something to say:

- **The shape of the exposure** — points split across two owners, or all of it
  sitting with one of them while the other has nothing to lose.
- **What the board thinks**, as a reading rather than a repeat of the number:
  the board cannot separate them, inside one score, only the upset moves the
  pool. A mid-range line says nothing worth adding, so it says nothing.
- **A team on the edge of the poll** — receiving votes, or at No. 25, the last
  scoring slot.

Previews leave the scoring table out: no "a tier slip costs Chris 5"
arithmetic. Who has points riding on a game is enough.

### Result prose

ESPN drops the betting line the moment a game goes final, so a finished game
cannot be described against expectation the way a preview can. The result
summary is built instead from the facts that survive, as independent clauses
that each appear only when they have something to say:

- **Margin** — shutout, one point, a field goal, one score. A routine 17-point
  win says nothing and leaves the room to the clauses below.
- **The poll** — an unranked team beating a ranked one, or a lower-ranked team
  winning outright.
- **The pool** — who was exposed, phrased by where that team actually sat:
  bottom of a scoring band, the last slot at No. 25, receiving votes, or not on
  the board at all.

Clauses know what the earlier ones said, so a rank already given isn't repeated
a sentence later. The effect is that two games with the same ownership shape
still read differently, which the single fixed template they replaced did not.

A win **defends** a ranking and never earns points, and the prose never implies
otherwise. Owning both sides of a game is only called a wash when both teams
actually score — if the winner is unranked the win banks nothing, and saying
otherwise inverts the owner's exposure.

## The column (Anthropic)

The preview under each upcoming matchup is written by **Claude Opus 5.5**
(`claude-opus-5-5`) at build time, never in the browser. A GitHub Action runs
`scripts/generate-commentary.mjs` as soon as the new AP poll lands (the
**Poll watch** workflow below) and again Friday once the lines have firmed
up; it pulls the poll and the slate, ranks the games by the impact model
above, sends the facts to the Anthropic API and commits the prose to
`commentary.json`. The page loads that file and **falls back to the
rule-based preview** whenever it's missing, stale, or the blurb for that game
failed validation — so a bad run costs nothing.

The ESPN game context sits above the column either way: that part is fact, and
is not written by a model.

Each preview is three or four sentences in the same plain register as the
weekly email's player entries: who has points riding on the game, how the two
teams match up, and what to watch — usually
whether a team that just moved in the poll can hold the spot. Each team's facts
carry its move in this week's poll, pre-phrased ("moved up from No.25 to No.14
in this week's poll") so the model copies a direction instead of working one
out.

### Team stats

The matchup sentence uses where each team ranks nationally in points scored
and allowed per game. The model gets these as ready-made phrases —
`"Texas's 55th-ranked scoring offense"` — and must copy them word for word. A
rank attached to the wrong team, or to offense instead of defense, would pass
the number check because the number itself is real; a fixed phrase is
something code can check. `statProblem()` strips every supplied phrase out of
the blurb and rejects it if anything left still puts an ordinal next to
"offense" or "defense", and the audit pass is told to look for misattributed
ranks too.

The same ranks also produce a plain line written without the model, e.g.
*"Texas's 9th-ranked scoring offense takes on Oklahoma's 120th-ranked scoring
defense. The other way, Oklahoma's offense ranks 64th and Texas's defense
12th."* It goes into `commentary.json` under `teams`, and the page shows it
under the built-in text only when the model's preview for that game was
rejected.

The data is one request for the whole FBS:

    https://site.web.api.espn.com/apis/common/v3/sports/football/
      college-football/statistics/byteam?group=80&season=<year>&seasontype=2

ESPN files points per game under the `passing` category (it repeats team
totals in every category); the `Own` split is offense and `Opponent` is what
the team allowed. Ranks are computed in the script, with ties sharing a rank,
rather than taken from ESPN's rank strings, whose direction for the `Opponent`
split isn't documented. A team needs two games played before it gets a rank,
and an FCS opponent has no FBS numbers, so that game gets a sentence about the
FBS side only.

**The API key never reaches the browser.** This repo and the site are public — a
key in client-side JS would be scraped in hours. It lives in GitHub Actions
secrets and is only ever read inside CI.

### Setup

    gh secret set ANTHROPIC_API_KEY --repo karakotaram/ap-poll-pickem

### Local dry run (no key, no API call)

    DRY_RUN=1 node scripts/generate-commentary.mjs

Prints the model, the system prompt, the exact facts payload and the team
lines. Override the model with `ANTHROPIC_MODEL=...`.

A column written for last week's slate is discarded rather than shown.

### Notes on the Anthropic port

- **Structured outputs** (`output_config.format` with a Zod schema, via
  `client.messages.parse`) replace JSON mode and the hand-rolled brace scraper
  the Groq version needed. Blurbs come back as a typed array rather than prose
  we have to find a JSON object inside.
- **No temperature.** It is not a parameter on this model family; the prompt
  asks for every preview to open differently instead. The audit pass likewise
  can't be pinned to temperature 0.
- **Thinking is always on** on Opus 5.5. Effort defaults to `medium` there (one
  level below Opus 5), so it is pinned to `high` explicitly.
- **Refusal fallback.** Calls go through `client.beta.messages.parse` with the
  server-side fallback (`fallbacks: "default"`): if the model declines, the API
  reruns the request on a fallback model in the same call instead of failing
  the week's run. The log line names the model that actually answered.
- Both calls report their token usage to the CI log, so cost is visible per run.
- **American spelling is enforced mechanically**, not just requested. The old
  prompt was itself written in British English, which is where "favoured" came
  from. Unlike every other check this one *corrects* rather than rejects —
  respelling a word cannot change what a sentence claims, and discarding an
  accurate blurb over one letter is a bad trade. Substitutions are logged.


### Guardrails

Prompt instructions turned out to be a request, not a guarantee — across ten
generations the model broke its own rules roughly one blurb in six. So every
rule that can be checked is checked in code, and any blurb that fails is
dropped (the page falls back to its built-in text for that game).

**Deterministic checks** in `validate()`:
- **Numbers** — every figure in a blurb must trace to that game's facts or a
  pool constant, with 0.5 tolerance so rounding a 9.5 line to "nine" passes.
  Caught `"Jim's five-point cushion"` on a team worth 25.
- **Banned phrases** — `lock`, `no-brainer`, `sure thing`, `will win` etc.,
  because the prompt ban alone did not hold.
- **Neutral sites** — no home/away/road language when `neutralSite` is true.
  Caught both `"home-field advantage"` at Lambeau and `"a road test"` at a
  neutral-site kickoff.
- **Inverted exposure** — risk language ("faces the toughest", "most to lose",
  "exposed", "at risk") may not be attached to an owner whose team in that game
  is worth 0. Only the span between the name and the risk phrase is checked for
  negation, so `"Mike has nothing at risk"` still passes. Caught
  `"Mike faces the toughest scenario"` for an owner holding zero — a blurb the
  prompt, which warns about this twice, and the audit pass, which is told to
  catch it, both let through.
- **Unit confusion** — a sentence may not compare a pool-point figure with the
  betting margin. Caught `"worth 20 points, far below the 22.5-point margin
  implied by the spread"`, which is a category error rather than a bad estimate:
  the two numbers measure unrelated things.

**Audit pass** — a second cold-temperature call fact-checks each surviving
blurb against only that game's facts, targeting semantic errors numbers can't
catch: inverted exposure, claims about the standings race, treating an outcome
as settled. It is told explicitly not to flag tone. Caught `"Jim is playing
with house money"` when Jim had 5 points exposed and Merc had 0.

**Prompt-side**, the model is told how scoring actually works (points come
from AP position — a win defends a ranking, it does not earn points), is not
given the standings at all (it kept inventing a race), and is barred from
restating anything the card already displays.

**Other:**
- Output is HTML-escaped before rendering; only roster names are
  re-emphasised, so model output cannot inject markup.
- A blurb is used only if generated for the week on screen and under 8 days old.
- Finished games always use the factual result line.
- If the API call fails, the script exits without writing, leaving the last good file.

- **Substance** — a blurb must be real prose (>=8 alphabetic words, sentence
  punctuation, not a placeholder). Added after qwen returned `"..."` for all
  six games, which every other check happily passed.

### Biasing toward a card that survives

Two things push the survival rate up without loosening a single check:

- **The prompt carries the actual failures.** Five runs of rejection logs turned
  into five named mistakes with the offending sentence quoted, rather than
  another abstract rule. The recurring ones were claims that reached beyond the
  single game supplied, claims about what other owners want, "neither owner
  gains anything" (false whenever a ranked team can climb), and risk words
  attached to an owner whose team in that game is worth 0.
- **A repair round.** Every rejection reason is already a specific, actionable
  sentence, so it is handed straight back with a request to rewrite only the
  games that failed. One round only; a blurb that fails twice falls back to the
  page's own text. Repairing costs a fraction of regenerating the slate, and it
  runs only when something was rejected.

Neither changes what is accepted — the checks are identical, and a blurb still
has to pass both the deterministic pass and the audit after being repaired.

Nothing checks whether a blurb is *legible*, only whether it is supported. "Karan
has twenty and a tier above him" was accurate — Texas at No.4 is worth 20 and the
only tier above is No.1 at 25 — and still needed explaining, because a bare tier
comparison reads as a deficit when it means headroom. Previews now leave tiers
out entirely: the prompt bans them, the facts no longer carry the tier table,
and `tierProblem()` rejects any blurb that mentions a tier, a band, or what one
pays.

Expect most of 6 blurbs to survive. A dropped blurb costs nothing, a published
falsehood would.

### Model notes

`claude-opus-5-5` is the default. The guardrails above are not model-specific
and stay in place whatever is used — they were written against a weaker model
and every one of them earned its place by catching something real, so none
were removed on the port. How often Opus 5.5 trips them has not been measured
yet.

Do not point this at a model with web search enabled — it would break the
only-supplied-facts guarantee the whole validation stack rests on.

Trial a model without publishing:

    gh workflow run "Generate matchup commentary" \
      --repo karakotaram/ap-poll-pickem -f model=<id> -f no_write=true

## Teams

The **Teams** tab shows one player's six teams at a time — pick the player from
the dropdown in the card header — with each team's record, last result, next
game and the betting line, alongside the AP rank and points they carry in the
selected poll. Every column except "Last game" sorts; click a header, click
again to reverse. The chosen player is remembered in `localStorage`.

Schedules for all 48 drafted teams are fetched up front, so switching players
is instant.

**Chg** is the team's point change against the previous poll in the selector,
named in the card header ("change vs Preseason"). An em-dash means there is no
earlier poll to compare against, which is different from an en-dash meaning no
change — the same distinction the Standings tab already draws. Note that ESPN
labels the first in-season poll "Week 2", so early in the year the comparison
runs against the preseason poll.

Data comes from ESPN's per-team schedule endpoint, one call per drafted team
(~10KB gzipped each, cached in `localStorage` for 15 minutes):

    https://site.api.espn.com/apis/site/v2/sports/football/
      college-football/teams/<id>/schedule?season=<year>

One call per team rather than a weekly scoreboard sweep, because "last completed
game" and "next scheduled game" stay unambiguous through bye weeks — and ESPN's
Week 1 sprawls across two calendar weekends, so "last week" is not a
well-defined question early in the season. The week label is shown next to each
game, which is what makes a bye visible (last: Wk 4, next: Wk 6).

Two ESPN quirks the code works around:

- **`team.recordSummary` ignores `?season=`.** It always reports the *current*
  season, so `?season=2025` would show a 2026 record. Records are counted from
  the completed events instead.
- **Postseason week numbers restart at 1.** A January playoff game reports
  `week.number: 1`, which would render as "Wk 1" next to a September date. The
  week's own `text` is used instead, so those read "Bowls".

Bowls and the playoff live in `seasontype=3`, a separate request. It only fires
for teams whose regular season has nothing left, so it costs nothing until
December.

### The line

Lines are not on the schedule endpoint, so they come from the weekly scoreboard
— one request per distinct week the next games fall in, which is normally one.

ESPN quotes `spread` from the **home team's** side: negative means the home team
is favored. The table flips it to the drafted team's side, so `-7.5` always
means *this* team is laying 7.5 and `+7.5` means they're getting it. Verified
against ESPN's own `details` string on all 55 games with a posted line.

A dash means no line is posted — normal for games against FCS opponents, and for
everything more than a week or so out.

The distilled schedule cache carries its own version (`SCHED_V`) on top of the
global `SCHEMA`. An entry whose version doesn't match is treated as a miss and
refetched. Without that gate, a cache written before the line feature shipped
was still inside its 15-minute TTL and had no event ids to match odds against,
so every line rendered as a dash — the page looked fine and was quietly wrong.
Shape checks beat remembering to bump a constant.

### Live scores

A game already underway shows its score in place of the kickoff time — the
drafted team's points first, green when they're ahead and red when they're
behind, with the game clock beneath it ("● 9:32 - 2nd"). The schedule
endpoint only carries a score once a game is final, so the score and the state
both come from the weekly scoreboard the matchup cards already use; the two
feeds share ESPN's event ids, which is what makes the join trivial. A game that
has just gone final reads "Final" with its score until the 15-minute schedule
cache turns over and moves it into the "Last game" column.

While anything is in progress the scoreboard cache drops from 15 minutes to 60
seconds and the page refetches on that cadence, redrawing the matchup cards and
the table. The loop stops on its own the moment nothing is live, and a hidden
tab waits its turn rather than spending a request nobody is looking at.

## Weekly email

`scripts/weekly-email.mjs` builds a message with the standings table and then
a short entry for each player, in standings order. It **writes `email.html`
and `email-subject.txt` and sends nothing** — delivery is the workflow's job,
so the provider can change without touching the generator.

    DRY_RUN=1 node scripts/weekly-email.mjs     # prints a plain-text preview too

An entry reads like:

> **1. Karan** — Gained 3 points this week: Missouri climbed from No. 25 to
> No. 14 (+8), LSU climbed from No. 11 to No. 10 (+5) and Florida slid from
> No. 8 to No. 16 (-10). Has led since Week 3. Will see if Missouri can hold
> on to its jump to No. 14 when it hosts Merc's Texas A&M as a 3.5-point
> favorite.

Three sentences, each assembled from the poll, the poll history and the
schedule — nothing written by a model, nothing invented, and a win defends a
ranking rather than earning points:

- **The week.** Net change, then every team move behind it with its own
  number, because the two differ: a net of +3 can be +8, +5 and -10. Moves in
  the direction of the net come first. When nothing crossed a scoring tier,
  the biggest move inside one is named instead (two spots or more).
- **The place.** Standings are recomputed for every poll this season, so the
  entry can say "has led since Week 3", "has been 6th since Week 5", "up from
  4th to 2nd, a season high" or "takes over first from Murph". Season highs
  and lows are only called once there are three polls to compare.
- **The game to watch.** One of the player's games this week, picked by the
  points the team carries scaled by how close the line is (the same volatility
  curve as the page's impact model), with a bump for a team that just moved
  four or more spots or entered or left the poll, and for an unranked team
  facing a ranked one. Another player's team on the other side counts extra
  only when it carries points, since only then does the game move two totals.
  The line is read from ESPN's `details` string ("MIZ -3.5"), which names the
  favorite, and turned into "as a 3.5-point favorite" from the team's side.

The email no longer carries game previews; those live on the site.

Notes:

- **Ties show as `T-3.`** on the entry, and a move into a tie reads "to a share
  of 3rd".
- **The body is ASCII**, punctuation included, and the script exits non-zero if
  a literal non-ASCII character reaches it. A raw em-dash renders as `â€"` in
  any client that guesses the charset.
- Games already played are filtered out; an email about last Saturday is
  useless. ESPN's "current" scoreboard week only rolls over Mondays around
  3am ET, so on a poll-drop Sunday it still points at the week just played —
  the generator (and the commentary script, and the page) detects a week with
  no game left to play and advances one week, so "next week" means the
  upcoming slate whenever it runs.

### Sending — the Poll watch workflow

The AP poll posts Sunday afternoons in season, usually just after 2pm ET.
`.github/workflows/poll-watch.yml` checks for it through the afternoon and
sends the email the same day instead of waiting for Monday:

- **Sunday hourly, 15:10–23:10 UTC** (11:10am–7:10pm EDT), then **00:10–02:10
  UTC Monday** (Sunday evening ET)
- **Mon 13:00 UTC** — the old Monday-morning slot, kept as the last resort

The density is not caution, it is measurement: GitHub runs cron at low
priority and has fired this repo's slots **2.5 to 7 hours late every week**
— a nominal 2:10pm check was executing near 5pm. With hourly slots starting
before the drop, some delayed firing always lands shortly after the poll is
actually up, whatever that day's drift. A manual "Run workflow" dispatch
never queue-drifts; use it to send immediately.

Every run starts with `scripts/poll-gate.mjs`, which compares the latest poll
ESPN has against the marker in `.github/poll-state.json` and stands down
unless there is a poll we haven't processed. When there is one, the run
generates the commentary for the site, commits it, builds the email, sends over Gmail
SMTP, and only then advances the marker — so a failed run is retried by the
next cron rather than lost. The extra firings all hit the gate and exit,
which is what makes the generous schedule safe.

A poll the gate finds more than 3 days old (the repo was merged or fixed
late) is recorded without emailing: a stale "news" email is worse than none.

Every send uploads the built `email.html` as an artifact, so what went out
can be read back rather than guessed at.

Three secrets, all set by you — the app password never passes through anything
else:

    gh secret set MAIL_USERNAME    # the Gmail address it sends from
    gh secret set MAIL_PASSWORD    # a Google *app password*, not the account password
    gh secret set MAIL_TO          # comma-separated recipients

**`MAIL_TO` is a secret on purpose.** This repo is public, and a committed list
of eight people's addresses is a list anyone can scrape.

Test without mailing anyone:

    gh workflow run "Poll watch" -f force=true -f dry_run=true   # gate + column + email, nothing sent, marker untouched
    gh workflow run "Weekly pool email" -f dry_run=true          # just the email build

Both upload the built artifact and skip the send step. `Poll watch` with only
`-f force=true` resends for a poll the marker already covers; the "Weekly pool
email" workflow itself is manual-only now — its schedule moved to Poll watch.

## Scoring

| AP rank | Points |
|---|---|
| No. 1 | 25 |
| Nos. 2–6 | 20 |
| Nos. 7–10 | 15 |
| Nos. 11–15 | 10 |
| Nos. 16–20 | 5 |
| Nos. 21–24 | 3 |
| No. 25 | 2 |
| Top 3 receiving votes | 2 |

Teams outside the top 25 that are receiving votes show as **ARV**; the top 3 of
those score 2 points, the rest score nothing.

A player's score is the sum of all 6 of their teams in the selected poll.
Poll ties (two teams sharing No. 14) score by the rank shown. "Others receiving
votes" uses a strict top-3 cutoff in ESPN's listed order.

## Money

8 × $200 = **$1,600 pot**, split across two polls:

- **Pre-playoff (40%, $640)** — last regular-season AP poll, i.e. the final poll
  before the playoffs. $400 / $160 / $80.
- **Post-playoff (60%, $960)** — the Final Rankings poll after the playoffs.
  $600 / $240 / $120.

Both show live projections off the currently selected poll until the real poll
lands, then flip from `PROJECTED` to `FINAL`. Tied players split the sum of the
places they occupy (three-way tie for 3rd → each gets $80/3 pre, $120/3 post).

## Editing picks

Player rosters live in the `payload` JSON near the bottom of `index.html`,
under `"roster"`. Picks are ESPN team IDs; look one up in the same blob's
`"teams"` map (id → `[name, abbrev, color]`).

## URL options

- `?season=2025` — score any past season (useful for testing; 2025 has a full
  17-poll history)
- `?poll=3` — open on a specific poll index instead of the latest
