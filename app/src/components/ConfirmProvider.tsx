import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AnchoredModal } from './AnchoredModal';
import { ensurePointerTracking } from '../lib/pointerAnchor';

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    ensurePointerTracking();
  }, []);

  const confirm = useCallback((opts: ConfirmOptions | string) => {
    const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  function finish(result: boolean) {
    if (!pending) return;
    pending.resolve(result);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && (
        <AnchoredModal onClose={() => finish(false)} className="users-modal confirm-modal" style={{ width: 360 }}>
          <div className="users-modal-header">
            <div className="users-modal-title">{pending.title || '确认操作'}</div>
          </div>
          <div className="users-modal-body">
            <p className="confirm-message">{pending.message}</p>
          </div>
          <div className="users-modal-footer">
            <button type="button" className="btn" onClick={() => finish(false)}>
              {pending.cancelLabel || '取消'}
            </button>
            <button
              type="button"
              className={`btn${pending.danger ? ' danger' : ' primary'}`}
              onClick={() => finish(true)}
            >
              {pending.confirmLabel || '确定'}
            </button>
          </div>
        </AnchoredModal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx.confirm;
}
