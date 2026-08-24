# audio-intake

The audio intake step (step 1 of 3) and every UI element it is built from, in
one folder so it can be lifted into another project as a unit.

## What is here

One subfolder per component, each with its own barrel:

| Folder | Role |
| --- | --- |
| `upload-intake/` | The step itself: dropzone, hero player, quality/format/transcription rows, the CTA |
| `format-dropdown/` | Output-format picker shown inside the Format row |
| `audio-quality/` | The sound-check rows, and `metrics.ts` — how a raw measurement becomes a verdict |
| `transcript-options/` | Transcription settings, their defaults, the term suggester, and `TranscriptActions` (used by the transcript step) |
| `audio-player/` | Transport and scrubber |
| `waveform/` | The waveform plate both the player and the intake draw |
| `icon/` | The icon set these components use |

At the root:

| File | Role |
| --- | --- |
| `tokens.css` | Colour, type, spacing, radius, elevation and motion tokens every stylesheet here reads |
| `index.ts` | Public surface — import from here, not from individual files |

## Dependencies

Everything is self-contained **except** `../logic`, which supplies format
conversion, media probing and the quality-check hook:

```ts
import { probeMedia, useAudioConverter, useAudioQualityCheck } from '../../logic'
```

That layer is data rather than UI and is shared with the transcript and summary
steps, so it was deliberately left in place. To make this folder fully
standalone, move `../logic/audio/` in here and re-point those imports.

Runtime dependencies: `react`, `@ffmpeg/ffmpeg` and `@ffmpeg/util` (in-browser
conversion, reached through `../exclusives/logic`).

## Styling

`tokens.css` is the styling contract. It is imported once at the app root
(`src/index.css`) rather than per-component, so import it wherever this folder
is dropped:

```css
@import './exclusives/audio-intake/tokens.css';
```

The components also use a few app-level primitives defined in `src/index.css` —
`.card`, `.button`, `.checkbox`, `.select`, `.pill`, `.eyebrow`,
`.visually-hidden`. Bring those across too, or restyle against the tokens.

## Usage

```tsx
import { UploadIntake, TranscriptionOptionsPanel } from './exclusives/audio-intake'

<UploadIntake
  onFileChange={handleFileChange}
  onConverted={handleConverted}
  onContinue={() => setStage(2)}
  optionsSlot={<TranscriptionOptionsPanel options={options} onChange={patch} />}
/>
```
