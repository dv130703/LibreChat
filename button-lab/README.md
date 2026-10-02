# Button Lab

A self-contained **SvelteKit + Svelte 5** design playground for exploring button systems. The home page is a canvas of composition sections — empty frames with clear structure, ready for design work.

## Requirements

- **Node.js ≥ 22.17** (SvelteKit 3). An `.nvmrc` is included (`22.17.1`).

```sh
nvm use   # from this folder
```

## Setup

```sh
cd button-lab
npm install
```

## Develop

```sh
npm run dev
```

App defaults to [http://localhost:6969](http://localhost:6969).

```sh
npm run dev -- --open   # open in browser
```

## Other scripts

| Script            | Purpose                          |
| ----------------- | -------------------------------- |
| `npm run build`   | Production build                 |
| `npm run preview` | Preview the production build     |
| `npm run check`   | Typecheck with `svelte-check`    |

## Stack

| Package | Role |
| --- | --- |
| `svelte` / `@sveltejs/kit` | Svelte 5 + SvelteKit |
| `tailwindcss` / `@tailwindcss/vite` | Utility styling (v4) |
| `tw-animate-css` | Animation utilities |
| `motion-sv` | Motion (Framer-style) for Svelte |
| `bits-ui` | Headless UI primitives |
| `@lucide/svelte` | Icons |
| `clsx` / `tailwind-merge` / `tailwind-variants` | Class composition helpers |
| `@fontsource-variable/fraunces` | Display type |
| `@fontsource-variable/dm-sans` | UI type |

## Project layout

```
button-lab/
├── src/
│   ├── lib/
│   │   ├── components/   # CanvasSection, LabHeader
│   │   └── utils.ts      # cn() helper
│   └── routes/
│       ├── +page.svelte  # Design canvas
│       ├── +layout.svelte
│       └── layout.css    # Theme tokens + atmosphere
└── package.json
```

Add new button explorations inside the composition slots on `+page.svelte` (or pass children into `CanvasSection`).
