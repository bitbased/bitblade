# BitBlade

A spinning-top battle game built with three.js, TypeScript and Vite. Play in the browser at
**[bitblade.bitbased.net](https://bitblade.bitbased.net)**, install it as an app on a phone (PWA), or run the Electron
desktop build. Local multiplayer works on one screen with keyboards, mice, gamepads and touch. Online play uses
parties on Cloudflare Workers.

## Play

### Modes

| Mode | |
|---|---|
| **Battle** | 1v1 rounds: spin finish 1 pt, Over / Burst 2 pts, Xtreme 3 pts. With 3+ blades it becomes a free-for-all where KOs score |
| **Tag Team** | Two teams, 2v2 up to 4v4. The last team spinning takes the round |
| **Capture the Flag** | Grab the enemy core and bring it home. Hard hits make a carrier drop it |
| **Crystal Rush** | Collect crystals. Smash rivals to make them spill theirs. Item boxes everywhere |
| **King of the Hill** | Score time in the zone. The zone moves |
| **Grand Prix** | Laps on floating sky tracks with boost strips, jumps and items. Split-screen for local racers |
| **Gauntlet** | Solo / co-op: collect gems past arms, saws, bumpers, pits and drone hives |
| **Blade Quest** | Platforming adventure courses with checkpoints, gems and a goal |
| **Pinball** | Your blade is the ball: flippers, plunger, bumpers, slingshots, targets and multiball. With 2+ players it becomes a Pinball Party free-for-all |
| **Random** | A random mode and course every match |

Each round starts with a launch: press **Dash** while the ring is green for full spin. Holding Dash gives overdrive,
which is faster but burns spin.

- **Items:** Turbo, Shield, Shockwave, Spin Surge, Vortex, Titan, Comet (homing), Ice Mine and Power Fist. Players who
  are behind roll better items.
- **Specials:** each blade gets one, picked by its strongest stat: Meteor Rush (attack), Iron Fortress (defense),
  Eternal Vortex (stamina) or Sky Dive (speed).

### Controls

| Device | Move | Dash | Jump | Item | Special |
|---|---|---|---|---|---|
| Keyboard 1 | WASD | Space | F / LShift | E | Q |
| Keyboard 2 | Arrows | Enter | RShift | / | . |
| Mouse | hold LMB to steer to the cursor | RMB | Space | E / wheel | Q |
| Gamepad (any number) | stick / d-pad | A / RT | B / LB | X / RB | Y / LT |
| Touch | left-thumb stick or tilt (gyro) | on-screen buttons | | | |

- **Joining:** press Space, Enter or Ⓐ to join a local lobby. Every input device is its own player.
- **Pausing:** Esc or Start pauses.
- **Pinball flippers:** Shift, Ctrl, Tab / Enter, Z / slash, or LB / RB.

## Make stuff

- **Blade Forge:** wings (count, length, sweep, sharpness), disc, ring, tip, paint, patterns, emblems and decals.
  Stats come from the shape. The blade turns slowly; hold **SPIN** to spin it up with its sound.
- **Course Builder:** lay skate-park tiles (bowl, quarter, half, corner, kicker, spine, funbox, ramp, pit, levels) and
  markers (spawns, items, hazards, flags, zones, flippers, rails). Then Test Ride it.
- **Track Studio:** draw race tracks on a top-down map as a smooth curve, with a height strip for elevation.
- **Music Studio:** chip-tune songs for the menus, tracks and courses: patterns, arrangement, an 8-lane step grid and a
  piano roll. **Generate Song** makes a new one. **Share** gives a link that plays the song; it fits in the URL, with
  no server storage.

Everything you make is saved in the browser.

## Online

All online play happens in a **party**: a private room of one or more players with a 5-letter code.

- **Joining:** friends join with the code or an invite link (`/join/CODE`).
- **Party options:** a party can be kept (same code every time), share control, have a password, and remove or
  block players.
- **The leader** picks the mode, course and CPUs. If the leader leaves, the next member takes over.
- **Quick match** takes your party into a fresh match room with other parties, then brings everyone home. Strangers
  never join your party.
- **Hide offensive words** (on by default) masks other players' names, blade names and song names.

**Netcode:** host-authoritative. The leader's game runs the simulation and sends ~30 Hz snapshots, and members send
their inputs. Traffic goes through a Cloudflare Durable Object relay (`/room/CODE`). When WebRTC is enabled, members
also try a direct peer-to-peer link to the leader (Google STUN, no TURN) and fall back to the relay if it doesn't
open.

**Admin** (`/admin`, password in the `ADMIN_TOKEN` secret) provides:
- usage and estimated cost;
- bans and a whitelist by IP / network or by browser;
- turning online play or quick match off;
- WebRTC off / on / required, set separately for phones;
- closing rooms.

Banned players only ever see "Online play is temporarily unavailable".

## Graphics settings

Settings has bloom, resolution scale and **auto resolution**, which lowers the resolution when frames are slow.

## Develop

Needs [Bun](https://bun.sh) (and Node for Vite).

```sh
bun install
bun run dev          # the game at http://localhost:5173, hot reload
bun run worker:dev   # the production worker locally on :8790 (rooms, queue, admin), which Vite proxies to
bun run typecheck
```

- **What Vite proxies:** `/room`, `/mm`, `/api`, `/admin` and `/health` go to the local worker.
  `DEV_BACKEND=8787` switches to the small Bun relay (`bun run relay`) instead.
- **Local admin password:** set `ADMIN_TOKEN=…` in `worker/.dev.vars`. That file is git-ignored; never commit it.

**Dev tunnel** (optional: serves your local build on a public hostname; edit the name in the script and in
`vite.config.ts` `allowedHosts`):

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
powershell -File scripts/dev-tunnel.ps1   # with `bun run dev` and `bun run worker:dev` running
```

## Self-hosting (Cloudflare)

BitBlade runs on one Cloudflare Worker, which serves the web game and runs the online rooms. The Workers free plan is
enough to start; Durable Objects carry the online traffic.

```sh
bun install
cd worker
bun x wrangler login
bun x wrangler secret put ADMIN_TOKEN    # the /admin password: make up a long one (20+ characters)
cd ..
bun run worker:deploy                    # builds the game and deploys it
```

That's all you need. It goes live at **https://bitblade.&lt;your-account&gt;.workers.dev** with online play working: no
domain, KV or other setup. The web game always uses the server it was loaded from, so nothing in the code points at
someone else's.

**Your own domain, and optional KV:** put them in `worker/deploy.env`. The file is git-ignored, so your settings
stay out of the repo:

```sh
DOMAIN=bitblade.example.com        # its zone must be on the same Cloudflare account
ADMIN_KV_ID=0123456789abcdef...    # optional, from: bun x wrangler kv namespace create ADMIN_KV
```

`bun run worker:deploy` (`scripts/deploy.ts`) then writes `worker/wrangler.deploy.toml` (`wrangler.toml` plus those
values, also git-ignored) and deploys it. Pass wrangler options through, e.g. `bun run worker:deploy --dry-run`.

- **Without KV:** admin settings, bans and the whitelist live in the `Admin` Durable Object. They survive redeploys;
  they're lost only if the worker is deleted or renamed.
- **With KV:** a second copy outlives the worker, and you can read or fix it from the dashboard even if the admin page
  is down.
- **Durable Objects:** `Room` (party relay), `Directory`, `Queue` (quick match), `Admin`.

**Desktop builds** load from files, so they can't use "the site they came from". They connect to `VITE_CLOUD_RELAY`,
baked in at build time from `.env.production` (this project's server). To build a desktop app for your own server,
put `VITE_CLOUD_RELAY=https://your-host` in `.env.production.local`, which is git-ignored and takes precedence. The
desktop app's Settings also has a SERVER URL field (the web game doesn't show it).

## Desktop (Electron)

```sh
bun run electron:dev   # desktop app against the dev server
bun run dist:win       # Windows installer → release/
bun run dist:mac       # macOS dmg (run on a Mac)
```

The desktop app can host on the LAN with its built-in relay (`electron/relay-node.cjs`), or over the internet through
a `cloudflared` quick tunnel.

## Layout

```
src/core      blade data and stats, procedural blade meshes and decals, settings, word filter
src/game      simulation (physics, modes, items), CPU AI, terrain and track heightfields, pinball, hazards,
              renderer, audio and music, song share links
src/input     keyboard, mouse, gamepads, touch, gyro
src/ui        screens: title, menus, lobby and party, online, match and HUD, results, settings,
              Blade Forge, Course Builder, Track Studio, Music Studio
src/net       transports, relay client, rooms (host / client), parties, quick match queue, WebRTC links,
              online status
worker/       Cloudflare Worker: rooms, queue, admin and its page, static assets
server/       Bun relay and matchmaker (an alternative dev backend)
electron/     desktop main process, preload, LAN relay, tunnel
scripts/      dev tunnel, Electron dev runner
```
