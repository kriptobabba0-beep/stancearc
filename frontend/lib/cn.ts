/**
 * Tiny classnames joiner (no deps). Accepts strings, falsy values, and nested
 * arrays; joins the truthy ones with a space. Keep class lists conflict-free by
 * construction (we don't ship tailwind-merge).
 */
type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...args: ClassValue[]): string {
  const out: string[] = [];
  for (const a of args) {
    if (!a && a !== 0) continue;
    if (Array.isArray(a)) {
      const inner = cn(...a);
      if (inner) out.push(inner);
    } else {
      out.push(String(a));
    }
  }
  return out.join(' ');
}
