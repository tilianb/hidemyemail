import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";

export type ToastKind = "success" | "error" | "info";
interface ToastItem { id: number; message: string; kind: ToastKind; exiting: boolean }

interface ToastCtx { toast: (message: string, kind?: ToastKind) => void }
const Ctx = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++counter.current;
    setItems(prev => [...prev, { id, message, kind, exiting: false }]);
    setTimeout(() => {
      setItems(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 200);
    }, 3200);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}${t.exiting ? " exiting" : ""}`}>
            <span className="toast-icon">
              {t.kind === "success" && <CheckCircle2 size={15} />}
              {t.kind === "error" && <AlertCircle size={15} />}
              {t.kind === "info" && <Info size={15} />}
            </span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
