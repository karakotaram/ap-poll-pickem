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
