/**
 * U-2 — Notification surface contract.
 *
 * - **Toasts (sonner):** ephemeral feedback for user actions (save, sync, error).
 * - **Chat proactive feed:** persistent intelligence (agents, brain, patterns).
 * Do not route proactive agent output through toast — it duplicates and hides severity.
 */

import { toast } from 'sonner';

export function toastAction(message: string) {
  toast(message, { duration: 4000 });
}

export function toastError(message: string) {
  toast.error(message, { duration: 6000 });
}

export function toastWarning(message: string) {
  toast.warning(message, { duration: 5000 });
}
