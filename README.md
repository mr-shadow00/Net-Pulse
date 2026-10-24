# NetPulse

A self-hosted network speed monitor for ZimaOS. It runs two speed tests on
a schedule you control, one after the other (never at the same time —
running both together would have each test starving the other of
bandwidth and giving misleadingly low numbers on both). Local and Global
deliberately use two **completely independent** engines on separate
infrastructure, so a problem with one (a rate limit, a temporary block, an
outage) can never take down both at once:

- **Local test** — uses the official **Ookla Speedtest CLI** (the engine
  behind speedtest.net), which automatically picks the nearest server,
  including ISP-hosted local ones, so you get a true local (e.g. BDIX)
  reading. The CLI is downloaded automatically on first use into the data
  folder (`data/bin`) and reused after that. Ookla's licence allows this for
  personal, non-commercial use, and NetPulse accepts it on your behalf. If
  Ookla can't run, or the nearest server is more than 60 ms away (not
  really local), the Local test falls back to Cloudflare's public speed test
  endpoints, so a run still produces a result. The server shown in the
  History table tells you which one ran.
- **Global test** — uses **NDT7**, the protocol from Measurement Lab
  (M-Lab), which is the same underlying tech behind Google's own "speed
  test" pop-up. Excludes any server in your own country and picks the
  best remaining one, automatically trying the next candidate if one
  doesn't respond.

Both engines pick their own server automatically — **there is nothing to
configure or scan for**. Both tests measure download, upload, latency and
jitter, and everything is plotted on two separate history graphs plus a
combined "Recent Speed Tests" list.

## Worth knowing about each engine

**Cloudflare's speed test** is plain HTTPS against `speed.cloudflare.com`
— no account, no API key, and it's the exact same infrastructure Cloudflare
runs their own public speed test on, so it's built to handle this kind of
traffic. It's commercial CDN infrastructure (not shared research infra),
so bandwidth isn't artificially capped the way some free measurement
platforms can be.

**M-Lab NDT7** is an open, non-profit measurement platform (partners
include Google) that **publishes collected test results publicly** for
internet-research purposes — see their
[privacy policy](https://www.measurementlab.net/privacy/). That openness
is the tradeoff for a free, globally-distributed research-grade server
network — which, being free rather than commercial, can have individual
servers that are busier or briefly unreachable more often than a large
commercial network. To offset that, NetPulse asks M-Lab's locate service
for several ranked nearby servers (not just the top one) and automatically
tries the next one if a server doesn't respond.

Neither engine needs any account, API key, or manual server URL from you,
and neither requires downloading or running any external binary — both
are plain HTTPS/WebSocket calls made directly from Node.

## How Global picks "outside your country"

M-Lab's locate service returns servers ranked by proximity, so for almost
everyone the nearest one is in their own country. NetPulse treats that top
entry's country as "home," drops every candidate in that country, and
tries the best few of what's left until one gives a full result — falling
through to the next if a server is busy or doesn't respond.

## How Global avoids wasting time on dead servers

Three things work together to cut down on Global failures from busy or
unreachable M-Lab servers:

1. **More candidates per run** — up to 8 (not just the top few), so a
   couple of bad servers in a row doesn't mean giving up.
2. **A quick handshake check first** — before running a full ~20-second
   download+upload test against a candidate, NetPulse opens a real
   WebSocket connection to it for a few seconds to confirm it's actually
   accepting connections. A dead or overloaded server gets ruled out in
   a few seconds instead of chewing through most of the time budget.
3. **Remembering what worked last time** — whichever server succeeded on
   the most recent run(s) is tried *first* on the next one (up to 8
   remembered, most-recent-first), since a server that worked recently is
   a good bet to work again. This is separate from the dynamic ranked
   list, so it still adapts automatically as conditions change.

## Automatic retry on failure

If a scheduled run has a server hiccup, NetPulse waits 2 minutes and
retries the *whole* Local+Global pair — up to 2 retries (3 attempts total)
— rather than leaving a failed hour sitting there until the next scheduled
run. Every attempt is still recorded in history. Manual "Run test now"
clicks are always a single attempt, so the button responds immediately.

## Running indicator

A small pulsing badge appears next to "NetPulse" in the top bar whenever a
test is actively running — manual or scheduled — and clears automatically
when it finishes.

## ISP plan, health colours and speedometer

Under **Settings** there are two plan panels, because most ISPs sell two
different speeds:

- **ISP Plan — Local (BDIX)** — your BDIX / local-network speed
- **ISP Plan — Global (Internet)** — your international internet speed

Enter the download/upload speed for each. Once set (blank = off):

- Each history chart gets a dashed **plan reference line** for its own plan.
- The stat cards are **health-coloured** (green / yellow / red). Speeds are
  judged against that network's plan (80%+ = green, 50-80% = yellow, below =
  red); latency and jitter use fixed thresholds, looser for Global since it is
  an overseas test. Thresholds live in the `HEALTH` object in `public/js/app.js`.
- The **speedometers** at the top of the dashboard scale around each plan and
  mark it with a dashed tick.

An old single plan saved by a previous version is copied to both networks
automatically.

### Speedometers

At the top of the dashboard each network (Local / Global) has a box with two
small speedometers: **Download** (blue) and **Upload** (green), plus Ping and
Jitter. They show the result of the **latest finished test** and update only
after a test ends - nothing moves while a test is running.

The dial scale uses fine, even steps (for example 0, 5, 10, 15 ... 50) so low
speeds are easy to read. If a plan is set, a dashed tick marks it and the
caption shows how much of the plan you got.

## Install on ZimaOS

1. Make these folders and copy the app files into them (rename `netpulse`
   in every path below if you want a different folder name — just keep it
   consistent with the compose file):
   ```
   /DATA/AppData/netpulse/app/    ← server/, public/, package.json go here
   /DATA/AppData/netpulse/data/   ← leave empty, NetPulse writes its db here
   ```
2. In ZimaOS: **App Store → Install a Customized App → Docker Compose** tab,
   and paste in the contents of `NetPulse compose.yaml`.
3. Start the app and wait for the first `npm install` to finish (check the
   container logs if it takes a while the first time).
4. Open `http://<your-zimaos-ip>:8091` and hit **Run test now**.

## Troubleshooting: tests won't complete

If **both** Local and Global fail at the same time, it almost always means
the container itself has no outbound internet access (check DNS inside
the container, Docker network mode, and firewall rules) — since the two
engines are otherwise completely independent of each other and don't
share any infrastructure.

If only **one** of them fails, that provider is likely having a temporary
issue — NetPulse already retries a few candidates automatically within a
Global run, and the scheduler retries the whole Local+Global pair a
couple of times if needed before giving up for that hour.

## Notes

- All data is stored as JSON in `/app/data/db.json` inside the data
  volume — back that file up if you care about your history.
- Bandwidth is measured the same way the official speed.cloudflare.com
  page / Google's speed-test pop-up would show you, since these are the
  same underlying engines.
