// Compile-only check that the attribute types accept what the docs show and reject wrong values.
export const ok = (
  <main aria-busy={false} data-aie2e-hint="Slides are generated after Create">
    <button data-testid="export-button" data-aie2e-component="PrimaryButton">
      Export
    </button>
    <div data-aie2e-reveal="hover" data-aie2e-hint="Toolbar appears on hover">
      <button data-cy="present-next">Next</button>
    </div>
    <span data-aie2e-mask>Updated 10:41</span>
    <iframe data-aie2e-ignore-theme title="Map" />
  </main>
);

// @ts-expect-error: the only reveal mode is "hover"
export const wrongReveal = <div data-aie2e-reveal="click" />;

// @ts-expect-error: a component name is text, not a number
export const wrongComponent = <div data-aie2e-component={42} />;
