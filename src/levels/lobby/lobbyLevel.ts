import { sfx } from '../../engine/audio';
import type { DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { Button, Lever, WallButton } from '../../entities/props';
import { saveSettings, settings } from '../../game/settings';
import { AfkPranks } from './afk';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type WorldLabel } from '../level';

/*
 * The lobby: the "main menu" is a chamber you walk around in. Numbered buttons on the north wall
 * pick the level (E or a click), buttons and levers in the south-west corner change settings, and the START
 * portal in the east wall goes to the game.
 */

/** Level buttons on the north wall: spacing across, the top row's height, and the row spacing. */
const BUTTON_SPACING = 1.95;
const BUTTON_TOP_Y = 2.65;
const BUTTON_ROW_DROP = 1.25;
const BUTTONS_PER_ROW = 7;
const MOUSE_MIN = 0.2;
const MOUSE_MAX = 4;
const WALL = CHAMBER_HALF - 0.08;
/** The settings corner (south-west): x of the buttons and levers. */
const SETTINGS_X = -9.6;

export class LobbyLevel implements Level {
  readonly number = 0;
  readonly title = 'Lobby';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private levelButtons: WallButton[] = [];
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

    // Level select: rows of numbered buttons on the north wall (gold-rimmed: levels you got out of).
    for (let i = 0; i < levelCount; i++) {
      const row = Math.floor(i / BUTTONS_PER_ROW), inRow = Math.min(BUTTONS_PER_ROW, levelCount - row * BUTTONS_PER_ROW);
      const x = ((i % BUTTONS_PER_ROW) - (inRow - 1) / 2) * BUTTON_SPACING;
      const y = BUTTON_TOP_Y - row * BUTTON_ROW_DROP;
      const button = new WallButton(physics, [x, y, -CHAMBER_HALF], 0, String(i + 1), () => this.pickLevel(i + 1));
      button.rim = settings.beaten.includes(levelIds[i]);
      this.levelButtons.push(button);
    }
    this.fixedLabels.push({ pos: [0, 4.5, -WALL], text: 'PICK YOUR POISON', size: 0.5, color: '#ffd166' });
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
    settings.startLevel = n;
    saveSettings();
    this.refreshLabels();
  }

  private changeMouse(factor: number) {
    settings.mouseSpeed = Math.min(MOUSE_MAX, Math.max(MOUSE_MIN, Math.round(settings.mouseSpeed * factor * 20) / 20));
    saveSettings();
    this.refreshLabels();
  }

  private refreshLabels() {
    if (!this.startLabel) return;
    this.startLabel.text = `→ LEVEL ${settings.startLevel}`;
    this.levelButtons.forEach((b, i) => (b.lit = i + 1 === settings.startLevel));
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

