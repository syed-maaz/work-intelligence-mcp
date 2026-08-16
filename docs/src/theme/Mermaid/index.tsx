import React, {useState, useEffect, useRef} from 'react';
import Mermaid from '@theme-original/Mermaid';
import type {Props} from '@theme/Mermaid';

import styles from './styles.module.css';

// Wrap upstream <Mermaid> with a hover-revealed Fullscreen button.
// In fullscreen, the rendered SVG sits in a backdrop'd dialog the user
// can close with the [Close] button or the Escape key. Native browser
// zoom (⌘/Ctrl + + / -) and trackpad pinch work inside the dialog.
export default function MermaidWrapper(props: Props): JSX.Element {
  const [isOpen, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc to close + lock background scroll while open
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // When the dialog opens, copy the rendered SVG from the inline diagram
  // into the dialog. This way the wrapper doesn't need to know the mermaid
  // source — it just clones the upstream output.
  useEffect(() => {
    if (!isOpen || !wrapRef.current || !dialogRef.current) return;
    const inlineSvg = wrapRef.current.querySelector('svg');
    if (!inlineSvg) return;
    const clone = inlineSvg.cloneNode(true) as SVGElement;
    clone.removeAttribute('style');
    clone.setAttribute('width', '100%');
    clone.setAttribute('height', '100%');
    clone.style.maxWidth = '100%';
    clone.style.maxHeight = '100%';
    const stage = dialogRef.current.querySelector(`.${styles.stage}`);
    if (stage) {
      stage.innerHTML = '';
      stage.appendChild(clone);
    }
  }, [isOpen]);

  return (
    <div ref={wrapRef} className={styles.wrapper}>
      <Mermaid {...props} />
      <button
        type="button"
        className={styles.zoomButton}
        onClick={() => setOpen(true)}
        aria-label="Open diagram fullscreen">
        ⤢ Zoom
      </button>

      {isOpen && (
        <div
          ref={dialogRef}
          className={styles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Diagram fullscreen view"
          onClick={(e) => {
            if (e.target === dialogRef.current) setOpen(false);
          }}>
          <div className={styles.dialog}>
            <div className={styles.toolbar}>
              <span className={styles.hint}>
                ⌘/Ctrl + scroll to zoom · Esc to close
              </span>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setOpen(false)}
                aria-label="Close fullscreen">
                ✕ Close
              </button>
            </div>
            <div className={styles.stage} />
          </div>
        </div>
      )}
    </div>
  );
}
