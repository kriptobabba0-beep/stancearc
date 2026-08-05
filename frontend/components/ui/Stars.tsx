// components/ui/Stars.tsx - the six sparkles for the red shooting-star CTA. Drop <Stars /> in as the
// LAST child of any .star-btn (primary/secondary) button or link. The sparkles sit behind the button at
// rest and fly outward on hover (exact positions / timings live under .star-btn in globals.css). They
// are aria-hidden and switched off under prefers-reduced-motion. They deliberately overflow the button
// on hover - exactly like the original design - so a clipping ancestor may crop the furthest ones.

// The 4-point sparkle (the exact path from the source design).
const STAR_PATH =
  'M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 20.93,-210.06 184.09,-378.37 392.05,-407.74 -207.98,-29.38 -371.16,-197.69 -392.06,-407.78z';

export function Stars() {
  return (
    <span aria-hidden="true">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <span key={n} className={`star star-${n}`}>
          <svg viewBox="0 0 784.11 815.53" xmlns="http://www.w3.org/2000/svg">
            <path className="star-fill" d={STAR_PATH} />
          </svg>
        </span>
      ))}
    </span>
  );
}
