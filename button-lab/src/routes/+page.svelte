<script lang="ts">
	import { CanvasSection, LabHeader } from '#lib';

	const sections = [
		{
			id: 'solid',
			label: 'Solid',
			title: 'Solid / Primary',
			description: 'High-emphasis fills for primary actions. Explore weight, radius, and press feel.'
		},
		{
			id: 'outline',
			label: 'Outline',
			title: 'Ghost / Outline',
			description: 'Low-emphasis borders and transparent fills for secondary paths.'
		},
		{
			id: 'soft',
			label: 'Soft',
			title: 'Soft / Tonal',
			description: 'Tinted surfaces that sit between solid and outline — calm, modern hierarchy.'
		},
		{
			id: 'destructive',
			label: 'Destructive',
			title: 'Destructive',
			description: 'Caution states for irreversible actions. Keep meaning clear without shouting.'
		},
		{
			id: 'icon',
			label: 'Icon',
			title: 'Icon buttons',
			description: 'Compact square and circular affordances — toolbars, editors, dense UI.'
		},
		{
			id: 'loading',
			label: 'Loading',
			title: 'Loading / Async',
			description: 'Pending, success, and disabled-while-submitting patterns.'
		},
		{
			id: 'sizes',
			label: 'Sizes',
			title: 'Size scale',
			description: 'xs → xl rhythm. Align padding, type, and icon optics across the ladder.'
		},
		{
			id: 'motion',
			label: 'Motion',
			title: 'Animated / Motion',
			description: 'Hover, press, and entrance motion studies powered by motion-sv.'
		},
		{
			id: 'compound',
			label: 'Compound',
			title: 'Split / Compound',
			description: 'Button groups, split menus, and attached affordances (bits-ui ready).'
		},
		{
			id: 'experimental',
			label: 'Lab',
			title: 'Experimental playground',
			description: 'Wildcard ideas that do not fit a category yet — sketch freely here.'
		}
	] as const;
</script>

<LabHeader sections={sections.map(({ id, label }) => ({ id, label }))} />

<main id="canvas" class="mx-auto flex max-w-6xl flex-col gap-16 px-6 py-14 sm:gap-20 sm:px-8 sm:py-20">
	{#each sections as section (section.id)}
		<CanvasSection
			id={section.id}
			title={section.title}
			description={section.description}
			eyebrow="Section · {section.label}"
		/>
	{/each}
</main>

<footer
	class="mx-auto max-w-6xl border-t border-[color:var(--color-line)] px-6 py-10 text-sm text-[color:var(--color-mist)] sm:px-8"
>
	<p>
		Button Lab · SvelteKit + Svelte 5 · Tailwind CSS · bits-ui · motion-sv · @lucide/svelte
	</p>
</footer>
