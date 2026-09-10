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
If ESPN is unreachable it falls back to the cache, then to an embedded copy of
the preseason poll, so the page always renders.

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
the line, who owns what, and what the scoring table says a tier slip costs. It
switches to a result summary once a game goes final. No prose is hand-written,
so it never goes stale, and nothing in it is invented.

### Preview prose

The card already displays both ranks, both point totals, both owners and the
line, so the preview text does not restate any of it. It says three things, each
only when there is something to say:

- **The shape of the exposure** — points split across two owners, or all of it
  sitting with one of them while the other has nothing to lose.
- **What the board thinks**, as a reading rather than a repeat of the number:
  the board cannot separate them, inside one score, only the upset moves the
  pool. A mid-range line says nothing worth adding, so it says nothing.
- **What a slip costs**, as points rather than a band description — "a tier slip
  costs Chris 5 and Jim 2" instead of naming the band and letting the reader do
  the subtraction.

No. 25 is excluded from that arithmetic on purpose: below it is "receiving
votes", which still pays the same 2, so there is no honest delta to quote.

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

The preview under each upcoming matchup is written by **Claude Opus 5**
(`claude-opus-5`) at build time, never in the browser. A GitHub Action runs
`scripts/generate-commentary.mjs` Monday and Friday; it pulls the poll and the
slate, ranks the games by the impact model above, sends the facts to the
Anthropic API and commits the prose to `commentary.json`. The page loads that
file and **falls back to the rule-based preview** whenever it's missing, stale,
or the blurb for that game failed validation — so a bad run costs nothing.

The ESPN game context sits above the column either way: that part is fact, and
is not written by a model.

**The API key never reaches the browser.** This repo and the site are public — a
key in client-side JS would be scraped in hours. It lives in GitHub Actions
secrets and is only ever read inside CI.

### Setup

    gh secret set ANTHROPIC_API_KEY --repo karakotaram/ap-poll-pickem

### Local dry run (no key, no API call)

    DRY_RUN=1 node scripts/generate-commentary.mjs

Prints the model, the system prompt and the exact facts payload. Override the
model with `ANTHROPIC_MODEL=...`.

The same column is reused in the weekly email, so the page and the email never
say two different things about the same game. The commentary job runs an hour
before the email on Mondays for that reason — a column written for last week's
slate is discarded rather than shown.

### Notes on the Anthropic port

- **Structured outputs** (`output_config.format` with a Zod schema, via
  `client.messages.parse`) replace JSON mode and the hand-rolled brace scraper
  the Groq version needed. Blurbs come back as a typed array rather than prose
  we have to find a JSON object inside.
- **No temperature.** It is not a parameter on this model family, so the
  variety that `temperature: 0.85` used to provide now comes entirely from the
  per-game required opening angles. The audit pass likewise can't be pinned to
  temperature 0.
- **Thinking is on by default** on Opus 5, so it is not configured explicitly.
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

Expect most of 6 blurbs to survive. A dropped blurb costs nothing, a published
falsehood would.

### Model notes

`claude-opus-5` is the default. The guardrails below are not model-specific and
stay in place whatever is used — they were written against a weaker model and
every one of them earned its place by catching something real, so none were
removed on the port. Whether Opus 5 trips them as often is an open question:
the honest answer after the switch is that it has not been measured yet.

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

## Weekly email

`scripts/weekly-email.mjs` builds a message with the standings, two or three
sentences on what moved, and the games that matter next week. It **writes
`email.html` and `email-subject.txt` and sends nothing** — delivery is the
workflow's job, so the provider can change without touching the generator.

    DRY_RUN=1 node scripts/weekly-email.mjs     # prints a plain-text preview too

Every sentence is assembled from the poll and the schedule, the same rule the
page follows: nothing written by a model, nothing invented, and a win defends a
ranking rather than earning points.

Notes:

- **"What moved" quotes two numbers per player**, their net change and the
  biggest single team move behind it, because those differ. Oklahoma sliding a
  tier cost Chris 5 while his net was 3; saying only "gave back 3, with
  Oklahoma slipping" reads as though that move cost 3.
- **Ties share the sentence.** When two players post the same change they are
  named together rather than one being picked arbitrarily.
- **The body is ASCII**, punctuation included, and the script exits non-zero if
  a literal non-ASCII character reaches it. A raw em-dash renders as `â€"` in
  any client that guesses the charset.
- Games already played are filtered out; an email about last Saturday is
  useless. Run it after the new poll lands and after the ESPN week rolls over
  (Mondays around 3am ET) so "next week" means the upcoming slate.

### Sending

`.github/workflows/weekly-email.yml` runs it Mondays at 13:00 UTC (9am ET in
season, 8am once the clocks go back) and sends over Gmail SMTP. Every run
uploads the built `email.html` as an artifact, so what went out can be read
back rather than guessed at.

Three secrets, all set by you — the app password never passes through anything
else:

    gh secret set MAIL_USERNAME    # the Gmail address it sends from
    gh secret set MAIL_PASSWORD    # a Google *app password*, not the account password
    gh secret set MAIL_TO          # comma-separated recipients

**`MAIL_TO` is a secret on purpose.** This repo is public, and a committed list
of eight people's addresses is a list anyone can scrape.

Test without mailing anyone:

    gh workflow run "Weekly pool email" -f dry_run=true

That builds the email and uploads the artifact but skips the send step.

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
