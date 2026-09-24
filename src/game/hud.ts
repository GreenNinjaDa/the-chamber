const STYLE = `
.hud { position: fixed; inset: 0; pointer-events: none; color: #fff;
       font-family: "Segoe UI", system-ui, sans-serif; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
.hud-level { position: absolute; top: 16px; left: 20px; font-size: 14px; letter-spacing: .2em;
             text-transform: uppercase; opacity: .85; }
.hud-fps { position: absolute; top: 16px; right: 20px; font-size: 12px; opacity: .6; font-variant-numeric: tabular-nums; }
.hud-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
              transition: opacity .4s; padding: 16px; }
.hud-big { font-size: clamp(40px, 9vw, 96px); font-weight: 800; letter-spacing: .12em; }
.hud-small { font-size: clamp(14px, 2vw, 20px); margin-top: 8px; opacity: .9; white-space: pre-line; line-height: 1.5; }
.hud-hint { position: absolute; bottom: 28px; left: 0; right: 0; text-align: center; font-size: 18px;
            padding: 0 16px; transition: opacity .3s; }
`;

/** DOM overlay for level titles, messages and hints. */
export class Hud {
  private levelEl: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private centerEl: HTMLDivElement;
  private bigEl: HTMLDivElement;
  private smallEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private messageTimer = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const root = el('hud');
    this.levelEl = el('hud-level');
    this.fpsEl = el('hud-fps');
    this.centerEl = el('hud-center');
    this.bigEl = el('hud-big');
    this.smallEl = el('hud-small');
    this.hintEl = el('hud-hint');
    this.centerEl.append(this.bigEl, this.smallEl);
    root.append(this.levelEl, this.fpsEl, this.centerEl, this.hintEl);
    document.body.appendChild(root);
    this.hide();
  }

  setLevel(text: string) {
    this.levelEl.textContent = text;
  }

  /** Shows a centred message; with a duration it fades out on its own. */
  show(big: string, small = '', duration = 0) {
    this.bigEl.textContent = big;
    this.smallEl.textContent = small;
    this.centerEl.style.opacity = '1';
    this.messageTimer = duration;
  }

  hide() {
    this.centerEl.style.opacity = '0';
    this.messageTimer = 0;
  }

  hint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.style.opacity = text ? '1' : '0';
  }

  update(dt: number) {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.hide();
    }
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAccum)} fps`;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }
}

function el(className: string) {
  const d = document.createElement('div');
  d.className = className;
  return d;
}
