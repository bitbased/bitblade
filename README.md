# BitBlade

Spinning-top battle game built with three.js, Vite, TypeScript and Electron. You can play it as a desktop app, in the browser, or as a PWA on phones.

## Run it

```sh
bun install
bun run dev            # http://localhost:5173  (browser, hot reload)
bun run relay          # local multiplayer relay on :8787 (vite proxies /room to it)
bun run electron:dev   # desktop app against the dev server
bun run dist:win       # Windows installer → release/BitBlade Setup x.y.z.exe
bun run dist:mac       # macOS dmg (run on a Mac)
```

## Modes

| Mode | |
|---|---|
| Duel (1v1) / Tag Team (2v2) / All For One (FFA) | Round-based. Spin finish 1 pt, Over/Burst 2 pts, Xtreme 3 pts |
| Capture the Flag | Teams steal the enemy core. A hard hit makes the carrier drop it |
| Crystal Rush | Collect crystals. Hits make rivals spill them. Mario-Kart-style item boxes |
| King of the Hill | Hold the zone alone to score. The zone moves |
| Grand Prix (race) | F-Zero-style laps on floating spline tracks with boost strips and jumps |
| Gauntlet (solo/co-op) | Collect gems past automated arms, saws, bumpers, pits and drones |

Each round starts with a launch: press **Dash** while the ring is green for full spin.

Items: Turbo, Shield, Shockwave, Spin Surge, Vortex, Titan, Comet (homing), Ice Mine. Weaker players roll better items.

Each blade has one special, picked by its strongest stat: Meteor Rush (attack), Iron Fortress (defense), Eternal Vortex (stamina) or Sky Dive (speed).

## Controls

| Device | Move | Dash | Jump | Item | Special |
|---|---|---|---|---|---|
| Keyboard 1 | WASD | Space | F / LShift | E | Q |
| Keyboard 2 | Arrows | Enter | RShift | / | . |
| Mouse | hold LMB = steer to cursor | RMB | Space | E / wheel | Q |
| Gamepad (any number) | stick / d-pad | A / RT | B / LB | X / RB | Y / LT |
| Touch | left-thumb joystick or tilt (gyro) | buttons | | | |

To join a local lobby, press Space, Enter or Ⓐ. Esc or Start pauses.

## Physics

Every arena is a heightfield. That includes stadium bowls, skate-park tiles and race ribbons.

- **Movement:** blades move ballistically in 3D, with contact constraints against the surface normal. They leave the ground when the terrain falls away faster than gravity pulls them, so lips, kickers and gaps give real air.
- **Spin:** tip friction plus gyroscopic tilt causes drift. Low spin adds wobble. Walls are ridden in the blade's spin direction (a rail dash).
- **Collisions:** impulse-based with contact-surface slip. Same-spin hits clash hard and both blades lose spin. Opposite-spin hits steal spin.
- **Burst:** a burst meter builds from big hits.
- **Effects:** trails, a predicted landing arc and landing marker while airborne, sparks, shockwaves and bloom.

## Editors

- **Blade Forge:** shape (wings, sweep, sharpness, tilt), disc, tip, paint, patterns, SVG emblems and decals. Click the blade face to stamp a decal. Stats come from the geometry.
- **Course Builder:** place skate-pool tiles (bowl, quarter, half, corner, kicker, spine, funbox, ramp, pit, levels) and markers (spawns, items, hazards, flags, zones). Then Test Ride.

## Multiplayer

Netcode is host-authoritative. The host runs the sim and sends 30 Hz snapshots (~2 KB each). Clients send input.

The game only talks to `HostTransport` / `ClientTransport` (`src/net/transport.ts`). Current implementations all use one relay protocol (`/room/<CODE>`):

| Where | Relay |
|---|---|
| Electron host, LAN | `electron/relay-node.cjs` (ports 47800+) |
| Electron host, public link | same + `cloudflared` quick tunnel (`*.trycloudflare.com`) |
| Dev / browser | `server/relay-bun.ts`, proxied by vite at `/room` |
| Production | Cloudflare Worker + Durable Object (`worker/`), which also serves the web build at bitblade.bitbased.net |

**Steam (later):** add a `SteamTransport` using steamworks.js in Electron (lobbies + Networking Sockets) that implements the same two interfaces. Game code stays unchanged.

To join, enter a 5-letter code or an invite link (`https://…/join/CODE`).

### Deploy

```sh
cd worker && bun x wrangler login && cd ..
bun run worker:deploy        # builds dist/ and deploys to bitblade.bitbased.net
```

### Dev tunnel (live local build at bitblade-dev.bitbased.net)

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
powershell -File scripts/dev-tunnel.ps1   # with `bun run dev` + `bun run relay` running
```

## Layout

```
src/core      blade data/stats, procedural blade meshes + decals, settings
src/game      sim (physics, modes, items), ai, terrain/track heightfields, hazards, renderer, audio
src/input     keyboard/mouse/gamepad/touch/gyro
src/ui        screens: title, menu, modes, lobby, match/HUD, results, online, settings, designers, SVG icons
src/net       relay client, transports, Electron bridge
electron/     main process, preload, embedded relay, tunnel
server/       Bun relay (dev)
worker/       Cloudflare Worker + Durable Object relay + static assets
```
