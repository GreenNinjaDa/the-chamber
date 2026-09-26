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
  the pause menu). Numbered buttons on the north wall (`WallButton`) pick the level the START portal leads to (press one; gold-rimmed ones are levels
  you have got out of, `settings.beaten`, with a tally on the wall), and in the
  south-west corner two buttons change mouse speed and levers invert looking up/down and turn sound off
  (`src/game/settings.ts`, remembered in localStorage). Signs are floating world text
  (`Level.labels()`). **Pause menu** (`src/game/pauseMenu.ts`): Esc, or losing pointer lock (except by tabbing away in the lobby), opens Resume /
  Restart / Skip to the next chamber (or N while paused; doesn't count as beaten) / Back to the lobby.
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
- **Level 6 — Big Red Button** (`src/levels/button/`): a big red button on a pedestal, DO NOT PRESS. The level is doing nothing
  for 45 s while it escalates: the sign pleads (PLEASE DO NOT PRESS, IT'S JUST A BUTTON...), the button hums and
  whispers ("psst", "no one will know"), follows you from 22 s, four more rise out of the floor at 30 s and follow too,
  and at 37 s three DO NOT STEP plates come up across the way to the exit (jump them). At 45 s the exit opens under a
  PRESS E TO ENTER sign (pressing E near it is also fatal). Pressing any button or stepping on a plate brings a random
  fate: an anvil or a piano from the sky, a boxing glove from the nearest wall, the trapdoor, or the self-destruct.
- **Level 7 — Minesweeper** (`src/levels/mines/`): the floor is a 12 x 12 board of raised Windows 95 tiles (2 m,
  28 mines) and the exit is open on the far (east) side. Stepping on a tile reveals it (zeros ripple open) or blows
  you up; the numbers count touching mines, diagonals included. Right-click (empty-handed) or E plants a flag. The
  smiley face on the north wall reacts, with the mine counter and clock either side. Boards are regenerated until a
  simple logical solver (single-tile rules plus the subset rule) can get from the safe opening to the exit tile.
- **Level 8 — Gnome Alone** (`src/levels/gnomes/`): Weeping Angels, but garden gnomes (`entities/gnome.ts`, 0.95 m,
  8 kg, posable arms). A 20 m loading bar on the north wall fills only while you watch it (its centre within 20° of
  the view, unblocked; 37 s of watching in all) with a joke script: stuck at 99%, then "INSTALLING UPDATE 1 OF 2"
  drains it to 0 and it refills faster; at 100% the exit opens. Gnomes move only while unseen (camera frustum plus a
  small margin, and a ray to their top/middle/bottom): they glide at you (1.1 → 1.9 m/s as the bar fills), upright
  and facing you, and change pose (innocent far away, grabby up close) only while nobody looks. 2 start by the south
  wall; 8 more appear out of sight as the bar fills (max 10). Carried gnomes are harmless; thrown ones tumble 1.5 s.
  Every 10–15 s (first after 18 s) the lights flicker (2 s of dips as a warning) and then go out 2–3 times over
  0.8 s: in the dark every gnome moves at 3× and their eyes glow red. An unwatched gnome within 0.75 m kills you:
  lights out 1.2 s, then you lie dead in a pointy red hat inside a ring of (at least 7) gnomes.
- **Level 9 — Dodgeball** (`src/levels/dodgeball/`): four sentry turrets (`entities/turret.ts`: white egg on a tripod, one red
  eye, 22 kg physics bodies you can also pick up) wake one after another ("Hello?"), paint you with a red laser when
  they can see you, and after a 0.9 s charge fire a red rubber dodgeball at where you're going. Three hits (tested
  along each ball's path) and you're out through a trapdoor. Balls pile up everywhere: carry one, aim, right-click
  to throw it back; a fast ball hitting a turret knocks it over (with a helping shove), and tipped past ~50° it's
  down for good ("I don't blame you."). All four down: the exit opens.
- **Level 10 — Whack-a-Mole** (`src/levels/moles/`; deck and burrow in `cabinet.ts`, the backboard in `scoreboard.ts`):
  you're the mole. You land on what looks like the usual floor; it boots up band by band into the top of an arcade
  cabinet (a blue deck 3 m up, wall to wall, fixed colliders, a 4 x 3 grid of yellow-ringed holes, chasing bulbs, the
  WHACK-A-MOLE! backboard on the north wall with Timmy's SCORE, a TIME and a message line, two giant mascot moles), the
  lids iris open and the hole under you drops you (after a cartoon hang) into the burrow: dirt, roots, pit props,
  glowing mushrooms, a lantern glow round you (`pointLight`; darker ambient while the camera is down there), sunlight
  through the holes, and four other moles (`entities/mole.ts`) who waddle along the grid lines between piston pads under
  the holes and pop up (crouching first). Timmy (the giant) rises over the south wall with a huge rubber mallet
  (`entities/mallet.ts`; a raked handle keeps his hand well above the deck). Space under a hole pops you up (scripted:
  `player.mode = 'swinging'` with a `poseOverride`; the view cuts to a pulled-back one facing Timmy), hold it to stay up,
  let go to duck (the burrow view comes back). E or a click grabs the carrot lying by the hole (0.6 s up grabs it
  anyway); carrot holes glow orange on their pads and dangle leaves into the hole. The mallet goes for the newest
  pop-up (you or a mole) after a reaction, travels over, winds up (a red ring round the hole, its pad and the hole's
  underside flash red, a red marker on the head while you're up) and BONKs: moles are flattened and fall back down
  dazed with stars; you're a spread-eagled pancake with stars that then slips down the hole (WHACKED / BONK! /
  FLATTENED). With nothing up it hovers over the carrot holes; once a carrot has gone, a pop at a carrot hole is its
  prime target (it turns round mid-travel for you, never once it's winding up); up 2 s (1 s later) and you're the target
  whatever else pops. Everything speeds up with carrots, rounds and score, and the moles get jumpier (fewer decoys).
  40 s rounds: GAME OVER, "MOM! MORE QUARTERS!", a 3 s breather, ROUND 2. Five carrots: TILT (all the bulbs flash),
  "MOOOM! THE MOLE CHEATED!", a six-slam tantrum, he sinks away sulking, and the exit opens in the burrow's east wall by
  your carrot pile. `?moleCarrots=N` starts with N carrots. Test bots: popping blind and grabbing with E 0.3 s later
  wins about 2/3 of the time (deaths on the last carrots); waiting for a wind-up on a mole first wins every time (~35 s).
- **Level 11 — The Pool** (`src/levels/pool/`; The Sims' pool-ladder prank): its own room (`none`: the walls, and a
  deck round an 18 x 16 pool, 4.2 m deep, the water 1.7 m under the deck). Once the Sim is up after the arrival a
  green plumbob pops over their head ("Sul sul!"), a needs panel lights up on the north wall (ENERGY, FUN "Very high",
  HYGIENE, SOCIAL "The cursor is your friend", BLADDER "Don't. Just don't."), and the camera swings up into a
  build-mode view while a giant white cursor glove (`entities/sims.ts`) clicks and drags a blue rectangle (size and
  §price) over the floor. On release the middle of the floor sinks into a tiled pool (lane lines, caustics,
  see-through water) with everything on it (crates, a small crate, a pallet, an air mattress, a ring, noodles, a
  beach ball, a duck; loungers and parasols pop up on the deck); anyone on the deck is picked up by the scruff and
  dropped in. Swimming (`player.gravityScale` 0 and a float spring, 42% speed, a paddle / treading pose): Space hops,
  or hauls you up onto anything floating whose top is within 0.9 m of the water (`player.mode = 'swinging'` for
  0.5 s), onto the highest one in reach. The cursor places a ladder (purple marker) a swim away and deletes it
  when you get within 3.8 m (or after 9 s): "+§50", "Nooboo!", a thought bubble of a crossed-out ladder. Then it
  drops in a fridge (sinks) and a couch (floats, with a seat and back to stand on), and circles overhead. ENERGY
  drains only in the water (55 s, 1.8x sprinting; the plumbob goes yellow then red, strokes slow, the head dips; at
  42% the cursor goes and taps the gauge: "Hm. Still going down."): at 0 the Sim
  drowns (sinks slowly, bubbles), the lights go down, the Grim Reaper floats in with his scythe and clipboard ("*scribble
  scribble*", "Drowned. Classic.") and it's SIM DIED. Way out: a crate (or the couch) pushed against the side and
  jumped from (a pallet or the air mattress alone is too low; a crate on the pallet works in two jumps). Out on
  the deck, the cursor flies to the exit, "DELETE DOOR?", hesitates... "...nah." and the exit opens.
- **Level 12 — Jenga** (`src/levels/jenga/`): you land on a square of wood in the floor: the top of a giant Jenga tower
  (`entities/jenga.ts`: 10 layers of three 4.5 x 0.8 x 1.5 m wood-grain blocks, alternating, base at (4, -4)) that
  rises out of it to 8 m (invisible walls keep you on while it rises; `player.carry` brings you and your body along).
  Timmy leans in over the south wall; Lean-o-meters pop up on the north and south walls (a top-down dial, up = away from
  you, a dot for the lean, green / amber / red). Nine pulls (~6.5 s each, a bit quicker later): he picks a block from
  the lower layers (never the top three, never leaving a layer on one side block; a random pick nudged toward tipping
  it your way and further over, capped so the lean with nobody on it stays under 55% of the limit at first, +10% per
  pull), it glows and gets tapped (his arm goes see-through, `giant.armOpacity`, since it's as wide as the tower; the
  meters blink a ring where the lean is heading), slides out with dust, and he stacks it on top Jenga-style, usually in
  the strip you're standing in: a red shadow while it hovers 3 m up (~3 s from lifting), then it drops. Under it:
  flattened across the slot, head sticking out (SQUASHED); next to it: shoved. The tower isn't simulated block by block:
  it has a lean (`phi`, the top's tilt) that springs (damped, amplified by 1 / (1 - gamma) as blocks go missing and
  layers are added) toward the lean the missing blocks cause (toward the side missing support) plus your weight (your
  offset from the axis) plus jolts (pulls, landings, your jumps), and bends most at the damaged layers; past 8° it
  topples for real (every block becomes a physics box: JENGA! / TIMBER!). Standing on it slides you downhill past
  2.3°, the camera's horizon tilts with it, and it creaks more and louder. Walking off (2.2 m below the top) is a SPLAT.
  After the ninth, "THIS GAME IS BORING.": a ledge slides out of the east wall by the tower's south-east corner
  (purple marker), he pushes the tower over eastward ("TIMBER!!!", tipping about its bottom east edge, carrying you),
  and 4.5 s in it hits the wall and comes apart, which knocks the exit open behind the ledge. Jump for the ledge
  before that (a walking jump from the top reaches it; the tip brings the top closer); still on top = TIMBER.
  Test bots (~74 s): balancing from the bias (with or without the prediction, even a lazy 0.7 s-late one) always
  won; standing in the middle and only dodging the blocks toppled after 3-6 pulls. `?jengaSkip=N` does N (tidy) pulls
  before you arrive (9: straight to the finale).
- **Level 13 — Laser Show** (`src/levels/lasers/`; Fall Guys' Jump Club meets the Resident Evil laser hallway): the
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
  WebGPU clip space z ∈ [0,1]), input, audio (procedural WebAudio: `sfx.*` one-shots, `tone`, `noise`, looping `Tune`s; no
  sound files. Starts on the first click; `?mute` or the lobby's sound lever turn it off)
- `src/shaders/*.wgsl` — shaders, imported with `?raw`. Surface patterns (panels, dartboard, blob, skin, sky)
  (and portal, lava) are ids in `Pattern` (renderer.ts) that must match the constants in scene.wgsl
- `src/engine/physics.ts` — Rapier wrapper: one `Physics` world per level attempt (created in main.ts with the
  chamber colliders), fixed 120 Hz stepping with pre/post-step hooks, dynamic bodies that draw themselves,
  usables, ray casts, collision groups (the player's body parts and capsule are excluded from queries)
- `src/game/` — shared pieces every level uses: chamber, player (Rapier character controller), over-the-shoulder
  camera, HUD (with crosshair), `interaction.ts` (crosshair targeting; E, left click and right click are one action button
  (`input.actionPressed` / `actionDown`, which levels use too): press to use, hold to carry/drag, press another to throw), pause menu, settings, `body.ts` (11-part rounded player body: skeleton + poses for drawing,
  and `PhysBody`, the active ragdoll that follows the animation with joint motors and per-part pose matching)
- `src/entities/` — things that can appear in more than one level (or the lobby / sandbox), each with its model:
  `junk.ts` (28 pieces of household junk; `spawnJunk(physics, junk('fridge'), pos)`), `grenade.ts` (pineapple
  model), `giant.ts` (`blindfold` adds a blindfold and a party hat; `armOpacity` draws the reaching arm see-through), `dart.ts`, `portal.ts` (entrance / exit portals), `props.ts` (Lever, Button, `WallButton`: a square button on a wall with a raised pixel label, `lit` / `rim`), `cake.ts`, `companions.ts`,
  `pressurePlate.ts` (round button, or `{ stone: [w, d] }` for a rock slab), `uselessBox.ts`, `rock.ts` (textured stone: `boulderModel`, `chunkModel`, `slabModel`, `shardModel`, `clusterModel`; `Pattern.rock`),
  `turret.ts` (`drawTurret`: the sentry turret model), `trapdoor.ts` (`drawTrapdoor`: the floor panel that snaps up like a catapult), `laser.ts` (`drawBeam` / `drawBeamDot` / `drawFloorGlow`,
  `BodySlicer` to test beams against the player's body parts, `LaserPylon`), `gnome.ts` (big garden gnome:
  `spawnGnome(physics, feet, look)`, arm poses in `GNOME_POSES`, glowing eyes, and `drawGnomeHat(out, headFrame)` for
  anyone else's head), `pixelText.ts` (5x7
  dot-matrix text built from blocks, letters, digits and `! ? : . , -`; `pattern: Pattern.emissive` makes glowing LEDs;
  `textBitmap(text)` gives the glyph rows for other pixel renderers), `pinball.ts` (`TableFrame`: a sloped table surface to build on (`y(z)`, `point`, `frame`, `quat`, `addBox`);
  `Flipper` (kinematic, swings about the table normal; `step(h)` from a physics substep hook, `relative` for hits),
  `PopBumper`, `Slingshot`, `DropTarget` (letter on its face, sinks when `drop()`ped), `spawnSteelBall`, `drawPlunger`,
  `drawStar` / `drawChevron` / `triangleModel` (any triangle from the 'wedge' mesh), `DotMatrix` (orange pixel-text
  display), `pinSfx` (bumper chimes, flipper, knocker, jackpot, tilt...)),
  `pool.ts` (`Water`: a rectangle of water that floats loose objects from sample points: buoyancy `capacity` in kg,
  drag, bobbing damped near critical, optional `righting`; `setLoad` for someone standing on a float, `splashes` to
  show; pool toys `spawnPoolFloat` (ring, noodle, air mattress, pallet), `spawnFloatingCouch`, `drawPoolLadder`,
  `drawLounger`, `drawParasol`), `sims.ts` (The Sims: `drawPlumbob` in a mood colour, `CursorHand` (the giant
  build-mode glove: `flyTo`, `follow`, `pinch`), `drawBubble` (camera-facing speech / thought bubble; the text is
  a world label), `NeedsPanel`, `drawGrimReaper`),
  `mole.ts` (whack-a-mole `Mole`: pink nose, whiskers, buck teeth, optional shades; `squash` flattens it, `dazed` gives
  X eyes and circling stars, `armsUp`, `walk` / `walking`, `wiggle`; `drawMole` in any frame, `drawDazedStars` over
  anyone's head), `mallet.ts` (`Mallet`: a giant's rubber mallet posed by `aim` / `swing` / `lift` / `from`; `grip()` is
  where the giant's hand goes, `face()` the striking face, `squash` on impact), `jenga.ts` (`JengaTower`: layers of
  three blocks as fixed colliders moved with a scripted lean `phi` that springs toward `target()` (`bias()` from missing
  and stacked blocks plus an outside `load`, amplified by `gamma()`), `kick` for jolts, `tip` to push it over about its
  bottom east edge, `frames` per layer, `lay` / `unlay` blocks (a carried one has a world `free` frame; `slide` / `out`
  pull one out, `glow`, `jiggle`, `raise`), `collapse(spin, about)` turns them all into physics boxes; `drawBlock`,
  and `Pattern.wood`: wood grain round an object's longest axis, darker end grain and edges, `param` a per-piece
  seed). Put new
  entities here unless they are truly one-off; level folders keep only the level logic.
- `src/dev/sandbox.ts` — mechanics test room, opened with `?sandbox` (not a game level)
- `src/levels/level.ts` — the `Level` interface; each level gets its own folder under `src/levels/`

## Adding a level

Implement `Level` (update / draw / environment / obstacles / cameraShot; take `number` from `ctx.number`, which main.ts
sets from the level's place in `LEVELS`, so levels can be reordered freely; register it there as
`['id', (ctx) => new MyLevel(ctx)]`, a stable id that saved progress uses), set `status` to `lost` (with `hud.show`)
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
- Sound (`engine/audio.ts`): portals, buttons, levers, hits, explosions and the death trombone play by themselves.
  Levels add their own with `sfx.*`, `tone()` / `noise()`, or a `Tune` (call `start()` from update while it
  should play: starting a level and pausing stop every tune). Never rely on sound alone for a cue.
- `Level.obstacles()` circles keep the living player out (resolved in a few passes, so there is no squeezing between
  two that touch); give them `GROUPS_RAGDOLL_ONLY` colliders too if a flung corpse should bounce off them.
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
- `player.carry(delta)` — moves the player along with something the level moves itself (a lift, a rising tower): the
  feet, the capsule and the physical body together, so the body isn't left behind and dragged through the floor.
- `player.sitting` draws the sitting pose (`SIT_POSE` in body.ts; the level keeps them on the seat).
- `player.gravityScale` (1; 0 = weightless) and `player.airControl` (1; 0 = the air velocity is left alone, so they
  drift and the level steers) — this life only. `player.poseOverride` draws a level's own `Pose` while in control
  (clinging to something, floating), or in `swinging` mode instead of the hanging pose; null for the normal animation.
- `player.torchArm` raises the right arm up and ahead as if holding a torch (the level draws the torch).
- `player.startPuppet(pose)` (mode `'puppet'`): QWOP-style, the level drives the joints (`player.puppetPose`, per-joint
  `puppetJoints` multipliers, `puppetStrength`; this life only) and nothing else holds the body up. It's kept in the
  vertical x-y plane (`PhysBody.setPlanar`: nothing moves along z and the pelvis only turns about z, so face along
  ±x), `pos` follows the pelvis, and nothing knocks it. `kill()` ends it limp; `stopPuppet()` gives WASD back (they
  scramble up from however they ended up). `PhysBody.driveJoints(pose, strengths)` is the joint-motor half of `drive()`.
- `player.resume(velocity)` puts the player back in normal control after a scripted mode; `player.partFrames()`
  gives each body part's frame (e.g. to put a torch in the right hand, `foreArmR`).
- Rapier's character controller can't jump up alongside kinematic colliders (the jump dies at once) or up an
  overhang (counts as bumping your head): for something moving that the player should climb onto, use a fixed body
  and teleport it every frame, and move whoever stands on it yourself.
- `Pattern.lava` with `param` 2 draws a thing turned molten (hotter than a pool, and varying with height too);
  `param` 3 is see-through pool water (give it an `opacity`; it gets more opaque at grazing angles). A negative
  `Pattern.panels` param draws underwater tiles of that size with rippling caustics.
- `player.cancelJump()` forgets a buffered Space press the level used for something else.
- Boulders use `GROUPS_BOULDER`, and invisible `GROUPS_BOULDER_BRIDGE` colliders are floors only boulders touch
  (so they roll over pits the player has to jump). Loose objects on `GROUPS_DEBRIS` behave normally but boulders
  pass through them.
- In scripted modes (`held`, `flying`, `stuck`, `splat`, `swinging`) the physical body is switched off and the pose is drawn
  directly; in `control`, `ragdoll` and `puppet` the body is drawn from physics.

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
