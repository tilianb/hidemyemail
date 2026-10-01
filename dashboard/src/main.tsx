import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./auth";
import { queryClient } from "./queryClient";
import { ToastProvider } from "./ui";
import { App } from "./App";
import "@fontsource-variable/bricolage-grotesque/index.css";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
