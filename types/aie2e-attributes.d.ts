/**
 * Optional attributes ai-e2e-agent understands. Copy this file into your app (e.g. src/types/aie2e.d.ts)
 * to get autocomplete and value checks in JSX. Nothing here is required: the tester works without any of it,
 * and every attribute only makes tests faster, more exact or quieter. Full guide: the README, "Optional app hints".
 */
import 'react';

declare module 'react' {
  interface HTMLAttributes<T> {
    /** Stable handle for tests: recorded as the step's selector, with an XPath fallback. Keep it unique on the page. */
    'data-testid'?: string;
    /** Same as data-testid (Cypress and other conventions are understood too). */
    'data-test'?: string;
    /** Same as data-testid. */
    'data-cy'?: string;
    /** Same as data-testid. */
    'data-qa'?: string;
    /**
     * Free text for the AI planner and agent about this element or area, e.g.
     * "Controls appear when the mouse moves to the bottom-right corner".
     */
    'data-aie2e-hint'?: string;
    /** This control is hidden until hovered: the agent hovers it (or its area) before giving up. */
    'data-aie2e-reveal'?: 'hover';
    /**
     * Painted over in visual-regression screenshots: content that changes between runs by design
     * (timestamps, live counters, AI-written text, avatars, ads).
     */
    'data-aie2e-mask'?: boolean | '' | 'true';
    /**
     * Your name for a component. Every element with the same name must look the same on every screen and
     * in every theme (reported under "Consistency across screens").
     */
    'data-aie2e-component'?: string;
    /** Leave this element out of the theme audit (third-party widgets, user content, brand logos). */
    'data-aie2e-ignore-theme'?: boolean | '' | 'true';
  }
}
