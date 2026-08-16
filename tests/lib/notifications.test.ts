import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NOTIFICATIONS_SRC = resolve(
  import.meta.dirname,
  '../../web/src/lib/notifications.ts',
);

describe('notifications contract (U-2)', () => {
  const src = readFileSync(NOTIFICATIONS_SRC, 'utf8');

  it('documents toast vs proactive chat separation', () => {
    expect(src).toContain('Do not route proactive agent output through toast');
    expect(src).toContain('Chat proactive feed');
  });

  it('exports action, error, and warning toast helpers', () => {
    expect(src).toMatch(/export function toastAction/);
    expect(src).toMatch(/export function toastError/);
    expect(src).toMatch(/export function toastWarning/);
    expect(src).toContain("toast.error(message");
    expect(src).toContain("toast.warning(message");
  });
});
