import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";

import App from "./App.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { ConnectionProvider } from "./context/ConnectionContext.jsx";
import { SystemStatusProvider } from "./context/SystemStatusContext.jsx";
import { HealthProvider } from "./context/HealthContext.jsx";
import { ErrorBoundary } from "./components/ui/ErrorBoundary.jsx";
import { AuthGate } from "./components/layout/AuthGate.jsx";

/**
 * Provider order is deliberate:
 *
 *   ToastProvider       outermost, so every layer below can report failures —
 *                       including the providers themselves
 *   ConnectionProvider  supplies the router token; must precede anything that
 *                       fetches
 *   SystemStatus        liveness + runtime identity for the header
 *   AuthGate            shows the API key page while the gateway answers 401,
 *                       so nothing below it polls (and 401s) before login
 *   HealthProvider      target health, deliberately *below* SystemStatus so a
 *                       10s health poll re-renders only health consumers
 *
 * The ErrorBoundary wraps the tree so a render fault in one page shows a
 * recoverable message instead of a blank screen.
 */
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ToastProvider>
      <ConnectionProvider>
        <SystemStatusProvider>
          <AuthGate>
            <HealthProvider>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </HealthProvider>
          </AuthGate>
        </SystemStatusProvider>
      </ConnectionProvider>
    </ToastProvider>
  </StrictMode>
);
