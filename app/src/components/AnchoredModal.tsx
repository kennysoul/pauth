import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ensurePointerTracking, getLastPointer, pickAnchoredPosition } from '../lib/pointerAnchor';

type Point = { x: number; y: number };

type Props = {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function AnchoredModal({ onClose, children, className = '', style }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point | null>(null);

  useEffect(() => {
    ensurePointerTracking();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const place = () => {
      const anchor = getLastPointer();
      const rect = box.getBoundingClientRect();
      const next = pickAnchoredPosition(anchor, rect.width, rect.height);
      setPosition({ x: next.x, y: next.y });
    };

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  return (
    <div className="anchored-overlay" onClick={onClose}>
      <div
        ref={boxRef}
        className={className}
        style={{
          position: 'fixed',
          left: position?.x ?? -9999,
          top: position?.y ?? -9999,
          visibility: position ? 'visible' : 'hidden',
          ...style,
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
