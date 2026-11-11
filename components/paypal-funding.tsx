"use client";

import Script from "next/script";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { captureBountyOrder, createBountyOrder, FundingError } from "@/lib/funding";

type Buttons = {
  render: (container: HTMLElement) => Promise<void>;
  close: () => Promise<void>;
};

type PayPal = {
  Buttons: (options: {
    fundingSource: string;
    style: { layout: string; label: string; height: number };
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }, actions: { restart: () => Promise<void> }) => Promise<void>;
    onCancel: () => void;
    onError: () => void;
  }) => Buttons;
};

const SdkContext = createContext({ ready: false, error: "", notifyFunded: () => {} });
const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim();

const subscribeToHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => false;

export function PayPalFundingProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notification, setNotification] = useState<{ message: string } | null>(null);
  const notifyFunded = useCallback(() => {
    setNotification({ message: "Your bounty is now open for contributions." });
  }, []);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => setNotification(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notification]);
  const params = new URLSearchParams({
    "client-id": clientId ?? "",
    components: "buttons",
    currency: "USD",
    intent: "capture",
  });

  return (
    <SdkContext.Provider value={{ ready, error, notifyFunded }}>
      {clientId && (
        <Script
          id="paypal-funding-sdk"
          src={`https://www.paypal.com/sdk/js?${params}`}
          onReady={() => setReady(true)}
          onError={() => setError("PayPal could not load. Check your connection and refresh the page.")}
        />
      )}
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="fixed right-4 top-5 z-50 w-[calc(100%-2rem)] max-w-sm">
        {notification && (
          <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-zinc-900 p-4 text-white shadow-xl shadow-black/15">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10">
              <Check size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Bounty funded</p>
              <p className="mt-1 text-sm leading-5 text-zinc-300">{notification.message}</p>
            </div>
            <button type="button" aria-label="Dismiss notification" onClick={() => setNotification(null)} className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </SdkContext.Provider>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof FundingError) {
    if (error.code === "CAPTURE_VERIFICATION_FAILED") {
      return "Payment could not be confirmed as completed. The bounty is still unfunded. Contact the maintainer before paying again.";
    }
    return `${error.message} (${error.code})`;
  }
  return "Payment could not be confirmed. Check your connection and retry confirmation before paying again.";
}

export function PayPalFundingButton({ bountyId, existingOrderId }: { bountyId: string; existingOrderId: string | null }) {
  const { ready: sdkReady, error: sdkLoadError, notifyFunded } = useContext(SdkContext);
  // The SDK can load before a streamed Suspense boundary hydrates. Its first
  // client render must still match the server's loading state in that case.
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientHydrationSnapshot,
    serverHydrationSnapshot,
  );
  const ready = hydrated && sdkReady;
  const sdkError = hydrated ? sdkLoadError : "";
  const container = useRef<HTMLDivElement>(null);
  const lastError = useRef("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [approvedOrder, setApprovedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [funded, setFunded] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!ready || !container.current) return;
    const paypal = (window as Window & { paypal?: PayPal }).paypal;
    if (!paypal) return;
    let active = true;

    const reportError = (cause: unknown) => {
      lastError.current = errorMessage(cause);
      if (active) { setError(lastError.current); setMessage(""); }
    };

    const buttons = paypal.Buttons({
      fundingSource: "paypal",
      style: { layout: "vertical", label: "pay", height: 45 },
      createOrder: async () => {
        lastError.current = "";
        setError("");
        setMessage("Opening sandbox checkout...");
        try {
          return await createBountyOrder(bountyId);
        } catch (cause) {
          if (cause instanceof FundingError && cause.code === "ORDER_ALREADY_COMPLETED" && existingOrderId) {
            setApprovedOrder(existingOrderId);
          }
          reportError(cause);
          throw cause;
        }
      },
      onApprove: async (data, actions) => {
        if (!active) return;
        setApprovedOrder(data.orderID);
        setBusy(true);
        setMessage("Confirming payment...");
        try {
          await captureBountyOrder(bountyId, data.orderID);
          if (active) {
            setFunded(true);
            setMessage("");
            notifyFunded();
            setError("");
            router.refresh();
          }
        } catch (cause) {
          if (cause instanceof FundingError && cause.paypalIssues.includes("INSTRUMENT_DECLINED")) {
            setApprovedOrder(null);
            setMessage("Payment method declined. Select another sandbox card in PayPal.");
            await actions.restart();
          } else {
            reportError(cause);
          }
        } finally {
          if (active) setBusy(false);
        }
      },
      onCancel: () => {
        if (active) { setMessage("Checkout cancelled. This bounty is still awaiting funding."); setError(""); }
      },
      onError: () => {
        if (active) {
          setMessage("");
          setError(lastError.current || "PayPal checkout could not finish. Please try again.");
        }
      },
    });

    void buttons.render(container.current).catch(reportError);
    return () => {
      active = false;
      void buttons.close().catch(() => {});
    };
  }, [ready, bountyId, existingOrderId, router, notifyFunded]);

  async function retryCapture() {
    if (!approvedOrder || busy) return;
    setBusy(true);
    setError("");
    setMessage("Confirming payment...");
    try {
      await captureBountyOrder(bountyId, approvedOrder);
      setFunded(true);
      setMessage("");
      notifyFunded();
      router.refresh();
    } catch (cause) {
      setMessage("");
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Fund this bounty" className="mt-6 max-w-sm border-t border-zinc-200 pt-4 dark:border-zinc-700">
      <h3 className="mb-2 font-semibold">Fund this bounty</h3>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Funding makes this bounty available. Contributor payment happens after their work is verified.
      </p>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">Sandbox checkout. Choose the sandbox Visa in PayPal.</p>
      {!clientId ? (
        <p role="alert">PayPal is not configured. Set NEXT_PUBLIC_PAYPAL_CLIENT_ID and restart the app.</p>
      ) : (
        <>
          {!ready && !sdkError && <p role="status">Loading PayPal...</p>}
          <div ref={container} hidden={funded || !!approvedOrder || busy || !!sdkError} />
          {approvedOrder && !funded && (
            <button type="button" disabled={busy} onClick={() => void retryCapture()} className="rounded-lg bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50">
              {busy ? "Confirming..." : "Retry payment confirmation"}
            </button>
          )}
        </>
      )}
      {(sdkError || error) && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{sdkError || error}</p>}
      <p role="status" aria-live="polite" className="mt-3 text-sm">{message}</p>
    </section>
  );
}
