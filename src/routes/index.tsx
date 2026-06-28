import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@/components/ClientOnly";
import App from "@/App";

export const Route = createFileRoute("/")({
  component: () => (
    <ClientOnly>
      <App />
    </ClientOnly>
  ),
});