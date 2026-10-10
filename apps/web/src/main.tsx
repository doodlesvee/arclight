import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AuthGate } from "@/components/AuthGate";
import { ErrorBoundary, ErrorFallback } from "@/components/ErrorBoundary";
import { AppearanceProvider } from "@/lib/appearance";
import { QueueProvider } from "@/lib/queue";
import { ToastProvider } from "@/lib/toast";
import "./index.css";
import { router } from "./router";

const queryClient = new QueryClient();

/**
 * Tears down the old service worker.
 *
 * The app used to register one to be installable; that's been removed. But a
 * worker already registered in a browser keeps serving its cached shell long
 * after the code that registered it is gone — which is why a stopped server
 * still "opened" in the browser. This unregisters any such worker and clears
 * its caches so the browser goes straight to the network again.
 */
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) void registration.unregister();
  });
  if ("caches" in window) {
    void caches.keys().then((keys) => {
      for (const key of keys) void caches.delete(key);
    });
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The last resort. The router has its own error component, which keeps
        the shell alive and is what a broken page hits; this one catches what
        it cannot — a provider or the shell itself failing — and so must not
        depend on any of them. */}
    <ErrorBoundary fallback={(props) => <ErrorFallback {...props} />}>
      <QueryClientProvider client={queryClient}>
        {/* Outside AuthGate so a failed sign-in can report itself too. */}
        <ToastProvider>
          <AuthGate>
            <AppearanceProvider>
              <QueueProvider>
                <RouterProvider router={router} />
              </QueueProvider>
            </AppearanceProvider>
          </AuthGate>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
