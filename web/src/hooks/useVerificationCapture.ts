/**
 * ADR-040 commit 4.5 (2026-07-06): client-side verification capture.
 *
 * The DoD §2.4 condition (2) mechanism at the React layer. Captures
 * verification output from either the browser clipboard (via
 * Clipboard API) or a paste-target <textarea>, SHA-256s the content,
 * then walks the two-step server dance:
 *
 *   1. api.issueOutcomeToken({task_id, session_id})
 *      → server returns a 5-min single-use token
 *   2. api.submitOutcomeEvidence({token, hash, verifier_session_id, ...})
 *      → server consumes the token + validates hash + INSERTs
 *        outcome_evidence with verified_via='user_observed'
 *
 * Empty (sha256('')) and stale (hash reused from another task in the
 * last 24h) captures are rejected server-side with HTTP 422 — the
 * hook surfaces those as `status='failed'` + a specific error field
 * so the UI can show a targeted message.
 *
 * # verifier_session_id
 *
 * The DoD contract requires the *verifier* session to differ from
 * the *author* session (§2.4 condition 1). We generate a fresh
 * short-lived verifier session id per capture — clientside random
 * hex, prefixed `cyp_ui_<hex>`. The server accepts any non-authoring
 * session id here; the row-level CHECK on outcome_evidence enforces
 * that it differs from session_id.
 *
 * See:
 *   - ADR-040 §2.4, AC-U10
 *   - .planning/adr-040-commit-4.5-plan.md
 */

import { useCallback, useState } from 'react';
import { api } from '@/lib/api';

export type CaptureStatus =
  | 'idle'
  | 'reading'
  | 'ready'
  | 'posting'
  | 'succeeded'
  | 'failed';

export interface UseVerificationCaptureResult {
  captured: string;
  hash: string;
  status: CaptureStatus;
  error: string | null;
  evidenceId: string | null;
  captureFromClipboard: () => Promise<void>;
  captureFromPaste: (text: string) => Promise<void>;
  submit: (opts: {
    taskId: string;
    sessionId: string;
    verdict: 'pass' | 'fail';
    nonFixtureIdentifier: string;
  }) => Promise<boolean>;
  reset: () => void;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateVerifierSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'cyp_ui_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function useVerificationCapture(): UseVerificationCaptureResult {
  const [captured, setCaptured] = useState('');
  const [hash, setHash] = useState('');
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);

  const captureFromClipboard = useCallback(async () => {
    setStatus('reading');
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus('failed');
        setError('Clipboard is empty. Copy the verification output to your clipboard first.');
        return;
      }
      setCaptured(text);
      setHash(await sha256Hex(text));
      setStatus('ready');
    } catch (e) {
      setStatus('failed');
      setError(
        e instanceof Error
          ? `Clipboard read failed: ${e.message}. Try pasting into the textarea instead.`
          : 'Clipboard read failed',
      );
    }
  }, []);

  const captureFromPaste = useCallback(async (text: string) => {
    setError(null);
    if (!text.trim()) {
      setStatus('idle');
      setCaptured('');
      setHash('');
      return;
    }
    setCaptured(text);
    setHash(await sha256Hex(text));
    setStatus('ready');
  }, []);

  const submit = useCallback(
    async (opts: {
      taskId: string;
      sessionId: string;
      verdict: 'pass' | 'fail';
      nonFixtureIdentifier: string;
    }) => {
      if (!hash) {
        setStatus('failed');
        setError('Nothing captured yet.');
        return false;
      }
      setStatus('posting');
      setError(null);
      try {
        // Step 1: mint the token.
        const { token } = await api.issueOutcomeToken({
          task_id: opts.taskId,
          session_id: opts.sessionId,
        });
        // Step 2: submit the evidence with a fresh verifier session id.
        const verifier_session_id = generateVerifierSessionId();
        const { id } = await api.submitOutcomeEvidence({
          token,
          task_id: opts.taskId,
          session_id: opts.sessionId,
          verifier_session_id,
          verification_output_hash: hash,
          non_fixture_identifier: opts.nonFixtureIdentifier,
          verdict: opts.verdict,
          raw_payload: { captured_preview: captured.slice(0, 500) },
        });
        setEvidenceId(id);
        setStatus('succeeded');
        return true;
      } catch (e) {
        setStatus('failed');
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [hash, captured],
  );

  const reset = useCallback(() => {
    setCaptured('');
    setHash('');
    setStatus('idle');
    setError(null);
    setEvidenceId(null);
  }, []);

  return {
    captured, hash, status, error, evidenceId,
    captureFromClipboard, captureFromPaste, submit, reset,
  };
}
