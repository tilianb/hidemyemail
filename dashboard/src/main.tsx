import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./auth";
import { ToastProvider } from "./ui";
import { App } from "./App";
import "@fontsource-variable/bricolage-grotesque/index.css";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>
);
