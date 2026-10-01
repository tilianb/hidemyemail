import * as Dialog from "@radix-ui/react-dialog";
import { Fingerprint, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isFreshAuthRequired } from "../api";

type GuardResult<T> = { ok: true; value: T } | { ok: false };
type Options = { onError: (message: string) => void };

export interface FreshAuthController {
  open: boolean;
  loading: boolean;
  error: string;
  passphrase: string;
  code: string;
  mfa: boolean;
  hasPasskey: boolean;
  setPassphrase: (value: string) => void;
  setCode: (value: string) => void;
  guard: <T>(operation: () => Promise<T>, retry: () => Promise<void>) => Promise<GuardResult<T>>;
  cancel: () => void;
  submit: (event: React.FormEvent) => Promise<void>;
  submitPasskey: () => Promise<void>;
}

export function useFreshAuth({ onError }: Options): FreshAuthController {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const pending = useRef<(() => Promise<void>) | null>(null);
  const account = useRef<number | null>(null);
  const retrying = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; pending.current = null; };
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    pending.current = null;
    account.current = null;
    setOpen(false);
    setPassphrase("");
    setCode("");
    setError("");
  }, []);

  const guard = useCallback(async <T,>(operation: () => Promise<T>, retry: () => Promise<void>): Promise<GuardResult<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (caught) {
      if (!isFreshAuthRequired(caught) || pending.current || retrying.current) throw caught;
      const requestGeneration = generation.current;
      pending.current = retry;
      try {
        const [profile, status, passkeys] = await Promise.all([api.profile(), api.mfaStatus(), api.passkeyList()]);
        if (!mounted.current || requestGeneration !== generation.current || pending.current !== retry) return { ok: false };
        account.current = profile.id;
        setMfa(status.enabled);
        setHasPasskey(passkeys.length > 0);
        setPassphrase(""); setCode(""); setError(""); setOpen(true);
        return { ok: false };
      } catch (preparationError) {
        if (pending.current === retry) { pending.current = null; account.current = null; }
        throw preparationError;
      }
    }
  }, []);

  const finish = useCallback(async (requestGeneration: number) => {
    if (!mounted.current || generation.current !== requestGeneration) return;
    const retry = pending.current;
    const expectedAccount = account.current;
    if (!retry || expectedAccount === null || retrying.current) return;
    pending.current = null;
    account.current = null;
    retrying.current = true;
    setOpen(false); setPassphrase(""); setCode("");
    try {
      const profile = await api.profile();
      if (!mounted.current || generation.current !== requestGeneration) return;
      if (profile.id !== expectedAccount) {
        onError("The signed-in account changed. Please start the action again.");
        return;
      }
      await retry();
    } catch (caught: any) {
      onError(caught?.message || "The action could not be completed");
    } finally {
      retrying.current = false;
    }
  }, [onError]);

  const submit = useCallback(async (event: React.FormEvent) => {
    const requestGeneration = generation.current;
    event.preventDefault(); setLoading(true); setError("");
    try { await api.reauth(passphrase, mfa ? code.trim() : undefined); await finish(requestGeneration); }
    catch (caught: any) { setError(caught?.message || "Authentication failed"); }
    finally { if (mounted.current) setLoading(false); }
  }, [code, finish, mfa, passphrase]);

  const submitPasskey = useCallback(async () => {
    const requestGeneration = generation.current;
    setLoading(true); setError("");
    try {
      const options = await api.reauthPasskeyChallenge();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication({ optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      await api.reauthPasskeyComplete(response);
      await finish(requestGeneration);
    } catch (caught: any) {
      if (caught?.name !== "NotAllowedError") setError(caught?.message || "Passkey verification failed");
    } finally { if (mounted.current) setLoading(false); }
  }, [finish]);

  return { open, loading, error, passphrase, code, mfa, hasPasskey, setPassphrase, setCode, guard, cancel, submit, submitPasskey };
}

export function FreshAuthDialog({ controller, body }: { controller: FreshAuthController; body: string }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={controller.open} onOpenChange={open => { if (!open && !controller.loading) controller.cancel(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay">
      <Dialog.Content className="dialog" onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}>
        <Dialog.Title className="dialog-title">Confirm it’s you</Dialog.Title>
        <Dialog.Description className="dialog-body">{body}</Dialog.Description>
        <form onSubmit={controller.submit} className="security-form-stack">
          <div className="field field-tight"><label className="field-label" htmlFor="fresh-auth-passphrase">Passphrase</label><input id="fresh-auth-passphrase" className="input" type="password" autoComplete="current-password" value={controller.passphrase} onChange={e => controller.setPassphrase(e.target.value)} disabled={controller.loading} /></div>
          {controller.mfa && <div className="field field-tight"><label className="field-label" htmlFor="fresh-auth-code">Authentication or backup code</label><input id="fresh-auth-code" className="input" type="text" inputMode="text" autoComplete="one-time-code" value={controller.code} onChange={e => controller.setCode(e.target.value.replace(/\s/g, "").slice(0, 32))} placeholder="000000 or XXXX-XXXX-…" disabled={controller.loading} /></div>}
          {controller.error && <p className="form-error" role="alert">{controller.error}</p>}
          {controller.hasPasskey && <button type="button" className="btn btn-soft btn-center" onClick={controller.submitPasskey} disabled={controller.loading}><Fingerprint size={14} /> Use Passkey</button>}
          <div className="dialog-actions"><button type="button" className="btn btn-soft" onClick={controller.cancel} disabled={controller.loading}>Cancel</button><button type="submit" className="btn btn-primary" disabled={controller.loading || !controller.passphrase || (controller.mfa && !controller.code.trim())}>{controller.loading && <Loader2 size={14} className="spin" />} Confirm</button></div>
        </form>
      </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Portal>
  </Dialog.Root>;
}
