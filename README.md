# AP Poll Pick'em

Single-file static site that scores the 8-team college football pick'em pool off
the live AP Top 25. Everything is in `index.html` — no build step, no backend,
no API key.

## Run it

Open `index.html` in a browser, or serve the folder:

    python3 -m http.server 8000     # then http://localhost:8000

## Deploy (free, gives the group a shared URL)

Any static host works, since it's one file:

- **Netlify Drop** — drag the folder onto https://app.netlify.com/drop
- **Vercel** — `npx vercel` in this folder
- **GitHub Pages** — commit `index.html`, enable Pages on the repo

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
