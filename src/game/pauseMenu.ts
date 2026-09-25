/*
 * The pause menu: a DOM overlay with Resume / Restart / Lobby. Opens on Esc (or when the mouse
 * is released some other way, e.g. alt-tab).
 */

const STYLE = `
.pause { position: fixed; inset: 0; display: none; place-items: center; background: rgba(8, 4, 16, .62);
         font-family: "Segoe UI", system-ui, sans-serif; color: #fff; z-index: 10; }
.pause.open { display: grid; }
.pause-box { text-align: center; padding: 16px; max-width: 520px; }
.pause-title { font-size: 56px; font-weight: 800; letter-spacing: .08em; }
.pause-quip { margin: 6px 0 26px; font-size: 17px; opacity: .85; }
.pause button { display: block; width: 260px; max-width: 100%; margin: 10px auto; padding: 12px 18px; font: 600 18px inherit;
                font-family: inherit; color: #fff; background: rgba(150, 70, 255, .28); border: 2px solid #b27cff;
                border-radius: 10px; cursor: pointer; }
.pause button:hover { background: rgba(150, 70, 255, .55); }
`;

const QUIPS = [
  'Time has stopped. Mostly.',
  'The chamber will wait. The chamber is very patient.',
  'Take a breather. The test is not going anywhere. Neither are you.',
  'Paused. Nothing bad can happen now. Probably.',
  'Hydrate. Your ragdoll is 60% water too.',
];

export interface PauseActions {
  resume(): void;
  restart(): void;
  lobby(): void;
}

export class PauseMenu {
  isOpen = false;
  private root: HTMLDivElement;
  private quip: HTMLDivElement;
  private restartButton: HTMLButtonElement;
  private lobbyButton: HTMLButtonElement;

  constructor(actions: PauseActions) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'pause';
    const box = document.createElement('div');
    box.className = 'pause-box';
    const title = document.createElement('div');
    title.className = 'pause-title';
    title.textContent = 'PAUSED';
    this.quip = document.createElement('div');
    this.quip.className = 'pause-quip';
    const button = (text: string, action: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        action();
      });
      return b;
    };
    this.restartButton = button('Restart chamber', actions.restart);
    this.lobbyButton = button('Back to the lobby', actions.lobby);
    box.append(title, this.quip, button('Resume', actions.resume), this.restartButton, this.lobbyButton);
    this.root.append(box);
    // Clicking the backdrop resumes too.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) actions.resume();
    });
    document.body.appendChild(this.root);
  }

  open(inLobby: boolean) {
    this.isOpen = true;
    this.quip.textContent = QUIPS[Math.floor(Math.random() * QUIPS.length)];
    this.restartButton.textContent = inLobby ? 'Restart lobby' : 'Restart chamber';
    this.lobbyButton.style.display = inLobby ? 'none' : 'block';
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }
}
