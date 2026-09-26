import { sfx } from '../../engine/audio';
import { mul, scaling, translation } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk, spawnJunk } from '../../entities/junk';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { Button, Lever } from '../../entities/props';
import { saveSettings, settings } from '../../game/settings';
import { AfkPranks } from './afk';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type WorldLabel } from '../level';

/*
 * The lobby: the "main menu" is a chamber you walk around in. Numbered floor pads pick the level
 * (step on one), buttons and levers in the south-west corner change settings, and the START
 * portal in the east wall goes to the game.
 */

const PAD_SELECTED: [number, number, number] = [0.35, 1.6, 0.45];
const PAD_UNDER_FOOT: [number, number, number] = [0.3, 0.32, 0.4];
const PAD: [number, number, number] = [0.1, 0.11, 0.14];
/** Pads of levels you've got out of: a gold rim. */
const PAD_RIM: [number, number, number] = [1.25, 0.9, 0.3];
/** Level pads: size, spacing and the first row's z (rows run south from the north wall). */
const PAD_SIZE = 1.9;
const PAD_SPACING = 2.4;
const PAD_FIRST_Z = -10.2;
const MOUSE_MIN = 0.2;
const MOUSE_MAX = 4;
const WALL = CHAMBER_HALF - 0.08;
const PADS_PER_ROW = 8;
/** The settings corner (south-west): x of the buttons and levers. */
const SETTINGS_X = -9.6;

export class LobbyLevel implements Level {
  readonly number = 0;
  readonly title = 'Lobby';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private pads: { x: number; z: number; n: number; id: string; digits: PixelText }[] = [];
  /** The pad the player is standing on (so stepping on picks it once). */
  private onPad = 0;
  private settled = false;
  private fixedLabels: WorldLabel[] = [];
  private allLabels: WorldLabel[] = [];
  private startLabel: WorldLabel;
  private mouseLabel: WorldLabel;
  private invertLabel: WorldLabel;
  private soundLabel: WorldLabel;
  /** Pranks for players who wander off and leave their character standing here. */
  readonly afk: AfkPranks;
  private deadFor = 0;

  /** `levelIds`: every level's id, in order (progress is saved by id, so levels can be reordered). */
  constructor(private ctx: LevelContext, levelIds: string[]) {
    const levelCount = levelIds.length;
    const { physics, hud } = ctx;
    hud.setLevel('The Chamber · Lobby');
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
    this.exit.openAlready();
    this.afk = new AfkPranks(ctx);
    settings.startLevel = Math.min(levelCount, Math.max(1, settings.startLevel));

    // Level select: numbered floor pads in rows across the north half (step on one to pick it).
    for (let i = 0; i < levelCount; i++) {
      const row = Math.floor(i / PADS_PER_ROW), inRow = Math.min(PADS_PER_ROW, levelCount - row * PADS_PER_ROW);
      const x = ((i % PADS_PER_ROW) - (inRow - 1) / 2) * PAD_SPACING;
      const z = PAD_FIRST_Z + row * PAD_SPACING;
      // The number painted on the pad, reading from the south.
      const digits = new PixelText({ centre: [x, 0.06, z], right: [1, 0, 0], up: [0, 0, -1], pixel: 0.12, color: [1.3, 1.3, 1.4], depth: 0.012, pattern: Pattern.emissive }, String(i + 1));
      this.pads.push({ x, z, n: i + 1, id: levelIds[i], digits });
    }
    this.fixedLabels.push({ pos: [0, 4.5, -WALL], text: 'PICK YOUR POISON (STAND ON A NUMBER)', size: 0.5, color: '#ffd166' });
    const beaten = levelIds.filter((id) => settings.beaten.includes(id)).length;
    this.fixedLabels.push({
      pos: [0, 3.8, -WALL],
      text: beaten === 0 ? 'SURVIVED: NONE. YET.' : beaten >= levelCount ? `SURVIVED: ALL ${levelCount}. SHOW-OFF.` : `SURVIVED: ${beaten} / ${levelCount}`,
      size: 0.4,
      color: '#ffffff',
    });

    // Settings, in the south-west corner: mouse speed buttons, and levers for inverted look and sound.
    new Button(physics, [SETTINGS_X, 0, 2.2], [0.2, 0.45, 0.9], () => this.changeMouse(1 / 1.2));
    new Button(physics, [SETTINGS_X, 0, 4.6], [0.95, 0.5, 0.1], () => this.changeMouse(1.2));
    this.fixedLabels.push({ pos: [SETTINGS_X, 1.8, 2.2], text: '–', size: 0.5 }, { pos: [SETTINGS_X, 1.8, 4.6], text: '+', size: 0.5 });
    this.mouseLabel = { pos: [SETTINGS_X, 2.6, 3.4], text: '', size: 0.3, color: '#ffd166' };
    const lever = new Lever(physics, [SETTINGS_X, 0, 7.2], Math.PI / 2, (on) => {
      settings.invertY = on;
      saveSettings();
      this.refreshLabels();
    });
    lever.on = settings.invertY;
    this.invertLabel = { pos: [SETTINGS_X, 2.3, 7.2], text: '', size: 0.26, color: '#ffd166' };
    const soundLever = new Lever(physics, [SETTINGS_X, 0, 9.8], Math.PI / 2, (on) => {
      settings.sound = on;
      saveSettings();
      this.refreshLabels();
    });
    soundLever.on = settings.sound;
    this.soundLabel = { pos: [SETTINGS_X, 2.3, 9.8], text: '', size: 0.26, color: '#ffd166' };

    this.startLabel = { pos: [WALL, 3.05, 0], text: '', size: 0.26, color: '#e7c6ff' };
    this.fixedLabels.push(
      { pos: [WALL, 3.6, 0], text: 'START', size: 0.8, color: '#f0d9ff' },
      { pos: [0, 7.2, -WALL], text: 'THE CHAMBER', size: 2.2 },
      { pos: [0, 5.75, -WALL], text: 'Aperture-adjacent. Legally distinct.', size: 0.6 },
      { pos: [-WALL, 4.9, 0], text: 'WASD walk · Shift sprint · Space jump', size: 0.5 },
      { pos: [-WALL, 4.1, 0], text: 'E or click use · Hold E or click carry · Press another throw · Esc pause', size: 0.5 },
    );
    this.allLabels = [...this.fixedLabels, this.startLabel, this.mouseLabel, this.invertLabel, this.soundLabel];
    this.refreshLabels();

    // Something to fling around while you make up your mind.
    for (let i = 0; i < 4; i++) {
      const def = junk(i % 2 ? 'small crate' : 'crate');
      spawnJunk(physics, def, [4 + i * 1.3, def.size[1] / 2 + 0.01, 5.5 + (i % 2) * 1.5]);
    }
    spawnJunk(physics, junk('beach ball'), [3, 0.4, 3]);
    spawnJunk(physics, junk('rubber duck'), [1.5, 0.3, 3.5]);
  }

  private pickLevel(n: number) {
    if (n !== settings.startLevel) sfx.button();
    settings.startLevel = n;
    saveSettings();
    this.refreshLabels();
  }

  /** The level pad under the player's feet (0: none). */
  private padUnder(): number {
    const p = this.ctx.player.pos;
    for (const pad of this.pads) if (Math.abs(p[0] - pad.x) < PAD_SIZE / 2 && Math.abs(p[2] - pad.z) < PAD_SIZE / 2) return pad.n;
    return 0;
  }

  private changeMouse(factor: number) {
    settings.mouseSpeed = Math.min(MOUSE_MAX, Math.max(MOUSE_MIN, Math.round(settings.mouseSpeed * factor * 20) / 20));
    saveSettings();
    this.refreshLabels();
  }

  private refreshLabels() {
    if (!this.startLabel) return;
    this.startLabel.text = `→ LEVEL ${settings.startLevel}`;
    this.mouseLabel.text = `MOUSE SPEED ${settings.mouseSpeed.toFixed(2)}×`;
    this.invertLabel.text = `INVERT LOOK: ${settings.invertY ? 'ON' : 'OFF'}`;
    this.soundLabel.text = settings.sound ? 'SOUND: ON' : 'SOUND: BLISSFULLY OFF';
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered) this.status = 'exited';
    this.afk.update(dt, this.arrival.done && this.status === 'playing');
    // Stepping onto a level pad picks it.
    const standing = this.arrival.done && player.mode === 'control' && player.onGround && !player.inPortal;
    const pad = standing ? this.padUnder() : 0;
    // (Landing on one from the portal doesn't count: only stepping onto one.)
    if (standing && !this.settled) {
      this.settled = true;
      this.onPad = pad;
    }
    if (pad && pad !== this.onPad) this.pickLevel(pad);
    if (standing || !player.onGround) this.onPad = pad;
    // The only way to die in the lobby is to leave your character unattended near a grenade.
    if (player.mode === 'ragdoll' && this.status === 'playing') {
      this.deadFor += dt;
      if (this.deadFor > 1.5) {
        this.status = 'lost';
        hud.show('AWAY FROM KEYBOARD', 'Permanently, now.\nPress R to respawn.');
        hud.tips([
          ['Hint', 'Idle hands get handed grenades. Wiggle the mouse now and then.'],
          ['Controls', 'R respawns you. Literally any key proves you are alive.'],
        ]);
      }
    }
  }

  draw(out: DrawItem[]) {
    for (const pad of this.pads) {
      const picked = pad.n === settings.startLevel;
      if (settings.beaten.includes(pad.id)) {
        out.push({ mesh: 'bevelbox', model: mul(translation([pad.x, 0.02, pad.z]), scaling([PAD_SIZE + 0.36, 0.04, PAD_SIZE + 0.36])), color: PAD_RIM, pattern: Pattern.emissive, shadow: false });
      }
      out.push({
        mesh: 'bevelbox',
        model: mul(translation([pad.x, 0.03, pad.z]), scaling([PAD_SIZE, 0.06, PAD_SIZE])),
        color: picked ? PAD_SELECTED : pad.n === this.onPad ? PAD_UNDER_FOOT : PAD,
        pattern: picked ? Pattern.emissive : undefined,
        spec: 0.3,
      });
      const from = out.length;
      pad.digits.draw(out);
      for (let i = from; i < out.length; i++) out[i].shadow = false;
    }
    this.arrival.draw(out);
    this.exit.draw(out);
    this.afk.draw(out);
  }

  labels(): WorldLabel[] {
    return this.allLabels;
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

