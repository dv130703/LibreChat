<script lang="ts">
	import type { Snippet } from 'svelte';
	import { motion } from 'motion-sv';
	import { cn } from '../utils';

	interface Props {
		id: string;
		title: string;
		eyebrow?: string;
		description?: string;
		class?: string;
		children?: Snippet;
	}

	let {
		id,
		title,
		eyebrow = 'Composition',
		description = 'Drop button explorations into this frame.',
		class: className = '',
		children
	}: Props = $props();
</script>

<section {id} aria-labelledby="{id}-title" class={cn('scroll-mt-28', className)}>
	<motion.div
		class="grid gap-5"
		initial={{ opacity: 0, y: 18 }}
		whileInView={{ opacity: 1, y: 0 }}
		inViewOptions={{ once: true, amount: 0.25 }}
		transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
	>
		<header class="max-w-2xl">
			<p
				class="mb-2 text-[0.72rem] font-medium tracking-[0.18em] text-[color:var(--color-sea-bright)] uppercase"
			>
				{eyebrow}
			</p>
			<h2
				id="{id}-title"
				class="font-display text-[clamp(1.6rem,2.4vw,2.15rem)] leading-tight tracking-[-0.02em] text-[color:var(--color-foam)]"
			>
				{title}
			</h2>
			{#if description}
				<p class="mt-2 max-w-xl text-[0.95rem] leading-relaxed text-[color:var(--color-mist)]">
					{description}
				</p>
			{/if}
		</header>

		<div
			class="relative min-h-44 overflow-hidden rounded-[1.35rem] border border-[color:var(--color-line)] bg-[color:color-mix(in_oklab,var(--color-panel)_82%,transparent)] p-6 shadow-[inset_0_1px_0_color-mix(in_oklab,white_8%,transparent)] backdrop-blur-sm sm:p-8"
		>
			<div
				class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,color-mix(in_oklab,var(--color-sea)_12%,transparent),transparent_42%),radial-gradient(circle_at_90%_100%,color-mix(in_oklab,var(--color-ember)_10%,transparent),transparent_40%)]"
				aria-hidden="true"
			></div>
			<div
				class="relative flex min-h-32 flex-wrap items-center justify-center gap-4"
				data-canvas-slot={id}
			>
				{#if children}
					{@render children()}
				{:else}
					<p
						class="rounded-full border border-dashed border-[color:var(--color-line)] px-4 py-2 text-sm text-[color:var(--color-mist)]"
					>
						Empty composition — ready for designs
					</p>
				{/if}
			</div>
		</div>
	</motion.div>
</section>
