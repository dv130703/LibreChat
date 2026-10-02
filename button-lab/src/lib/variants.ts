import { tv } from 'tailwind-variants';

/** Starter button variants — extend as you fill the canvas sections. */
export const buttonVariants = tv({
	base: 'inline-flex items-center justify-center gap-2 font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-sea-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-ink)] disabled:pointer-events-none disabled:opacity-45',
	variants: {
		variant: {
			solid:
				'bg-[color:var(--color-sea)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-sea-bright)]',
			outline:
				'border border-[color:var(--color-line)] bg-transparent text-[color:var(--color-foam)] hover:border-[color:color-mix(in_oklab,var(--color-sea)_45%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--color-sea)_12%,transparent)]',
			soft: 'bg-[color:color-mix(in_oklab,var(--color-sea)_18%,transparent)] text-[color:var(--color-sea-bright)] hover:bg-[color:color-mix(in_oklab,var(--color-sea)_28%,transparent)]',
			ghost: 'bg-transparent text-[color:var(--color-mist)] hover:bg-[color:color-mix(in_oklab,white_6%,transparent)] hover:text-[color:var(--color-foam)]',
			destructive:
				'bg-[color:var(--color-ember)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-ember-soft)]'
		},
		size: {
			sm: 'h-8 rounded-lg px-3 text-xs',
			md: 'h-10 rounded-xl px-4 text-sm',
			lg: 'h-12 rounded-2xl px-5 text-base',
			icon: 'size-10 rounded-xl'
		}
	},
	defaultVariants: {
		variant: 'solid',
		size: 'md'
	}
});
