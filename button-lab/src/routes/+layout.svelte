<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Button Lab — Svelte design canvas</title>
	<meta
		name="description"
		content="A SvelteKit + Svelte 5 playground for exploring button designs."
	/>
</svelte:head>

<div id="lab-root">
	{@render children()}
</div>
