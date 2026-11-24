# Daily Drive — redesign asset kit

Everything needed to rebuild the **Daily Drive** redesign of *GTA or Florida?* exactly as in the reference prototype. All art is original and generated from code. There are no Rockstar or GTA assets, logos or characters.

Open `reference/daily-drive-prototype.html` in a browser first. It is the visual source of truth for every screen, state and animation. Use its **DEV PANEL** tab on the left edge to jump to any state. Its game logic and questions are sample-only. Do not port them.

## Contents

| Path | What it is |
| --- | --- |
| `reference/daily-drive-prototype.html` | Self-contained playable prototype with all screens, the dev panel and the design-system page (`#design-system`) |
| `CLAUDE_CODE_PROMPT.md` | Implementation brief for Claude Code |
| `css/tokens.css` | CSS custom properties: colours, fonts, the pixel-corner `--notch` clip-path |
| `css/components.css` | Component styles; class names match the prototype |
| `css/animations.css` | All `@keyframes`, plus reduced-motion rules (OS setting or `body.rm`) |
| `css/fonts.css` | Font loading: Google Fonts import, or self-host via `@fontsource` (instructions inside) |
| `js/pixel-engine.js` | ES module that renders the mascot, car, road map, detours and postcard scenes, plus the `DriveMap` class |
| `data/copy.json` | All UI copy: zones, detour signs, mascot lines and alt text, endings, verdicts, disclaimer |
| `data/tokens.json` | Design tokens as data: colours, type scale, spacing, map geometry |
| `data/motion.json` | Animation spec: trigger, duration, easing, reduced-motion fallback |
| `data/sample-questions.json` | **Sample data only**, for dev/visual testing. Never ship it |
| `sprites/mascot/png/` | Gus the gator: 7 states × 2 frames at 32, 64 and 128px, transparent |
| `sprites/mascot/svg/` | The same 14 frames as crisp-edged SVG |
| `sprites/mascot/gus-sheet@1x.png` / `@4x` | Sprite sheet: rows = states, columns = frames 0 and 1 |
| `sprites/car/` | Pink convertible, 2 wheel frames, PNG at 1×, 2× and 4×, SVG, sheet |
| `scenery/map-near@{1,2,4}x.png` | Road layer, 840×64 logical, five zones of 160px (the Vice zone is 200px) |
| `scenery/map-far@{1,2,4}x.png` | Sky, sun and hills layer, 720×64; scroll at 0.35× for parallax |
| `scenery/map-near-all-detours@1x.png` | Road layer with every detour marked as used (reference) |
| `scenery/detours/detour-zoneN@{1,4}x.png` | Transparent 840×64 overlays, each showing one zone's used detour route |
| `scenery/zones/zone-*@{1,4}x.png` | Each zone flattened (far + near) for previews and OG images |
| `postcards/postcard-{vice,veteran,tourist,glades,fman}@{1,4}x.png` | The five ending scenes, 192×108 logical |
| `icons/*.svg` | Checkpoint states (correct, wrong, pending, current), check, cross, close, home, play |

## Mascot states

The states are `idle`, `correct`, `wrong`, `streak`, `nervous` (time running out), `perfect` and `low`.

Each state has two frames. Swap frames every **380ms**, or show frame 0 only under reduced motion. In the sheet, the state row index follows that order and frame 0 is the left column.

## Ending bands

| Score | Key | Title |
| --- | --- | --- |
| 5 | `vice` | Vice Legend |
| 4 | `veteran` | Florida Veteran |
| 3 | `tourist` | Tourist with Potential |
| 2 | `glades` | Lost in the Everglades |
| 0–1 | `fman` | Certified Florida Man |

## Rendering rules

- Pixel art must stay crisp. Add `image-rendering: pixelated` to every sprite, scenery and postcard element, and only scale by whole numbers where you can.
- PNGs at @1x are native size. Scale them with CSS, or use @2x/@4x for `<img>` without CSS scaling.
- Colour is never the only signal. Correct uses a teal square with a check, wrong uses an orange cone with a cross, pending uses a dashed circle.

## `pixel-engine.js` API (browser only; it uses canvas)

```js
import { DriveMap, SPR, CARU, STATES, drawArt, endingFor, setReducedMotion } from './pixel-engine.js';

const map = new DriveMap(containerEl, /* attract */ false); // the container needs class "map"
map.drive(k, wrong, onDone); // animate to checkpoint k (1..5); wrong = true takes the detour (1200ms)
map.setMark(k, 'ok' | 'bad' | ''); // checkpoint marker plus detour route state
map.jump(k);  // place the car instantly
map.reset();
map.setTurbo(true); // streak flames
map.layout(); // call after the container becomes visible
map.destroy();

SPR[state][frame]; // data-URL PNG, 32×32
drawArt(canvas192x108, endingFor(score)); // postcard scene
setReducedMotion(() => userPrefersLessMotion); // optional override
```

`new DriveMap(el, true)` is the landing-page attract mode: the car loops through all five zones.

## Licences

- All art, sprites and code here are original work for this project.
- The fonts are Press Start 2P, Silkscreen and Rubik, all under the SIL Open Font License. They are not bundled; see `css/fonts.css`.
- The game is an unofficial parody, and the disclaimer in `data/copy.json` must stay visible.
