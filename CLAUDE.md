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
  `openNow()` slides a wall panel aside to reveal it (`closeNow()` shuts it again), and its HUD marker is purple). Going through an exit sets the level's status to `'exited'`, and main.ts loads the next level
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
  black forest cake of eight slices on a pedestal. One is already cut and pulled out and must be eaten first; then
  E eats any slice. Each one fattens the torso (`player.girth`) and takes 10% off speed and acceleration
  (`player.speedScale`), this life only, and the quips get more worried; the 7th brings a stern warning and the 8th
  kills you (torn apart). Walking into the exit without eating a slice gets you flung back out, dead
  (`ExitPortal.refuse`).
  Companion shapes (`entities/companions.ts`: sphere, cylinder, cone, capsule, wheel — never a cube; ~1 m like the
  real cube, 25 kg) lie around;
  the exit is open only while one (or the player) is on the floor button (`entities/pressurePlate.ts`); take it off and the
  panel slides shut again.
- **Level 4 — Useless Box** (`src/levels/lava/`): a roofed chamber full of rising lava (the only light). You
  arrive on a small ledge by the exit (east wall, 3 m up); 10 rock pillars snake through the pit to a ledge in the
  far corner with a big useless box (`entities/uselessBox.ts`, 1.8x). Its lever is a physics handle on a hinge:
  grab it (hold left click) and push it back to switch it on, which opens the exit. It then locks; after a delay
  the box opens its lid, reaches out and shoves it back off. The delay is 1 s, then 2 s, 3 s... but each flip has
  a 50% chance of only 0.2 s. Hazards: a wrecking ball swings across the long jump between the 4th and 5th rocks
  (a hit to the head or chest knocks you into the lava), and the 3rd rock from the end sinks 1.8 m and back over
  10 s, carrying you. Lava death is a plain collapse.
- **Level 5 — Raiders of the Lost Chamber** (`src/levels/temple/`, work in progress): its own map, no test chamber. A
  dark stone tunnel (about 165 m from the spawn to the dead end) lit by a torch in the player's hand. A boulder drops from a deep ceiling shaft between the player
  and the exit portal and chases them (rubber-banded: sprinting stays ahead, walking gets caught) over spiked floor
  pits (8 in the floor, 9 in the ceiling plus the shaft, edges at slight random angles; the 8 m ones, too far
  to sprint-jump, have vines), past spikes (rows across the floor, full rows kept short and at least 5 m from any pit;
  ~50 out of the walls at all heights; random singles; none within 8.5 m of the spawn; not solid, touching one knocks you loose for 0.01 s, then you recover) and ~84 loose rocks of mixed shapes (70-140 kg: pushed slowly, not kicked; they fall when
  gravity flips; debris, so boulders roll straight through them).
  A stone pressure plate near the end (3 x 2.25 m, sticking up 0.28 m; the boulder keeps coming) sinks the end wall 1 s later to
  reveal a second boulder; the world freezes as soon as the first boulder is within 1 m of the plate or 2 s have passed (`Level.freezeWorld`) while only the camera turns upside down (`camera.turnTarget`), and 0.5 s after
  it settles gravity snaps over: everything, the player included (stunned 0.1 s, then immune to knocks for 1 s so landing head first doesn't
  stun them again), falls to the ceiling.
  The map never moves. The way back has the ceiling's own pits
  and spikes; the new boulder chases (starting slowly: 60% of its speed, up to full over 5 s, about a second of pace
  lost), the first rolls off from rest and drops into its shaft (12 m deep, so both
  boulders fit with room to spare), crossed on a second vine to the portal. Vines are physical ropes: hold E or left
  mouse near one to hang on at that length (`player.hanging` for the pose); let go to fly on; each snaps after one
  use. Boulders kill on contact with a small push. Boulders go 60% see-through with the camera inside them, and so
  does the player from when the first boulder starts rolling until 5 m before the last jump (over the shaft), when the
  torch goes out and they fade back in over 2 s. The map is one fixed body (not kinematic: Rapier's character
  controller won't climb slopes on kinematic colliders).
- **Level 6 — Simon Says** (`src/levels/simon/`): the floor is the 1978 Simon toy (four coloured quarter-disc
  pads round a hub with a button, and a big rubber duck); screens on all four walls give orders, with a timer bar. Do
  what Simon says (jump, stand on a colour, look up, touch your toes, freeze, press the button, spin, pick up and throw
  the duck...) in time, and never what he didn't (plain orders, "SIMEON SAYS", "SIMON SAID", "AGAIN."). Any mistake
  and the floor panel under you is a catapult. It ends with Simon's memory game (step on the pads in the order they
  lit, twice), then "LEAVE." (the exit refuses you, fatally) before "SIMON SAYS: LEAVE."
- **Level 7 — Magnifying Glass** (`src/levels/sunburn/`): the giant is back, with a magnifying glass, and you're the
  ant. A day passes in ~80 s: the sun (`Environment.sunDir`, light colours) rises in the east, lingers overhead and
  sets in the west, so the shade moves: along the east wall in the morning, nothing but umbrellas at noon, the west
  wall in the afternoon. The burning spot is a real ray down the sun's direction from the lens to his aim point: it
  lands on the first thing in its way (smoke), and 1 s of it on your body sets you on fire (`player.char`). He
  chases where you're heading (faster than a sprint at noon, but turning sluggishly: dodge it), and while you hide he
  burns things out in the sun (the duck melts, the beach ball pops, umbrellas, boxes and the mattress burn away) or
  lurks at the edge of your shade. At dusk his mum calls him in for dinner and the exit opens.
- **Level 8 — Minesweeper** (`src/levels/mines/`): the floor is a 12 x 12 board of raised Windows 95 tiles (2 m,
  28 mines) and the exit is open on the far (east) side. Stepping on a tile reveals it (zeros ripple open) or blows
  you up; the numbers count touching mines, diagonals included. Right-click (empty-handed) or E plants a flag. The
  smiley face on the north wall reacts, with the mine counter and clock either side. Boards are regenerated until a
  simple logical solver (single-tile rules plus the subset rule) can get from the safe opening to the exit tile.
- **Level 6 — Red Light, Green Light** (`src/levels/redLight/`): a 7 m doll (`entities/doll.ts`) stands by the east
  wall at (9.5, -5), back to the room, chanting MUGUNGHWA... KKOCHI... PIEOTSSEUMNIDA! word by word over her head at
  varying tempos (green lights of 3.2 s, getting shorter; one fake-out where her head starts to turn and doesn't).
  Then her head whips round 180° (0.5 s, down to 0.35 s later), her eyes glow red and the room goes slightly red:
  moving (actual displacement over 0.3 m/s, or jumping) from 0.45 s after the turn (+0.5 s / +0.2 s in the first two
  red lights; stopping from a sprint takes ~0.42 s) while she has clear rays from her eyes to two of your head, chest
  and pelvis (`SEEN_PARTS`) gets you lasered (two red beams) and flung, violence 22. Moving right behind something tall
  (fridge, vending machine, bookcase, the stacked crates; the piano and couch are too low from 6 m up) is safe. You arrive at (-9.5, 0) facing east; cross the
  red tape at x = 7 and the exit (z = 5) opens while her head does a slow 360. A 60 s clock on the north wall: at 0
  she lasers everyone still short of the line. Six scripted contestants in green tracksuits (`entities/contestant.ts`,
  the player's body via `drawBody` colours, numbers floating overhead) run on green and freeze on red; 324 keeps
  running into the first red light, 101 wobbles and steps (3rd), 212 panics and runs back (4th), 218 sneezes (5th),
  067 makes it and cheers, and old 001 shuffles, stops bothering to freeze from the 5th red light and is never shot.
- **Level 6 — Laser Show** (`src/levels/lasers/`; Fall Guys' Jump Club meets the Resident Evil laser hallway): the
  lights go down (dark red) and an emitter pylon (`entities/laser.ts`, `LaserPylon`) rises out of a floor hatch.
  A low beam (0.35 m) grows out opposite the player and sweeps round, speeding up from 5 s to 2.5 s a turn: jump it.
  Then a mast rises and a high beam (1.6 m) joins, turning the other way at a different speed: duck it (stand still and
  look down; a full duck tops out at 1.43 m, standing reaches 1.9 m, walking or half-looking down still gets hit).
  Where the two cross you can't do both, so move. Then three laser walls (grids to ~3.9 m) sweep across from the side
  further from you, each with a 2–2.4 m full-height gap you can walk to in time (the last one faster, with a low beam in
  the gap to jump, and its gap in the west half); then the exit opens and a gapless grid comes from the west wall at
  4.2 m/s. Any beam touching a body part (`BodySlicer`: the real part frames as slightly shrunk capsules/boxes, swept
  in 4 cm steps so fast beams can't skip a limb) slices you: `player.kill` with violence 30 (42 for the grid) at the
  cut. One red point light rides with the pylon, then with each wall. `?laserSkip=N` starts the show N s in.
- **Level 6 — Gnome Alone** (`src/levels/gnomes/`): Weeping Angels, but garden gnomes (`entities/gnome.ts`, 0.95 m,
  8 kg, posable arms). A 20 m loading bar on the north wall fills only while you watch it (its centre within 20° of
  the view, unblocked; 37 s of watching in all) with a joke script: stuck at 99%, then "INSTALLING UPDATE 1 OF 2"
  drains it to 0 and it refills faster; at 100% the exit opens. Gnomes move only while unseen (camera frustum plus a
  small margin, and a ray to their top/middle/bottom): they glide at you (1.1 → 1.9 m/s as the bar fills), upright
  and facing you, and change pose (innocent far away, grabby up close) only while nobody looks. 2 start by the south
  wall; 8 more appear out of sight as the bar fills (max 10). Carried gnomes are harmless; thrown ones tumble 1.5 s.
  Every 10–15 s (first after 18 s) the lights flicker (2 s of dips as a warning) and then go out 2–3 times over
  0.8 s: in the dark every gnome moves at 3× and their eyes glow red. An unwatched gnome within 0.75 m kills you:
  lights out 1.2 s, then you lie dead in a pointy red hat inside a ring of (at least 7) gnomes.
- **Frogger** (`src/levels/frogger/`): why did the test subject cross the road? Everything but the river is a raised
  deck (0.6 m): the sidewalk you land on (west), four 2.8 m road lanes (forklifts and a steamroller, golf carts and a
  runaway office chair, giant robot vacuums, sports cars; `entities/vehicles.ts`), a grass median, then four lanes of
  toxic goo (`Pattern.lava` with `param` 1) crossed on floating junk (mattresses, doors, giant rubber ducks, a
  bathtub, pallets) to the far bank and the open exit. Everything loops through tunnel mouths in the north and south
  walls, rafts included, which don't stop for you (`player.platformVel` carries you). Cars, carts, forklifts and the
  steamroller kill (ROADKILL, PANCAKED); vacuums and chairs just knock you over (jump them); the goo dissolves you.
  The strip along each lane line is clear of everything but the steamroller.
- **Level 6 — Snake** (`src/levels/snake/`): you are the apple. After the arrival the floor boots up row by row
  into an old phone LCD (pale olive, 16 x 16 grid of 1.5 m cells), "NOKLA — Connecting people." appears on the north
  wall, a panel there slides open and the phone-game snake (`entities/snake.ts`) comes out: dark pixel blocks 1.35 m
  wide and 1.6 m tall (too tall to jump), each a static collider moved one cell per step (60 ms slide), head with
  cube eyes (pupils follow its target) and a flicking forked tongue. Starts 5 long at 0.32 s/step, speeds up to
  0.2 s over 80 s (always slower than sprinting), grows one block every 7 steps. AI: greedy toward the target cell
  (Manhattan, prefers straight on; you with a 0.25 s lead, or the apple if that's nearer), never reverses, never steps
  into a wall or itself (the leaving tail cell is free), 10% blunders; it looks ahead for dead ends (time-aware flood
  fill, pockets under 10 cells) always for its first 20 s, then 70% of steps, but only 10% with its target within
  4 cells (tunnel vision: lure it close to make it coil; test bots circling it at ~5 m crash it about half the time,
  after ~30-45 s). No safe move = crash: lurch, the classic blink, blocks pop away from the head in pixel crumbs,
  pixel-block "GAME OVER" (`entities/pixelText.ts`) plus a quip on the north wall, exit opens. An apple
  (`entities/apple.ts`, 1 kg, carry / throw it as a decoy; `?noApple` leaves it out) pops up on a free cell; eaten = +3 blocks, a new one 3 s
  later. Caught (it enters your cell, you're right in front of its mouth, or its head pushes into you) = swallowed
  whole (shrink into its mouth, gulp, +3 blocks, a bulge runs down to the tail), then GAME OVER with the snake's
  length as SCORE. The score also shows in pixel digits on the north wall.
- Levels can tweak the chamber via `Level.chamber` (`ChamberOptions` in chamber.ts), e.g. a hole in the north wall,
  `litFromBelow` (the floor casts no shadows), or `none` (no chamber at all: the level builds its own map, and should
  set `camera.confine = false` so the camera isn't kept inside the chamber, and `camera.bounds` to keep it inside its own). `Environment.pointLight` adds one
  unshadowed point light (a torch). `Environment.lightFromBelow` (renderer.ts) turns the sun into a
  glowing surface at that height: it lights like a plane below (down-facing surfaces fully, walls half), fades
  with height above it, and casts very soft shadows.

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
  (and portal, lava) are ids in `Pattern` (renderer.ts) that must match the constants in scene.wgsl
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
  `pressurePlate.ts` (round button, or `{ stone: [w, d] }` for a rock slab), `uselessBox.ts`, `rock.ts` (textured stone: `boulderModel`, `chunkModel`, `slabModel`, `shardModel`, `clusterModel`; `Pattern.rock`),
  `doll.ts` (the giant doll with a swivelling head and glowing eyes, plus a `BareTree`), `contestant.ts` (scripted
  NPC in a tracksuit: walk/run, freeze, wobble/sneeze/cheer, dramatic death fall; `drawBody` takes a `BodyColors`
  to dress the player's body as someone else), `vehicles.ts` (forklift, golf cart, robot vacuum, office chair, steamroller, sports car, and door / pallet rafts),
  `laser.ts` (`drawBeam` / `drawBeamDot` / `drawFloorGlow`,
  `BodySlicer` to test beams against the player's body parts, `LaserPylon`), `gnome.ts` (big garden gnome:
  `spawnGnome(physics, feet, look)`, arm poses in `GNOME_POSES`, glowing eyes, and `drawGnomeHat(out, headFrame)` for
  anyone else's head), `snake.ts` (grid snake: movement, AI, colliders, model), `pixelText.ts` (5x7
  dot-matrix text built from blocks), `apple.ts`. Put new
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
- `player.stunImmunity` (seconds) — nothing knocks the player loose meanwhile (bumps or `knock`).
- `player.knock(velocity, stunSeconds)` — shove the player loose; they go limp, tumble, then get back up.
  Hits do this automatically (thresholds at the top of player.ts): the head needs 6 m/s and 40 kg·m/s, the rest
  of the body 1.5× the speed and 5× the momentum. Loose objects count with their mass, walls/bars/scripted
  things as 50 kg, nothing heavier than 50 kg. Only head, chest and pelvis count against non-physics things.
- Jumps are buffered: pressing Space up to 0.1 s before the player can jump (`JUMP_BUFFER` in player.ts) jumps as soon
  as they can.
- The player's movement capsule is wider than the body and never pushes things itself: walking pushes loose
  objects by hand (heavier = slower), and flying objects pass through the capsule to hit the real body.
- The upper body aims at the camera: the torso twists toward where you look and looking down bends you over
  (and crouches you when standing still), which physically lowers the head and chest, so ducking behind low
  cover works against anything that checks body parts (e.g. grenade blasts). Tunables: `AIM_*` in player.ts.
- `player.setGravity(rotation)` turns the player's gravity (from their frame, up = +y, to the world): movement,
  jumping, the capsule, the ragdoll's pose and the camera's up all follow; they pivot about their middle. Turn the
  physics world's gravity to match with `physics.setGravityDirection(down)`. `player.up` is their current up.
- `DrawItem.opacity` (0-1) and `player.opacity` draw things see-through (alpha-to-coverage screen-door, still
  casting shadows).
- `player.char` (0-1) draws the player burnt to a crisp (this life only).
- `player.platformVel` — the velocity of whatever the player stands on (a raft, a conveyor), added to their movement;
  levels set it every frame.
- `player.torchArm` raises the right arm up and ahead as if holding a torch (the level draws the torch).
- `player.resume(velocity)` puts the player back in normal control after a scripted mode; `player.partFrames()`
  gives each body part's frame (e.g. to put a torch in the right hand, `foreArmR`).
- Boulders use `GROUPS_BOULDER`, and invisible `GROUPS_BOULDER_BRIDGE` colliders are floors only boulders touch
  (so they roll over pits the player has to jump). Loose objects on `GROUPS_DEBRIS` behave normally but boulders
  pass through them.
- In scripted modes (`held`, `flying`, `stuck`, `splat`, `swinging`) the physical body is switched off and the pose is drawn
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
