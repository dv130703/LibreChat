<script lang="ts">
	import { Layers, Sparkles } from '@lucide/svelte';
	import { Button } from 'bits-ui';
	import { motion } from 'motion-sv';

	interface SectionLink {
		id: string;
		label: string;
	}

	interface Props {
		sections: SectionLink[];
	}

	let { sections }: Props = $props();
</script>

<header class="relative overflow-hidden border-b border-[color:var(--color-line)]">
	<div
		class="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_420px_at_15%_-20%,color-mix(in_oklab,var(--color-sea)_28%,transparent),transparent_55%),radial-gradient(700px_360px_at_90%_0%,color-mix(in_oklab,var(--color-ember)_18%,transparent),transparent_50%)]"
		aria-hidden="true"
	></div>

	<div class="relative mx-auto flex max-w-6xl flex-col gap-10 px-6 py-14 sm:px-8 sm:py-20">
		<nav class="flex items-center justify-between gap-4" aria-label="Lab">
			<div class="flex items-center gap-2.5 text-[color:var(--color-foam)]">
				<span
					class="grid size-9 place-items-center rounded-xl border border-[color:var(--color-line)] bg-[color:color-mix(in_oklab,var(--color-panel)_70%,transparent)]"
				>
					<Layers class="size-4 text-[color:var(--color-sea-bright)]" aria-hidden="true" />
				</span>
				<span class="font-display text-lg tracking-tight">Button Lab</span>
			</div>
			<Button.Root
				href="#canvas"
				class="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-line)] bg-[color:color-mix(in_oklab,var(--color-panel)_65%,transparent)] px-3.5 py-2 text-sm text-[color:var(--color-foam)] transition-colors hover:border-[color:color-mix(in_oklab,var(--color-sea)_45%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--color-sea)_14%,transparent)]"
			>
				<Sparkles class="size-3.5 text-[color:var(--color-ember-soft)]" aria-hidden="true" />
				Open canvas
			</Button.Root>
		</nav>

		<motion.div
			class="max-w-3xl"
			initial={{ opacity: 0, y: 16 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
		>
			<p
				class="mb-4 text-[0.72rem] font-medium tracking-[0.2em] text-[color:var(--color-ember-soft)] uppercase"
			>
				Design playground
			</p>
			<h1
				class="font-display text-[clamp(2.6rem,7vw,4.6rem)] leading-[0.95] tracking-[-0.03em] text-[color:var(--color-foam)]"
			>
				Button Lab
			</h1>
			<p class="mt-5 max-w-xl text-base leading-relaxed text-[color:var(--color-mist)] sm:text-lg">
				A self-contained Svelte 5 canvas for exploring button systems — structure first, polish
				later. Each section below is a dedicated composition frame.
			</p>
		</motion.div>

		<div class="flex flex-wrap gap-2" aria-label="Jump to sections">
			{#each sections as section (section.id)}
				<a
					href="#{section.id}"
					class="rounded-full border border-[color:var(--color-line)] bg-[color:color-mix(in_oklab,var(--color-ink)_35%,transparent)] px-3 py-1.5 text-xs tracking-wide text-[color:var(--color-mist)] transition-colors hover:border-[color:color-mix(in_oklab,var(--color-sea)_40%,transparent)] hover:text-[color:var(--color-foam)]"
				>
					{section.label}
				</a>
			{/each}
		</div>
	</div>
</header>
