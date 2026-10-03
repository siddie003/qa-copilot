import { AppShell } from "@/components/layout/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { requirePageUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <ToastProvider>
      <AppShell user={{ name: user.name, email: user.email }}>{children}</AppShell>
    </ToastProvider>
  );
}
