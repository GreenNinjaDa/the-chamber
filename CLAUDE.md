# The Chamber

A level-based 3D survival game in the browser, built directly on WebGPU + WGSL with a small custom engine
(no Three.js / Babylon). Modeled on the approach of dgreenheck/tidewater.

## Game design

- Each level is a different, very novel situation the player must survive. There is no fixed rule, but most
  levels start the same way: over-the-shoulder third-person camera (Fortnite-like), WASD movement, inside a
  nondescript Portal-style test chamber with four white panelled walls and no roof.
- The core of the design is **surprise and humour**. Don't explain levels or give instructions up front
  (no theme names, no hint lines during play). Death screens do show a hint for how you died plus the controls
  that matter in that level (`hud.tips`). Any on-screen text is sarcastic or joking, may hint at the mechanics,
  and pop-culture references are welcome.
- **Portals** (`src/entities/portal.ts`): most levels start with `PortalArrival` — a rimless purple liquid portal
  opens above the floor, spits the player out limp at a random 30–90° downward angle (90° = straight down; stunned 1.5 s), then shrinks away 0.5 s
  later — and most end with an `ExitPortal` (rimmed, in the east wall; invisible until
  `openNow()` slides a wall panel aside to reveal it, and its HUD marker is purple). Going through an exit sets the level's status to `'exited'`, and main.ts loads the next level
  immediately (after the last level it goes back to the lobby). Going through a portal squeezes the player: they
  shrink into it over 0.5 s (`player.shrinkInto`, no control and invulnerable meanwhile) and grow back out of the
  entrance portal over 0.5 s (`player.growFrom`), drawn scaled about the portal's centre.
- **Lobby** (`src/levels/lobby/`): the main menu is a chamber you walk around in (after the title screen, and via
  the pause menu). Buttons pick the level the START portal leads to, two more change mouse speed, and a lever
  inverts looking up/down (`src/game/settings.ts`, remembered in localStorage). Signs are floating world text
  (`Level.labels()`). **Pause menu** (`src/game/pauseMenu.ts`): Esc, or losing pointer lock (except by tabbing away in the lobby), opens Resume /
  Restart / Back to the lobby.
  Idle in the lobby for 20 s (alive, no input at all) and it pranks you (`lobby/afk.ts`): a fridge on the head
  (gone after 5 s), a floor/air portal loop that bounces you 3–5 times (any input makes the portals vanish and
  drops you), or rarely a live grenade. The 20 s restart after each prank.
- **Level 1 — Darts** (`src/levels/darts/`): a giant rises over the south wall and blocks the sun. Five
  player-sized darts drop into the chamber and his hand hunts the player. The player survives by luring the
  hand onto darts until he has thrown **all five**; the hand gets faster after every grab. Each grab is a
  hover that tracks the player, then a gradual descent that locks its landing spot halfway down. If it lands
  on nothing, it immediately sweeps sideways along the floor at the player: a dart in its path is grabbed
  instead, otherwise the player is caught. If the giant grabs
  the player instead, they are thrown at the dartboard and must steer mid-flight (WASD) into the bullseye — which
  is a portal to the next level — anything else is a loss. Once all five darts are thrown the exit opens: half the
  time the giant sinks away, half the time he has one last (slower) grab at you while you run for it.
- **Level 2 — Grenade** (`src/levels/grenade/`): ~28 pieces of detailed junk (`src/entities/junk.ts`: fridge, vending machine, piano, safe,
  anvil, bathtub, couch, bookcase, toilet, CRT TV, tires, crates, a rubber duck, a garden gnome...) crashes into the
  chamber, then a pineapple grenade with a blinking 10 s fuse. In direct line of sight (nothing at all between it and
  your chest) a blast is fatal anywhere in the chamber. Behind cover, damage =
  (safeDistance / d) ^ falloff × the average fraction getting through to head/chest/pelvis (walls block completely;
  each object lets through 1 / (1 + mass / 40 kg), so heavier = better cover and light things only help far away); ≥1 kills, ≥0.35 knocks you down. Shrapnel (300 / 450 fragments) flies in straight lines,
  sticks in walls, junk and bodies, shoves what it hits, and kills the player on any hit. A red-rimmed hole (r 0.36 m, centre
  6.75 m up, above carrying reach) in the north wall lets you throw grenades out; throw speeds are tuned so
  neither grenade can be thrown over the 10 m walls from the floor. Survive the first and 1 s later a second
  grenade 1.5× the size arrives:
  behind any single object you only live from 80% of the chamber's diagonal away (closer needs much more weight). Survive that
  and a third, comically huge grenade (5× the first) drops (400 kg, too heavy to pick up); it kills you wherever you are, but the exit
  opens 5 s after it lands, with 5 s left on its fuse.
- **Level 3 — Piece of Cake** (`src/levels/cake/`; meant to become a secret level reached by an easter egg): a
  black forest cake on a pedestal with one slice cut and pulled out (E eats it, with a quip; E again gets refused).
  Companion shapes (`entities/companions.ts`: sphere, cylinder, cone, capsule, wheel — never a cube; ~1 m like the
  real cube, 25 kg) lie around;
  putting one on the floor button (`entities/pressurePlate.ts`) opens the exit.
- Levels can tweak the chamber via `Level.chamber` (`ChamberOptions` in chamber.ts), e.g. a hole in the north wall.

## Commands

- `npm run dev` — dev server at http://127.0.0.1:5189 (hot reload)
- `npm run build` — type-check + static build into `dist/`
- Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`

## Layout

- `src/main.ts` — game loop, title screen (starts by itself after 10 s), pause, the `LEVELS` list (`?level=N` skips the lobby and starts at
  level N), level start/restart and portal progression, dev hook
- `src/engine/` — renderer (primitive meshes, sun shadow map, MSAA, patterns), math (column-major,
  WebGPU clip space z ∈ [0,1]), input
- `src/shaders/*.wgsl` — shaders, imported with `?raw`. Surface patterns (panels, dartboard, blob, skin, sky)
  are ids in `Pattern` (renderer.ts) that must match the constants in scene.wgsl
- `src/engine/physics.ts` — Rapier wrapper: one `Physics` world per level attempt (created in main.ts with the
  chamber colliders), fixed 120 Hz stepping with pre/post-step hooks, dynamic bodies that draw themselves,
  usables, ray casts, collision groups (the player's body parts and capsule are excluded from queries)
- `src/game/` — shared pieces every level uses: chamber, player (Rapier character controller), over-the-shoulder
  camera, HUD (with crosshair), `interaction.ts` (crosshair targeting, E to use, hold left click to carry/drag,
  right-click to throw), pause menu, settings, `body.ts` (11-part rounded player body: skeleton + poses for drawing,
  and `PhysBody`, the active ragdoll that follows the animation with joint motors and per-part pose matching)
- `src/entities/` — things that can appear in more than one level (or the lobby / sandbox), each with its model:
  `junk.ts` (28 pieces of household junk; `spawnJunk(physics, junk('fridge'), pos)`), `grenade.ts` (pineapple
  model), `giant.ts`, `dart.ts`, `portal.ts` (entrance / exit portals), `props.ts` (Lever, Button), `cake.ts`, `companions.ts`,
  `pressurePlate.ts`. Put new
  entities here unless they are truly one-off; level folders keep only the level logic.
- `src/dev/sandbox.ts` — mechanics test room, opened with `?sandbox` (not a game level)
- `src/levels/level.ts` — the `Level` interface; each level gets its own folder under `src/levels/`

## Adding a level

Implement `Level` (update / draw / environment / obstacles / cameraShot), set `status` to `lost` (with `hud.show`)
when the player dies, and `exited` when they go through the exit portal (`won` still works for an end screen).
Start with `new PortalArrival(ctx, spawn)` (update/draw it, and return its `cameraShot()` while it has one) and
put an `ExitPortal` somewhere; its `target()` makes a good `trackedTargets()` entry once open. Levels can take over the camera by returning a
`CameraShot`, and take over the player by changing `player.mode`.

Shared mechanics available to levels (via `ctx`):
- `ctx.physics.addBox / addBall / addCylinder / addCone / addCapsule` — loose objects (`addStaticBox` /
  `addStaticCylinder` for fixed ones). Carried things are held 0.9–1.8 m in front of the
  chest with at most ~95 kg of lifting force (`MAX_CARRY_FORCE` in interaction.ts): light things are carried, a
  120 kg fridge can be tipped upright by one end but only dragged, never lifted clear. Pass `grabbable: false`
  for things the player shouldn't pick up.
- `new Lever(physics, pos, yaw, onToggle)` and `new Button(physics, pos, color, onPress)` for E-usable props;
  implement `Usable` and call `physics.registerUsable(collider, thing)` for custom ones.
- `trackedTargets()` — optional; returns things to flag on screen (pulsing red ring when visible, pulsing edge
  arrow when off screen), e.g. live grenades.
- `player.kill(launchVelocity, { violence?, origin? })` — comic death: the player goes limp as a ragdoll (don't use
  it for Darts). Violent deaths (violence = launch speed by default; ≥18 starts tearing joints, ~40 rips most of
  them) permanently dismember the body; `origin` makes parts nearer it more likely to come off.
  `player.tearApart(violence, origin)` does the same to an existing corpse.
- `player.knock(velocity, stunSeconds)` — shove the player loose; they go limp, tumble, then get back up.
  Hits do this automatically (thresholds at the top of player.ts): the head needs 6 m/s and 40 kg·m/s, the rest
  of the body 1.5× the speed and 5× the momentum. Loose objects count with their mass, walls/bars/scripted
  things as 50 kg, nothing heavier than 50 kg. Only head, chest and pelvis count against non-physics things.
- The player's movement capsule is wider than the body and never pushes things itself: walking pushes loose
  objects by hand (heavier = slower), and flying objects pass through the capsule to hit the real body.
- The upper body aims at the camera: the torso twists toward where you look and looking down bends you over
  (and crouches you when standing still), which physically lowers the head and chest, so ducking behind low
  cover works against anything that checks body parts (e.g. grenade blasts). Tunables: `AIM_*` in player.ts.
- In scripted modes (`held`, `flying`, `stuck`, `splat`) the physical body is switched off and the pose is drawn
  directly; in `control` and `ragdoll` the body is drawn from physics.

## Testing without a visible browser

In dev builds `window.__game` exposes `step(seconds)` (fixed 60 Hz simulation steps, then one render),
`level`, `player` and `camera`. The browser pane throttles animation frames while hidden, so drive
play-tests through `__game.step` from the JS tool, and dispatch `KeyboardEvent`s on `window` for input.

## How to work on this project

- Work in small, verifiable steps. After each feature: run the dev server, open it in the browser pane,
  take a screenshot, and check the console for WebGPU validation errors before calling it done.
- Commit after every working step with a clear message so changes are easy to undo.
- Run `npm run build` before committing; it must pass with no TypeScript errors.
- Performance matters: target 60 fps on an RTX 5060 Ti at 1440p. Avoid per-frame allocations in hot loops.
- Keep features toggleable (settings panel or URL flags like `?noClouds`) so they can be isolated when debugging.
- Only use assets with clear licenses (CC0 / MIT / OFL) and record every one in `CREDITS.md`.
