import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={dialogRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-label={title}><div className="dialog-heading"><div><p className="section-kicker">{eyebrow}</p><h2>{title}</h2></div><button type="button" className="close-button" aria-label="关闭" onClick={onClose}>×</button></div>{children}</div></div>;
}
