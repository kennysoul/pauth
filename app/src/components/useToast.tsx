import { useCallback, useEffect, useRef, useState } from 'react';

export function useToast(durationMs = 3000) {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const showToast = useCallback(
    (msg: string) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setToast(msg);
      timerRef.current = window.setTimeout(() => setToast(null), durationMs);
    },
    [durationMs],
  );

  const toastEl = toast ? (
    <div className="toast" role="status">
      {toast}
    </div>
  ) : null;

  return { showToast, toastEl };
}
