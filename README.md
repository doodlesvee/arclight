# Arc Light

A self-hosted media library for a personal video collection, built around one
idea: **your filesystem is the source of truth, and no metadata ever comes from
the internet.**

It scans folders you point it at, works out performers, studios, release dates
and titles from how the files are named and filed, and gives you a browsable
library over the top. Nothing is looked up externally, nothing is uploaded, and
the files themselves are opened read-only.

## Built around your collection

- **One library for mixed media.** Videos, photos and folders share a single
  library, with categories and collections you define.
- **Your naming conventions.** The scanner reads what it can from paths and
  filenames without requiring an external match to add an item.
- **Your edits take priority.** The scanner owns a field until you edit it,
  then preserves your changes on subsequent scans.

## What it does

- **Scans** a set of folders you choose, on demand or on an interval
- **Derives** performers, studios, release dates and titles from paths and
  filenames — see [Naming](#naming) below
- **Streams** with HTTP range support, so seeking works
- **Generates** poster frames and multi-segment hover previews with ffmpeg
- **Organises** with tags, favourites, 1–5 star ratings, categories, manual
  and rule-based collections, and saved searches
  Ratings are set directly; there is no pairwise video-ranking feature.
- **Edits in bulk**: select any number of tiles to favourite, rate, tag, set
  a studio, add or remove a performer, or file them into a collection
- **Groups** by performer, studio, album and series, each with its own
  browsable page
- **Tracks** watch progress, play counts and a watched state, plus an
  hour-by-hour watch log that powers [Your stats](#your-stats)
- **Maps who works with whom** — Performers → Network draws a graph linking
  performers by the videos they share or the studios they have in common,
  with focus, hide and shortest-path tools
- **Explores the library as a map** — performers, studios, tags, albums and
  series connect wherever they share visible media; search to pull any entity
  and its strongest links into view
- **Previews the seek bar**: hover or drag along it to see the frame you're
  about to jump to, bookmark moments inside a video, and attach private notes
  to those timestamps
- **Sorts** by date added, release date, title (A–Z or Z–A) and more, and
  remembers the choice per page
- **Works on a phone** over your wifi — a drawer sidebar, swipeable hero and
  touch-sized controls; see [Using it from a phone](#using-it-from-a-phone)
- **Hides itself** on a keypress — see [Discreet mode](#discreet-mode)
- **Glows and idles**: an optional ambient light behind the player picks up
  the colours on screen, and an optional poster screensaver drifts through
  your library after a few idle minutes (never over a playing video)
- **Adapts** to how you like it drawn, without a rebuild — see
  [Appearance](#appearance)
- **Fills the homepage's bottom backdrop** with a darkened collage of up to
  48 newest video thumbnails, refreshed every 30 seconds while the page is open.
- **Casts** to a Chromecast or smart TV from Chrome, or AirPlay from Safari —
  see [Casting to a TV](#casting-to-a-tv)
- **Shows where the space goes** — Site settings → Storage: the library's
  total and what it is made of, a studio donut, performers ranked by space,
  the largest files, space by release year, resolution, and scenes kept at
  more than one quality
- **Backs up** the database and your uploaded artwork to a single archive
- **Survives reorganisation**: files are matched by content hash, so moving or
  renaming one keeps its tags, framing and watch history

## Stack

| Layer | Choice |
|---|---|
| Server | Node 22, TypeScript, Fastify |
| Database | PostgreSQL 17, Drizzle ORM |
| Frontend | React 19, Vite, TanStack Router/Query, Tailwind 4 |
| Media | ffmpeg/ffprobe (probing, posters, previews), sharp (images) |
| Deployment | Docker Compose |

The REST API is documented at `/api/docs` (Swagger UI), and is deliberately a
plain HTTP API rather than a TypeScript-only RPC layer, so other clients can
be written against it.

## Data model

One polymorphic `media_items` table rather than a table per content type —
that's what lets videos, photos and folders sit in one library and be grouped
however you like, instead of being locked into "Movies" or "Photos".

```mermaid
erDiagram
    libraries ||--o{ library_roots : "folders to scan"
    libraries ||--o{ media_items : contains
    libraries ||--o{ series : contains
    library_roots ||--o{ media_files : "found under"
    series ||--o{ media_items : "episodes belong to"

    media_item_types ||--o{ media_items : "video / photo / folder"
    media_items ||--o{ media_files : "one item, many paths over time"
    media_items ||--o{ media_items : "parent_id — folders nest"
    studios ||--o{ media_items : released
    albums ||--o{ media_items : "album_id (no FK)"

    albums }o--|| performers : "whose"
    albums }o--|| studios : "whose"
    albums }o--o| media_items : "cover_item_id"

    media_items ||--o{ media_item_tags : ""
    tags ||--o{ media_item_tags : ""
    media_items ||--o{ media_item_performers : ""
    performers ||--o{ media_item_performers : ""

    collections ||--o{ collection_items : "manual membership"
    media_items ||--o{ collection_items : ""

    users ||--o{ sessions : ""
    users ||--o{ webauthn_credentials : "passkeys"
    users ||--o{ playback_states : ""
    media_items ||--o{ playback_states : "position, watched, play count"

    media_items {
        int id PK
        int parent_id FK "folders nest"
        int item_type_id FK
        int studio_id FK
        int series_id FK "set by hand — nothing in a filename implies it"
        int album_id "soft link"
        text title
        text title_source "filename | user"
        text performers_source "scanner | user"
        text studio_source "scanner | user"
        text kind "video | movie | series, set by hand"
        int season_number
        int episode_number
        text episode_title
        date release_date "parsed from the filename"
        bool is_favorite
        bool in_scope "folder still watched?"
        timestamp missing_since "file gone from a watched folder"
        jsonb extra_metadata "codec, camera, GPS"
    }

    series {
        int id PK
        int library_id FK
        text name
        text name_source "scanner | user"
    }

    media_files {
        int id PK
        int media_item_id FK
        int root_id FK
        text path UK
        text content_hash "how a moved file is recognised"
        bigint size_bytes
        timestamp mtime
    }

    albums {
        int id PK
        text path UK "the directory itself"
        int cover_item_id FK "chosen photo, else the first"
        int cover_position_x "framing, display only"
        int cover_scale
    }
```

Four decisions worth knowing:

- **`media_files` is separate from `media_items`.** An item is the thing you
  tagged and rated; a file is where it currently lives. Files are matched back
  by `content_hash`, so moving or renaming one on disk keeps everything you
  did to it.
- **`*_source` columns arbitrate ownership.** The scanner writes a field until
  you edit it in the app, then never touches it again. That's what makes "I
  removed this performer" survive a rescan, with no override table.
- **`in_scope` and `missing_since` mean different things.** The first is "you
  stopped watching that folder", the second is "the file vanished from a
  folder we do watch". Conflating them once flagged 273 items as missing.
- **`media_items.album_id` has no foreign key**, deliberately: `albums`
  already points back at `media_items` for its cover, and a hard constraint in
  both directions needs deferred checks for no practical gain.

Not shown, because nothing references them: `scan_jobs`, `categories`,
`app_settings` (a key/JSONB store holding hero picks, scan interval,
appearance and the privacy password hash) and `activity_events` (an
append-only log of type/message/metadata rows behind the activity feed).

## Running it

Requires Docker and Docker Compose.

```bash
git clone git@github.com:doodlesvee/media-server.git
cd media-server
make up
```

(`make up` is `docker compose -f docker/docker-compose.yml up -d --build` plus a lookup of this machine's
address for the phone link in Settings. `make` on its own lists the other
commands: `down`, `restart`, `logs`, `ps`, `dev`, `reset`.)

Open <http://localhost:3000>. The first screen creates your account; there is
no default login. Then add your video folders under Settings → Library; the
folder picker starts at your home folder.

That is the whole setup. ffmpeg, the database and everything else are inside
the containers, so nothing needs to be installed on the host and no `.env` file
is needed. Port 3000 taken? Start it with `APP_PORT=3001 make up`.

Settings shows the address to open on your phone because `make up` looks up
this machine's wifi address and passes it in. Create `docker/.env`
from `.env.example` only if you want to change one of the settings below.

If you instead run the server directly on your machine (`npm run dev`, for
development), ffmpeg and ffprobe must be installed there — `brew install ffmpeg`
on macOS, `sudo apt install ffmpeg` on Debian/Ubuntu. Without them videos still
scan, but get no thumbnail, preview or duration.

### Configuration

`docker/.env` is gitignored and holds the machine-specific paths:

| Variable | Meaning | Default |
|---|---|---|
| `MEDIA_ROOT` | Your library, mounted **read-only** | `./media-placeholder` |
| `HOME_ROOT` | What the in-app folder browser may look at, read-only | your home folder |
| `BACKUP_DIR` | The one writable mount. Backups are written here, and anything you drop in is offered for restore | `../backups` |
| `COMPOSE_FILE` | Which compose files a bare `docker compose` picks up | — |
| `WEBAUTHN_ORIGIN` | Where the browser thinks it is, for Touch ID. Comma-separated; all must share a hostname | `http://localhost:5173,http://localhost:3000` |
| `LAN_HOST` | This machine's address on the wifi, so Settings can show the URL to open on a phone. Filled in for you when you start through `docker/with-lan-host.sh`; set it to override | detected |
| `LAN_PORT` | The port that URL uses — the one a phone actually opens | `5173` in dev, `3000` in production |

`.env.example` also has `DATABASE_URL`, `PORT` and `APP_DATA_DIR` — those only
matter if you're running the server directly on the host (`npm run dev
--workspace apps/server`) rather than through Docker; the Docker path hardcodes
its own values for these inside the compose file.

### Using Arc Light in a browser

Start Docker, then build and start the server:

```bash
make up
```

Open <http://localhost:3000> in your browser. Arc Light does not require a
desktop launcher or an installed browser app. Use Chrome for Chromecast;
Touch ID uses the browser's passkey support.
Registered passkeys can also sign you in: choose **Sign in with passkey** on
the login screen. Register one first under Site settings → Privacy while
signed in with your password. Passkeys require localhost or HTTPS; password
sign-in remains available as a fallback.

The vault also supports **Unlock with passkey** after you set its PIN and
register a passkey. PIN unlock remains available as a fallback. A vault
passkey check unlocks only the current session's vault, not other privacy
actions; leaving the vault page or choosing **Lock now** locks it again.

Closing the browser leaves the server running; `make down` stops it.
Docker Desktop can optionally start at sign-in so the existing containers
restart with Docker.

The browser icons are drawn by `node scripts/make-icons.mjs`; the results are
committed, so you only run it after changing the design.

### Using it from a phone

**Settings → Privacy → Local network access** decides whether other devices on
the wifi can open the server. Turning it on shows the address to type on the
phone; turning it off makes every other device get a short "not available
here" page instead. It applies immediately — nothing restarts.

The switch reads the address the request asked for, not where it came from.
Under Docker there is no choice: every request reaches the container through
the bridge gateway, so a browser on this machine and a phone on the wifi both
arrive as `172.18.0.1` and the connection itself cannot tell them apart. The
Host header can — this machine says `localhost`, anything else has to name the
host by its LAN address.

Which makes it a convenience switch and not a lock. It stops the app being
*usable* from other devices; someone who thought to forge a Host header would
reach the login screen, and the password is what stops them there. If you want
it genuinely sealed off, publish the port to loopback only — `127.0.0.1:5173:5173` in dev, `127.0.0.1:3000:3000` in production,
in the compose file — and nothing from the network reaches the container at all.

A container can only see its own address on the Docker bridge, which is no use
to a phone, so `docker/with-lan-host.sh` — run in front of your `docker compose`
command — looks up this machine's wifi address as it starts and passes it in. Settings then shows the URL for the phone, with a **Show QR** button that
opens it as a code to scan with the phone's camera. If you move to another
network, starting again picks up the new address.

To pin it instead — or if you start the containers with `docker compose`
directly — set it yourself; an explicit value always wins:

```sh
echo "LAN_HOST=192.168.1.18" >> docker/.env
```

In the player, double-tap the left or right third of the video to skip back or
forward 10 seconds; keep tapping to skip further. The fullscreen button locks a
wide video to landscape where the browser allows it (Chrome on Android).

**Set `COMPOSE_FILE` if you develop against this.** Without it a plain
`docker compose up -d` in `docker/` reads the base file alone, which has no
`command:` — the production image supplies one, but the image built for
development is the `deps` stage, whose command is just `node`. The container
starts, exits 0 immediately, and restart-loops with no logs at all, which
looks exactly like the whole app being broken:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
```

Everything else — which folders to scan, scan interval, categories, hero
picks — is configured in the app under **Site settings**, not in env vars.

### Casting to a TV

A **Cast** button appears on the player once the browser finds a Chromecast,
smart TV or Apple TV on the network — never before, so it is absent in a house
without one.

From desktop Chrome, the browser streams the video to the TV itself, so it
works with no setup. From an Android phone, and with AirPlay, the TV is handed
a link and fetches the video on its own. That link carries a signed token for
that one video, valid for six hours, so the TV needs no login — but it has to
be able to reach this machine, which the npm start scripts arrange by passing
in `LAN_HOST` (see above).
The token also lets the stream through when Local network access is off; every
other request from the network is still refused.

### Development

Runs the server and Vite in containers with the source bind-mounted:

```bash
sh docker/with-lan-host.sh docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up -d --build
```

The web app is then on <http://localhost:5173>, proxying `/api` to the server.

> **On macOS, bind-mounted file changes do not raise inotify events inside the
> container**, so the dev override sets `CHOKIDAR_USEPOLLING` for both
> `tsx watch` and Vite. Edits show up live, at the cost of a little background
> CPU while dev mode is running. The same limitation is why library scanning
> is interval-based rather than using a file watcher.

To tear everything down regardless of which mode you started, name both
compose files and add `--remove-orphans`, so a `web` container left over from
dev mode is caught even if you only started the base file:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml down --remove-orphans
```

`node_modules` is a named volume rather than part of the bind mount, so the
host's copy (built for the host's OS and architecture) can't shadow the
Linux-native one — sharp's binary in particular. The cost is that **installing
a dependency takes three steps**: on the host so typechecking sees it, inside
the container so the app can import it, then a restart of both so Vite
re-scans:

```bash
npm install <package> --workspace apps/web
docker compose run --rm --no-deps --entrypoint sh app -c "cd /repo && npm install"
docker compose restart app web
```

Migrations are generated with `npm run db:generate -w apps/server` and applied
automatically on boot.

### Tests

The web tests are self-contained: `npm test -w apps/web`.

The server tests are integration tests against a real Postgres, and some of
them clear and rewrite folders under `APP_DATA_DIR`. **Never run them inside
the running `app` container** — its `APP_DATA_DIR` is your real `app-data`
volume, and a run there deletes uploaded performer photos and generated
artwork. Run them against a throwaway database and a scratch data folder
instead:

```bash
docker run -d --rm --name media-test-pg -p 55432:5432 \
  -e POSTGRES_USER=media -e POSTGRES_PASSWORD=media -e POSTGRES_DB=media \
  postgres:17-alpine

APP_DATA_DIR=$(mktemp -d) \
TEST_ADMIN_URL=postgres://media:media@localhost:55432/media \
TEST_DATABASE_URL=postgres://media:media@localhost:55432/media_test \
  npm test -w apps/server

docker stop media-test-pg
```

The video tests need `ffmpeg` on the machine running them; without it on the
host, run the same command in a disposable container from the app image with
none of the real volumes mounted.

## Naming

The scanner reads two things: **where a file is** and **what it's called**.
Neither is mandatory — a file with an unhelpful name still imports, plays and
can be organised by hand.

### Folders

```
<library root>/<Performer>/<Studio>/file.mp4
                    │          └── optional: sets the studio for everything inside
                    └── the performer whose collection this is
```

Images in a folder are treated as a **gallery belonging to the video beside
them**, not as separate library items — so a scene and its stills stay
together.

### Filenames

The declared convention, opted into by a **leading `[`**:

```
[Studio] Performer 1, Performer 2 - MM.DD.YYYY - Video title.mp4
```

Everything in it is optional except the studio bracket. A filename that
doesn't start with `[` is read the older, looser way: the folder names the
performer, and a `[Bracket]` anywhere supplies the studio.

Because you typed the brackets and commas deliberately, names inside them are
trusted literally — which is what makes it safe to create performers from a
filename without guessing. It also means **a video with two performers needs
only one file**; listing both credits it to both.

Release dates are read as `MM.DD.YYYY` or `YYYY.MM.DD`, told apart by which end
carries the four-digit year. Two-digit years are ignored rather than guessed at.

Where two sources disagree, the more deliberate one wins:

1. what you edited by hand in the app — permanently
2. a leading `[Studio]` in that specific file's name
3. the `<Studio>/` folder
4. a `[Bracket]` elsewhere in the filename

## Discreet mode

`Ctrl/Cmd + Shift + H` blurs every image in the app, from any page, instantly.
Press it again and it asks for proof before letting go — a **privacy password**
or **Touch ID**, whichever you've set up under Site settings → Privacy.

The asymmetry is the point: arming it is free and immediate, because you press
it when someone walks in. Releasing it costs something, because otherwise
anyone at the screen just presses it back.

- The **privacy password is separate from your account password** on purpose:
  this one gets typed in front of whoever made you press the key. Setting or
  clearing it needs your account password, which is also the way back if you
  forget it.
- **Touch ID** is WebAuthn with a platform authenticator. Your fingerprint
  never leaves the machine — only a signature over a one-time challenge does,
  and there's nothing biometric in the database to leak. It needs a secure
  context, so it works over `localhost` but not over plain HTTP by IP.
- Five wrong password attempts buys a 60-second wait, and each further wrong
  guess re-arms it.
- Optionally it blurs **names** too. A blurred picture with the performer and
  studio legible underneath hides less than it looks like it does.

**What it is honestly worth:** a blur drawn by your browser. It defeats a
glance over your shoulder. It does not defeat developer tools, clearing site
data, or anyone with real access to your unlocked machine.

## Appearance

`Ctrl/Cmd + Shift + ,` opens a panel over whatever page you're on — tile size,
tile shape, what a tile writes on itself, banner height, whether hovering
expands a tile and whether it plays a preview clip. It's deliberately not a
settings page: these are choices you can only judge by looking at them, and the
page behind the panel resizes as you drag.

**Tile shape** switches media tiles between landscape (16:10, the default) and
portrait (2:3), and is its own control rather than an entry in the view-mode
picker — the mode is three sizes of one card, so folding shape into it would
mean choosing between the shape you wanted and the size you wanted. Portrait
narrows the column to match, so a card keeps about the same area and the size
slider goes on meaning one thing in both shapes.

A video still is wide, so a portrait frame crops its sides. Reframe picks which
band it keeps, from a tile's details — the framing preview is drawn at whichever
shape is currently set, so what you choose there is what the tile shows.
Performer cards are unaffected: they have always been 2:3, and they are
portraits of people rather than artwork whose shape is a preference.

Settings are stored server-side, so one look follows you between browsers. The
browser keeps a copy too, read synchronously, so a reload paints correctly
instead of flashing the defaults.

Which sections the homepage has, and in what order, lives under Site settings →
Homepage — it's a layout decision made once, not a slider.

Ambient light and the poster screensaver are here too. The screensaver's idle
time, how long each poster stays up, what it shows (everything, favourites,
unwatched or 4★ and up) and whether it shows a clock are all set in the same
panel.

A performer's round avatar can be framed separately from their portrait tile,
since a face that fits a 2:3 card is often off-centre in a circle; a circle
that has never been adjusted keeps using the tile's framing.

## Your stats

*Your stats*, at the bottom of the sidebar (and linked from Profile), looks
back on your watching as a year in review:

- **Opening** — total hours watched, with streaks, active days and your
  average day
- **01 The podium** — your #1 video (pin one yourself, or it picks your most
  watched), a performer podium, and ranked lists by plays and rating
- **02 Your year** — hours per month; click a month for a written recap of it
  (time, top performer and studio, busiest day, what you had on repeat), and
  the last twelve months as GitHub-style calendars, one block per month
- **03 Your habits** — the hours and weekdays you watch most
- **04 Trophies** — achievements unlocked and still to unlock

It is built from the watch log, which records how long you watched each video
in hour-sized buckets. Only time watched since the log was added counts, so a
fresh install — or a month you haven't watched in yet — starts quiet and fills
in as you use it.

## Smart collections

A smart collection is a saved rule rather than a list, so it keeps itself up
to date. Conditions can be combined with *all* or *any*: tag, type, title,
added within N days, rated at least N stars, favourite, watched, played at
least N times, longer or shorter than N minutes, and not watched in N days.

The last one only matches things you *have* played, so "favourite and not
watched in 90 days" finds forgotten favourites rather than everything you've
never opened. The new-collection dialog has that and a few other presets to
start from.

## Keyboard

| | |
|---|---|
| `Ctrl/Cmd + K` | Search anywhere — performers, studios, titles, as you type |
| `Ctrl/Cmd + Shift + H` | Discreet mode on, or off with proof |
| `Ctrl/Cmd + Shift + ,` | Appearance panel |
| `1`–`5` / `0` | On a tile: rate it, or clear the rating |
| `Space` / `K` | Play or pause |
| `←` `→` | Skip 10 seconds |
| `0`–`9` | Jump to that tenth of the video — `5` is halfway, `0` the start |
| `↑` `↓` | Volume |
| `F` / `M` | Fullscreen / mute |
| `B` | Bookmark the current moment |
| `Esc` | Close the innermost thing that's open |

The full list, including search and editing, is at `/help` in the app. Single-
key shortcuts are ignored while you're typing, so a space in a title stays a
space rather than pausing a video.

## Backups

**Back up now** in Site settings writes a single `.tar.gz` containing a full
`pg_dump` and every image you've uploaded. Posters, previews and generated
thumbnails are deliberately excluded — they're regenerable from your videos,
and including them would take a backup from a few MB to tens of GB, which in
practice means it stops being run.

### Restoring

**Restore** sits next to each archive in the same panel. It replaces the whole
library — database and uploaded images — and signs you out, because the account
comes from the backup too. The app doesn't need to be stopped: it gates
incoming requests, stops its own scan timer, swaps the database, and then
applies any migrations the archive predates.

Confirming it means typing the archive's date, so picking the wrong one out of
ten near-identical filenames is caught before rather than after. If a privacy
password or passkey is set, restoring also asks for it — the same credential
that guards the missing-videos manager. A fresh install has no credential to
ask for, which is what keeps it recoverable.

Three things make it safe to say yes to:

- **A snapshot of the current library is taken first**, so a restore can be
  undone by restoring that snapshot. The panel names it afterwards.
- **The archive you restore *from* is never pruned** to make room for that
  snapshot. It used to be possible for the newest-10 rule to quietly delete the
  known-good archive someone was reaching for.
- **A failed restore changes nothing.** The dump is applied in a single
  transaction, so an interrupted or corrupt one rolls back whole and the
  library is exactly as it was.

A backup taken by a *newer* version of the app is refused rather than applied.
Drizzle's migrator compares the local migration list against the database's
newest recorded migration, so a database already past every migration the code
knows about silently matches none of them and reports success — leaving the app
querying a schema it no longer models. Each archive records the version that
wrote it so that case can be caught up front.

### Moving to another machine

`BACKUP_DIR` is a bind mount, so an archive is visible to the app as soon as
it's in that folder:

1. `git clone`, and copy the `.tar.gz` into `backups/`.
2. Point `MEDIA_ROOT` at the videos and run `make up`.
3. Create any account — it's thrown away in a moment — to get past the
   first-run screen.
4. Site settings → Backup → **Restore** on that archive.
5. Sign in with the password you had when the backup was taken.
6. Run a scan. Files are matched back to their existing records by content
   hash, not by path, so a different folder layout doesn't create duplicates —
   tags, collections, favourites, watch progress and anything you edited by
   hand stay attached. Values the scanner derived from the *old* path (an
   auto-titled item, its performers, its studio) are re-derived from the new
   one. Poster frames and preview clips are rebuilt at the same time.

`scripts/restore.sh` is still there for when the app won't start — it does the
same thing from outside the container, with Postgres up and the app stopped.

A backup only protects you if it leaves the machine — point `BACKUP_DIR` at an
external drive or a synced folder.

## Formats

Scanned: `mp4` `mkv` `avi` `mov` `webm` `m4v` `f4v` `wmv`, and `jpg` `jpeg`
`png` `gif` `webp` `heic`.

Everything scannable gets a poster and a hover preview, because ffmpeg reads
far more than a browser plays. **Playback is direct-play only** — there is no
transcoding. Where a file's container or codec won't play in a browser (an
H.264 MKV, say, or VC-1 in WMV), the detail view says so and names which of the
two is the problem, since a container needs only a fast remux while a codec
needs a full re-encode.

## Status

Built for one person's library and used daily against it. There is no
multi-user support, no transcoding, and no native mobile app — the web app
is laid out for phones instead. The API is stable enough
to build against but not versioned.
